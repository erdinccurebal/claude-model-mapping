/**
 * Gemini provider via CLIProxyAPI
 * Delegates all requests to http://localhost:8317
 */

import http from 'node:http';
import https from 'node:https';
import { log, logError } from '../logger';
import { AnthropicRequest, anthropicToGemini } from '../translator/messages';
import { StreamTranslator, SSEParser } from '../translator/streaming';
import { generateMessageId } from '../translator/tools';

const PROXY_HOST = 'localhost';
const PROXY_PORT = 8317;
const API_KEY = 'sk-iuKiKWCkUlahcoE6X';

export async function handleGeminiStreaming(
  anthropicReq: AnthropicRequest,
  targetModel: string,
  clientRes: http.ServerResponse
): Promise<void> {
  try {
    const geminiReq = anthropicToGemini(anthropicReq);

    const proxyReq = http.request(
      {
        hostname: PROXY_HOST,
        port: PROXY_PORT,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
          'X-Model': targetModel,
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

        const translator = new StreamTranslator(anthropicReq.model);
        const sseParser = new SSEParser();

        proxyRes.setEncoding('utf-8');
        proxyRes.on('data', (chunk: string) => {
          if (!clientRes.writable) return;
          const events = sseParser.feed(chunk);
          for (const event of events) {
            const anthropicEvents = translator.processChunk(event);
            for (const anthropicEvent of anthropicEvents) {
              clientRes.write(anthropicEvent);
            }
          }
        });

        proxyRes.on('end', () => {
          if (!clientRes.writable) return;
          const remaining = sseParser.flush();
          for (const event of remaining) {
            const anthropicEvents = translator.processChunk(event);
            for (const anthropicEvent of anthropicEvents) {
              clientRes.write(anthropicEvent);
            }
          }
          clientRes.end();
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

    proxyReq.write(JSON.stringify(geminiReq));
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
    const geminiReq = anthropicToGemini(anthropicReq);

    const proxyReq = http.request(
      {
        hostname: PROXY_HOST,
        port: PROXY_PORT,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
          'X-Model': targetModel,
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

            const geminiResponse = JSON.parse(data);
            const anthropicResponse = convertGeminiToAnthropicResponse(geminiResponse, anthropicReq.model);

            clientRes.writeHead(200, {
              'content-type': 'application/json',
              'x-cmm-provider': 'cliproxyapi',
            });
            clientRes.end(JSON.stringify(anthropicResponse));
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

    proxyReq.write(JSON.stringify(geminiReq));
    proxyReq.end();
  } catch (err: any) {
    logError(`[NON-STREAMING ERROR] ${err.message}`);
    sendError(clientRes, 502, 'api_error', err.message);
  }
}

function convertGeminiToAnthropicResponse(geminiRes: any, fakeModel: string): any {
  const content: any[] = [];
  let hasFunctionCall = false;
  const candidate = geminiRes.candidates?.[0];

  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      if (part.functionCall) {
        hasFunctionCall = true;
        content.push({
          type: 'tool_use',
          id: 'toolu_cmm_' + Math.random().toString(36).substring(2, 15),
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        });
      } else if (part.text) {
        content.push({ type: 'text', text: part.text });
      }
    }
  }

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    model: fakeModel,
    stop_reason: hasFunctionCall ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: geminiRes.usageMetadata?.promptTokenCount || 0,
      output_tokens: geminiRes.usageMetadata?.candidatesTokenCount || 0,
    },
  };
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
