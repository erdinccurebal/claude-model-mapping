/**
 * Model-based request router
 * Routes intercepted models to CLIProxyAPI, everything else to real Anthropic
 */

import http from 'node:http';
import { MappingConfig } from './config';
import { forwardToAnthropic } from './providers/anthropic';
import { handleProxyStreaming, handleProxyNonStreaming } from './providers/proxy';
import { AnthropicRequest, AnthropicContentBlock } from './types';
import { log, logError } from './logger';

const CONTENT_PREVIEW_LEN = 200;

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

export function createRouter(mapping: MappingConfig) {
  return function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const bodyChunks: Buffer[] = [];
    let bodySize = 0;

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        if (!res.headersSent) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'Request body too large' },
          }));
        }
        req.destroy();
        return;
      }
      bodyChunks.push(chunk);
    });

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
            const sizeKB = (rawBody.length / 1024).toFixed(1);
            const msgCount = body.messages?.length || 0;
            const toolCount = body.tools?.length || 0;
            log(`${model.padEnd(35)} → INTERCEPTED → ${mapping.targetModel} (${sizeKB}KB, ${msgCount}msg, ${toolCount}tools) ✓`);
            logRequestContent(body);
            const handler = body.stream
              ? handleProxyStreaming(body, mapping.targetModel, res)
              : handleProxyNonStreaming(body, mapping.targetModel, res);
            handler.catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              logError(`[PROXY HANDLER] ${msg}`);
              if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'application/json' });
              }
              if (res.writable) {
                res.end(JSON.stringify({
                  type: 'error',
                  error: { type: 'api_error', message: msg },
                }));
              }
            });
            return;
          }

          // Passthrough — send as-is; on thinking signature error, retry without thinking blocks
          log(`${model.padEnd(35)} → PASSTHROUGH ✓`);
          forwardToAnthropic(req.method || 'GET', req.url || '/', req.headers, rawBody, res, () => {
            log(`${model.padEnd(35)} → PASSTHROUGH (retry without thinking blocks)`);
            return stripThinkingBlocks(body);
          });
          return;
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

/**
 * Strip thinking blocks from assistant messages in conversation history.
 * Prevents "Invalid signature in thinking block" errors when conversations
 * cross provider boundaries (CLIProxyAPI ↔ real Anthropic API).
 */
function stripThinkingBlocks(body: AnthropicRequest): Buffer {
  const cleaned = {
    ...body,
    messages: body.messages?.map(msg => {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
      const filtered = (msg.content as AnthropicContentBlock[]).filter(
        block => block.type !== 'thinking'
      );
      if (filtered.length === 0) return msg;
      return { ...msg, content: filtered };
    }),
  };
  return Buffer.from(JSON.stringify(cleaned));
}

function extractText(content: string | AnthropicContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'tool_use') parts.push(`[tool_use: ${block.name}]`);
    else if (block.type === 'tool_result') parts.push(`[tool_result: ${block.tool_use_id}]`);
    else if (block.type === 'thinking') parts.push('[thinking]');
    else if (block.type === 'image') parts.push('[image]');
    else parts.push(`[${block.type}]`);
  }
  return parts.join(' ');
}

function truncate(str: string, len: number): string {
  const oneLine = str.replace(/\n/g, '\\n');
  return oneLine.length > len ? oneLine.slice(0, len) + '...' : oneLine;
}

function logRequestContent(body: AnthropicRequest): void {
  const pad = '  ';

  // System prompt
  if (body.system) {
    const text = extractText(body.system);
    if (text) log(`${pad}system: ${truncate(text, CONTENT_PREVIEW_LEN)}`);
  }

  // Last user message
  if (body.messages?.length) {
    const last = body.messages[body.messages.length - 1];
    const text = extractText(last.content);
    if (text) log(`${pad}last [${last.role}]: ${truncate(text, CONTENT_PREVIEW_LEN)}`);
  }

  // Thinking budget
  if (body.thinking?.budget_tokens) {
    log(`${pad}thinking: budget=${body.thinking.budget_tokens}`);
  }
}
