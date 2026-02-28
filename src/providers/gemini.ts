/**
 * Gemini provider via CLIProxyAPI
 * Delegates all requests to http://localhost:8317 (OpenAI-compatible)
 */

import http from 'node:http';
import { logError } from '../logger';
import { AnthropicRequest } from '../translator/messages';

const PROXY_HOST = 'localhost';
const PROXY_PORT = 8317;
const API_KEY = 'sk-iuKiKWCkUlahcoE6X';

export async function handleGeminiStreaming(
  anthropicReq: AnthropicRequest,
  targetModel: string,
  clientRes: http.ServerResponse
): Promise<void> {
  try {
    // CLIProxyAPI expects OpenAI format with model override
    const proxyBody = {
      ...anthropicReq,
      model: targetModel,
    };

    const bodyStr = JSON.stringify(proxyBody);

    const proxyReq = http.request(
      {
        hostname: PROXY_HOST,
        port: PROXY_PORT,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          Authorization: `Bearer ${API_KEY}`,
        },
      },
      (proxyRes) => {
        if (proxyRes.statusCode !== 200) {
          let errorData = '';
          proxyRes.on('data', (chunk: any) => (errorData += chunk));
          proxyRes.on('end', () => {
            logError(`[PROXY ERROR] ${proxyRes.statusCode}: ${errorData.substring(0, 200)}`);
            sendError(clientRes, proxyRes.statusCode || 502, 'api_error', errorData.substring(0, 200));
          });
          return;
        }

        clientRes.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-cmm-provider': 'cliproxyapi',
        });

        proxyRes.setEncoding('utf-8');
        proxyRes.on('data', (chunk: string) => {
          if (clientRes.writable) {
            clientRes.write(chunk);
          }
        });

        proxyRes.on('end', () => {
          if (clientRes.writable) {
            clientRes.end();
          }
        });

        proxyRes.on('error', (err: any) => {
          logError(`[STREAMING ERROR] ${err.message}`);
          if (clientRes.writable) clientRes.end();
        });
      }
    );

    proxyReq.on('error', (err: any) => {
      logError(`[PROXY REQUEST ERROR] ${err.message}`);
      sendError(clientRes, 502, 'api_error', err.message);
    });

    proxyReq.write(bodyStr);
    proxyReq.end();
  } catch (err: any) {
    logError(`[STREAMING ERROR] ${err.message}`);
    sendError(clientRes, 502, 'api_error', err.message);
  }
}

export async function handleGeminiNonStreaming(
  anthropicReq: AnthropicRequest,
  targetModel: string,
  clientRes: http.ServerResponse
): Promise<void> {
  try {
    // CLIProxyAPI expects OpenAI format with model override
    const proxyBody = {
      ...anthropicReq,
      model: targetModel,
    };

    const bodyStr = JSON.stringify(proxyBody);

    const proxyReq = http.request(
      {
        hostname: PROXY_HOST,
        port: PROXY_PORT,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          Authorization: `Bearer ${API_KEY}`,
        },
      },
      (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk: any) => (data += chunk));
        proxyRes.on('end', () => {
          try {
            if (proxyRes.statusCode !== 200) {
              logError(`[PROXY ERROR] ${proxyRes.statusCode}: ${data.substring(0, 200)}`);
              sendError(clientRes, proxyRes.statusCode || 502, 'api_error', data.substring(0, 200));
              return;
            }

            const response = JSON.parse(data);

            clientRes.writeHead(200, {
              'content-type': 'application/json',
              'x-cmm-provider': 'cliproxyapi',
            });
            clientRes.end(JSON.stringify(response));
          } catch (err: any) {
            logError(`[PARSE ERROR] ${err.message}`);
            sendError(clientRes, 502, 'api_error', err.message);
          }
        });
      }
    );

    proxyReq.on('error', (err: any) => {
      logError(`[PROXY REQUEST ERROR] ${err.message}`);
      sendError(clientRes, 502, 'api_error', err.message);
    });

    proxyReq.write(bodyStr);
    proxyReq.end();
  } catch (err: any) {
    logError(`[NON-STREAMING ERROR] ${err.message}`);
    sendError(clientRes, 502, 'api_error', err.message);
  }
}

function sendError(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string
): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json' });
  }
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}
