/**
 * CLIProxyAPI handler for intercepted requests
 * Forwards Anthropic-format requests to CLIProxyAPI (OpenAI-compatible endpoint)
 */

import http from 'node:http';
import { PROXY_HOST, PROXY_PORT, PROXY_PATH, PROXY_API_KEY, TIMEOUT_STREAMING, TIMEOUT_NON_STREAMING } from '../config';
import { log, logError } from '../logger';
import { AnthropicRequest } from '../types';

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 10_000; // 10s fallback
const MAX_ERROR_BODY = 8 * 1024; // 8KB cap on error body buffering
const MAX_RESPONSE_BODY = 10 * 1024 * 1024; // 10MB cap on non-streaming response

/**
 * Parse retry delay from 429 error body
 * Looks for patterns like "reset after 46s" or "retry after 30s"
 */
function parseRetryDelay(body: string, retryAfterHeader?: string): number {
  // Prefer Retry-After header
  if (retryAfterHeader) {
    const secs = parseInt(retryAfterHeader);
    if (!isNaN(secs) && secs > 0) return secs * 1000;
  }

  // Parse from body: "reset after 46s", "retry after 30 seconds"
  const match = body.match(/(?:reset|retry)\s+after\s+(\d+)\s*s/i);
  if (match) return parseInt(match[1]) * 1000;

  return DEFAULT_RETRY_DELAY;
}

/**
 * Send a single request to CLIProxyAPI, returns a promise
 */
function doRequest(
  body: string,
  timeout: number
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; data: string }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path: PROXY_PATH,
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${PROXY_API_KEY}`,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      let dataLen = 0;
      res.on('data', (chunk) => {
        dataLen += chunk.length;
        if (dataLen > MAX_RESPONSE_BODY) {
          req.destroy(new Error(`Response body exceeds ${MAX_RESPONSE_BODY} bytes`));
          return;
        }
        data += chunk;
      });
      res.on('end', () => resolve({
        statusCode: res.statusCode || 0,
        headers: res.headers,
        data,
      }));
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Request timeout after ${timeout}ms`)));
    req.write(body);
    req.end();
  });
}

/**
 * Send request to CLIProxyAPI for streaming, pipe response directly
 */
function doStreamingRequest(
  body: string,
  timeout: number,
  onResponse: (res: http.IncomingMessage) => void,
  onError: (err: Error) => void
): http.ClientRequest {
  const options = {
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    path: PROXY_PATH,
    method: 'POST',
    timeout,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${PROXY_API_KEY}`,
    },
  };

  const req = http.request(options, onResponse);
  req.on('error', onError);
  req.on('timeout', () => req.destroy(new Error(`Request timeout after ${timeout}ms`)));
  req.write(body);
  req.end();

  return req;
}

/**
 * Send error response to client
 */
function sendError(
  res: http.ServerResponse,
  statusCode: number,
  errorType: string,
  message: string
): void {
  if (res.headersSent) return;

  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    type: 'error',
    error: { type: errorType, message },
  }));
}

/**
 * Handle streaming response from CLIProxyAPI with 429 retry
 */
export async function handleProxyStreaming(
  anthropicReq: AnthropicRequest,
  targetModel: string,
  clientRes: http.ServerResponse
): Promise<void> {
  const body = JSON.stringify({ ...anthropicReq, model: targetModel });

  // Track current upstream request so client disconnect aborts it.
  // Registered once outside the loop to prevent listener accumulation on retries.
  let activeReq: http.ClientRequest | null = null;
  clientRes.on('close', () => {
    if (activeReq && !activeReq.destroyed) activeReq.destroy();
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await new Promise<'piped' | 'retry' | 'error'>((resolve) => {
      const proxyReq = doStreamingRequest(
        body,
        TIMEOUT_STREAMING,
        (proxyRes) => {
          if (proxyRes.statusCode === 429) {
            // Collect body to parse retry delay (capped to prevent OOM)
            let errBody = '';
            let errBodyLen = 0;
            proxyRes.on('data', (chunk) => {
              errBodyLen += chunk.length;
              if (errBodyLen <= MAX_ERROR_BODY) errBody += chunk;
            });
            proxyRes.on('end', () => {
              const delay = parseRetryDelay(errBody, proxyRes.headers['retry-after'] as string);
              const delaySec = Math.round(delay / 1000);
              log(`[429] Rate limited. Retrying in ${delaySec}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
              setTimeout(() => resolve('retry'), delay);
            });
            return;
          }

          if (proxyRes.statusCode !== 200) {
            let errorData = '';
            proxyRes.on('data', (chunk) => (errorData += chunk));
            proxyRes.on('end', () => {
              logError(`[PROXY ${proxyRes.statusCode}] ${errorData.substring(0, 200)}`);
              sendError(clientRes, proxyRes.statusCode || 502, 'api_error', errorData.substring(0, 200));
              resolve('error');
            });
            return;
          }

          // Success — pipe streaming response with backpressure
          clientRes.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-cmm-provider': 'cliproxyapi',
          });

          proxyRes.setEncoding('utf-8');
          proxyRes.on('data', (chunk: string) => {
            if (!clientRes.writable) return;
            const canContinue = clientRes.write(chunk);
            if (!canContinue) {
              proxyRes.pause();
              clientRes.once('drain', () => proxyRes.resume());
            }
          });
          proxyRes.on('end', () => {
            if (clientRes.writable) clientRes.end();
          });
          proxyRes.on('error', (err) => {
            logError(`[STREAMING ERROR] ${err.message}`);
            if (clientRes.writable) clientRes.end();
          });

          resolve('piped');
        },
        (err) => {
          logError(`[PROXY REQUEST] ${err.message}`);
          sendError(clientRes, 502, 'api_error', err.message);
          resolve('error');
        }
      );

      activeReq = proxyReq;
    });

    if (result !== 'retry') return;
  }

  // All retries exhausted
  logError(`[429] All ${MAX_RETRIES} retries exhausted`);
  sendError(clientRes, 429, 'rate_limit_error', 'Rate limit exceeded after retries');
}

/**
 * Handle non-streaming response from CLIProxyAPI with 429 retry
 */
export async function handleProxyNonStreaming(
  anthropicReq: AnthropicRequest,
  targetModel: string,
  clientRes: http.ServerResponse
): Promise<void> {
  const body = JSON.stringify({ ...anthropicReq, model: targetModel });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await doRequest(body, TIMEOUT_NON_STREAMING);

    if (res.statusCode === 429) {
      if (attempt >= MAX_RETRIES) break;

      const delay = parseRetryDelay(res.data, res.headers['retry-after'] as string);
      const delaySec = Math.round(delay / 1000);
      log(`[429] Rate limited. Retrying in ${delaySec}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (res.statusCode !== 200) {
      logError(`[PROXY ${res.statusCode}] ${res.data.substring(0, 200)}`);
      sendError(clientRes, res.statusCode || 502, 'api_error', res.data.substring(0, 200));
      return;
    }

    try {
      const response = JSON.parse(res.data);
      clientRes.writeHead(200, {
        'content-type': 'application/json',
        'x-cmm-provider': 'cliproxyapi',
      });
      clientRes.end(JSON.stringify(response));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[PARSE ERROR] ${msg}`);
      sendError(clientRes, 502, 'api_error', msg);
    }
    return;
  }

  // All retries exhausted
  logError(`[429] All ${MAX_RETRIES} retries exhausted`);
  sendError(clientRes, 429, 'rate_limit_error', 'Rate limit exceeded after retries');
}
