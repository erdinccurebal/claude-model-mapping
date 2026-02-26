/**
 * Model-based request router
 * Routes intercepted models to Gemini, everything else to real Anthropic
 */

import http from 'node:http';
import { MappingConfig } from './config';
import { forwardToAnthropic } from './providers/anthropic';
import { handleGeminiStreaming, handleGeminiNonStreaming } from './providers/gemini';
import { AnthropicRequest } from './translator/messages';
import { log } from './logger';

export function createRouter(mapping: MappingConfig) {
  return function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const bodyChunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));

    req.on('end', () => {
      const rawBody = Buffer.concat(bodyChunks);

      // Only intercept POST /v1/messages (ignore query params like ?beta=true)
      const urlPath = req.url?.split('?')[0];
      if (req.method === 'POST' && urlPath === '/v1/messages') {
        try {
          const body: AnthropicRequest = JSON.parse(rawBody.toString());
          const model = body.model || '';

          // Check if model matches the source pattern (prefix match)
          if (model.startsWith(mapping.sourceModel)) {
            log(`${model.padEnd(35)} → INTERCEPTED → ${mapping.targetModel} ✓`);
            if (body.stream) {
              handleGeminiStreaming(body, mapping.targetModel, res);
            } else {
              handleGeminiNonStreaming(body, mapping.targetModel, res);
            }
            return;
          }

          // Passthrough
          log(`${model.padEnd(35)} → PASSTHROUGH ✓`);
        } catch {
          // JSON parse failed — passthrough anyway
          log(`(parse error) → PASSTHROUGH`);
        }
      } else {
        // Non-messages endpoint — always passthrough
        log(`${req.method} ${req.url} → PASSTHROUGH`);
      }

      forwardToAnthropic(req.method || 'GET', req.url || '/', req.headers, rawBody, res);
    });

    req.on('error', (err) => {
      console.error(`[REQUEST ERROR] ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: err.message },
        })
      );
    });
  };
}
