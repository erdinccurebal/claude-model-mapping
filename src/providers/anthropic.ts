/**
 * Passthrough to real api.anthropic.com using cached IP
 */

import https from 'node:https';
import http from 'node:http';
import { getCachedIP, resolveAnthropicIP } from '../dns';
import { ANTHROPIC_HOST } from '../config';

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
 * Forward a request to the real Anthropic API (passthrough, no modification)
 */
export function forwardToAnthropic(
  method: string,
  path: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  clientRes: http.ServerResponse
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

    clientRes.writeHead(proxyRes.statusCode || 502, resHeaders);
    proxyRes.pipe(clientRes);
  });

  proxyReq.setTimeout(120_000, () => {
    proxyReq.destroy(new Error('Upstream request timeout (120s)'));
  });

  proxyReq.on('error', (err) => {
    console.error(`[PASSTHROUGH ERROR] ${err.message}`);
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
