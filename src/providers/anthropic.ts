/**
 * Passthrough to real api.anthropic.com using cached IP
 */

import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import { getCachedIP, resolveAnthropicIP } from '../dns';
import { ANTHROPIC_HOST, TIMEOUT_PASSTHROUGH } from '../config';
import { logError } from '../logger';

const THINKING_SIGNATURE_ERROR = 'Invalid `signature` in `thinking` block';

/** Decompress a response body based on content-encoding header */
function decompressBody(buf: Buffer, encoding?: string): string {
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      return zlib.gunzipSync(buf).toString('utf-8');
    }
    if (encoding === 'br') {
      return zlib.brotliDecompressSync(buf).toString('utf-8');
    }
    if (encoding === 'deflate') {
      return zlib.inflateSync(buf).toString('utf-8');
    }
  } catch {}
  return buf.toString('utf-8');
}

let realIP: string | null = null;

export async function initAnthropicIP(): Promise<string> {
  realIP = await resolveAnthropicIP();
  return realIP;
}

export function getRealIP(): string {
  if (!realIP) {
    realIP = getCachedIP();
  }
  return realIP;
}

/**
 * Forward a request to the real Anthropic API (passthrough, no modification).
 *
 * If `getRetryBody` is provided and the API returns a 400 with a thinking
 * signature error, the request is retried once with the cleaned body.
 */
export function forwardToAnthropic(
  method: string,
  path: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  clientRes: http.ServerResponse,
  getRetryBody?: () => Buffer,
): void {
  sendUpstream(method, path, headers, body, clientRes, getRetryBody);
}

function sendUpstream(
  method: string,
  path: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  clientRes: http.ServerResponse,
  getRetryBody?: () => Buffer,
): void {
  const ip = getRealIP();

  // Build headers for the upstream request
  const upstreamHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    // Skip hop-by-hop headers
    if (['host', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) continue;
    upstreamHeaders[key] = value as string;
  }
  upstreamHeaders['host'] = ANTHROPIC_HOST;
  upstreamHeaders['content-length'] = String(body.length);

  const options: https.RequestOptions = {
    hostname: ip,
    port: 443,
    path: path,
    method: method,
    headers: upstreamHeaders,
    servername: ANTHROPIC_HOST, // TLS SNI
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Forward status and headers
    const resHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value) resHeaders[key] = value;
    }

    // On 400 with a retry callback available: buffer the raw body and check
    // for thinking signature error before forwarding to the client.
    if (proxyRes.statusCode === 400 && getRetryBody) {
      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      proxyRes.on('end', () => {
        const rawErrBody = Buffer.concat(chunks);
        // Decompress if needed to check error text
        const errText = decompressBody(rawErrBody, proxyRes.headers['content-encoding'] as string);
        if (errText.includes(THINKING_SIGNATURE_ERROR)) {
          // Retry once with cleaned body (no getRetryBody → no further retries)
          sendUpstream(method, path, headers, getRetryBody(), clientRes);
        } else {
          // Not a signature error — forward the original 400 raw bytes as-is
          clientRes.writeHead(400, resHeaders);
          clientRes.end(rawErrBody);
        }
      });
      proxyRes.on('error', (err) => {
        logError(`[PASSTHROUGH UPSTREAM] ${err.message}`);
        if (clientRes.writable) clientRes.end();
      });
      return;
    }

    clientRes.writeHead(proxyRes.statusCode || 502, resHeaders);

    proxyRes.on('error', (err) => {
      logError(`[PASSTHROUGH UPSTREAM] ${err.message}`);
      if (clientRes.writable) clientRes.end();
    });

    proxyRes.pipe(clientRes);
  });

  // Abort upstream request if client disconnects
  clientRes.on('close', () => {
    if (!proxyReq.destroyed) proxyReq.destroy();
  });

  proxyReq.setTimeout(TIMEOUT_PASSTHROUGH, () => {
    proxyReq.destroy(new Error(`Upstream request timeout (${TIMEOUT_PASSTHROUGH / 1000}s)`));
  });

  proxyReq.on('error', (err) => {
    logError(`[PASSTHROUGH] ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
    }
    clientRes.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `Proxy error: ${err.message}` },
      })
    );
  });

  proxyReq.write(body);
  proxyReq.end();
}
