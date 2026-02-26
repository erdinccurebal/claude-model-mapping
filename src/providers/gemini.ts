/**
 * Gemini provider via Google Code Assist API
 * Uses the same endpoint and auth as Gemini CLI (cloudcode-pa.googleapis.com)
 */

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { logError } from '../logger';
import {
  CODE_ASSIST_HOST,
  CODE_ASSIST_API_VERSION,
  GEMINI_OAUTH_CREDS_PATH,
  GEMINI_CLIENT_ID,
  GEMINI_CLIENT_SECRET,
  TIMEOUT_STREAMING,
  TIMEOUT_NON_STREAMING,
} from '../config';
import { AnthropicRequest, anthropicToGemini } from '../translator/messages';
import { StreamTranslator, SSEParser } from '../translator/streaming';
import { generateMessageId } from '../translator/tools';

interface OAuthCreds {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}

let cachedToken: { accessToken: string; expiryDate: number } | null = null;
let cachedProjectId: string | undefined;

// ─── OAuth Token Management ───

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiryDate > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const creds: OAuthCreds = JSON.parse(fs.readFileSync(GEMINI_OAUTH_CREDS_PATH, 'utf-8'));

  if (creds.expiry_date > Date.now() + 60_000) {
    cachedToken = { accessToken: creds.access_token, expiryDate: creds.expiry_date };
    return creds.access_token;
  }

  const refreshed = await refreshToken(creds.refresh_token);
  const newExpiryDate = Date.now() + refreshed.expires_in * 1000;
  cachedToken = {
    accessToken: refreshed.access_token,
    expiryDate: newExpiryDate,
  };

  // Persist updated token to disk so restarts don't need to refresh again
  try {
    creds.access_token = refreshed.access_token;
    creds.expiry_date = newExpiryDate;
    fs.writeFileSync(GEMINI_OAUTH_CREDS_PATH, JSON.stringify(creds, null, 2));
  } catch {
    // Non-fatal: token is cached in memory
  }

  return refreshed.access_token;
}

function refreshToken(
  refreshTokenValue: string
): Promise<{ access_token: string; expires_in: number }> {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      refresh_token: refreshTokenValue,
      grant_type: 'refresh_token',
    }).toString();

    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(`OAuth refresh failed: ${json.error} — ${json.error_description}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new Error(`OAuth refresh parse error: ${data}`));
          }
        });
      }
    );
    req.setTimeout(10_000, () => {
      req.destroy(new Error('OAuth refresh request timeout (10s)'));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── Code Assist Setup ───

function codeAssistRequest(
  method: string,
  body: any,
  accessToken: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = `/${CODE_ASSIST_API_VERSION}:${method}`;
    const bodyStr = JSON.stringify(body);

    const req = https.request(
      {
        hostname: CODE_ASSIST_HOST,
        path: url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          Authorization: `Bearer ${accessToken}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(
                new Error(
                  `Code Assist ${method} failed (${res.statusCode}): ${JSON.stringify(json.error || json)}`
                )
              );
            } else {
              resolve(json);
            }
          } catch {
            reject(new Error(`Code Assist ${method} parse error: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

export async function initCodeAssist(): Promise<string | undefined> {
  const accessToken = await getAccessToken();
  const envProjectId =
    process.env['GOOGLE_CLOUD_PROJECT'] ||
    process.env['GOOGLE_CLOUD_PROJECT_ID'] ||
    undefined;

  try {
    // Step 1: Check if user is already onboarded
    const loadRes = await codeAssistRequest('loadCodeAssist', {
      cloudaicompanionProject: envProjectId,
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }, accessToken);

    if (loadRes.currentTier && loadRes.cloudaicompanionProject) {
      // Already onboarded
      cachedProjectId = loadRes.cloudaicompanionProject;
      console.log(`   Tier: ${loadRes.currentTier.name}`);
      console.log(`   Project: ${cachedProjectId}`);
      return cachedProjectId;
    }

    // Step 2: Need to onboard — find the default tier
    const defaultTier = loadRes.allowedTiers?.find((t: any) => t.isDefault);
    const tierId = defaultTier?.id || 'standard-tier';
    console.log(`   Onboarding to tier: ${defaultTier?.name || tierId}...`);

    const onboardRes = await codeAssistRequest('onboardUser', {
      tierId,
      cloudaicompanionProject: envProjectId,
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }, accessToken);

    // Handle LRO (long-running operation)
    let result = onboardRes;
    if (result.name && !result.done) {
      console.log(`   Onboarding in progress...`);
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        result = await codeAssistGetOperation(result.name, accessToken);
        if (result.done) break;
      }
    }

    cachedProjectId =
      result.response?.cloudaicompanionProject?.id ||
      envProjectId;

    if (cachedProjectId) {
      console.log(`   Project: ${cachedProjectId} ✓`);
    }
    return cachedProjectId;
  } catch (err: any) {
    console.warn(`   ⚠ Code Assist setup: ${err.message}`);
    cachedProjectId = envProjectId;
    return envProjectId;
  }
}

function codeAssistGetOperation(name: string, accessToken: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: CODE_ASSIST_HOST,
        path: `/${CODE_ASSIST_API_VERSION}/${name}`,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Request Handling ───

function buildCodeAssistRequest(geminiReq: any, model: string): any {
  return {
    model,
    project: cachedProjectId,
    user_prompt_id: crypto.randomUUID(),
    request: {
      contents: geminiReq.contents,
      systemInstruction: geminiReq.systemInstruction,
      tools: geminiReq.tools,
      toolConfig: geminiReq.toolConfig,
      generationConfig: geminiReq.generationConfig,
    },
  };
}

/**
 * Unwrap Code Assist streaming response to standard Gemini format
 */
function unwrapCodeAssistResponse(data: any): any {
  if (data.response) {
    return data.response;
  }
  return data;
}

export async function handleGeminiStreaming(
  anthropicReq: AnthropicRequest,
  targetModel: string,
  clientRes: http.ServerResponse,
  _retryCount = 0
): Promise<void> {
  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err: any) {
    logError(`[GEMINI AUTH ERROR] ${err.message}`);
    sendError(clientRes, 500, 'authentication_error', err.message);
    return;
  }

  const geminiReq = anthropicToGemini(anthropicReq);
  const codeAssistReq = buildCodeAssistRequest(geminiReq, targetModel);
  const bodyStr = JSON.stringify(codeAssistReq);
  const apiPath = `/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`;

  const options: https.RequestOptions = {
    hostname: CODE_ASSIST_HOST,
    port: 443,
    path: apiPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      Authorization: `Bearer ${accessToken}`,
    },
  };

  const translator = new StreamTranslator(anthropicReq.model);
  const sseParser = new SSEParser();

  const geminiHttpReq = https.request(options, (geminiRes) => {
    if (geminiRes.statusCode !== 200) {
      let errorData = '';
      geminiRes.on('data', (chunk) => (errorData += chunk));
      geminiRes.on('end', () => {
        logError(`[GEMINI API ERROR] ${geminiRes.statusCode}: ${errorData}`);

        if (geminiRes.statusCode === 401 && _retryCount < 1) {
          cachedToken = null;
          retryStreaming(anthropicReq, targetModel, clientRes, _retryCount);
          return;
        }

        sendError(
          clientRes,
          502,
          'api_error',
          `Code Assist API returned ${geminiRes.statusCode}: ${errorData}`
        );
      });
      return;
    }

    clientRes.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-cmm-provider': 'gemini',
    });

    geminiRes.setEncoding('utf-8');
    geminiRes.on('data', (chunk: string) => {
      if (!clientRes.writable) return;
      const codeAssistChunks = sseParser.feed(chunk);
      for (const rawChunk of codeAssistChunks) {
        const geminiChunk = unwrapCodeAssistResponse(rawChunk);
        const anthropicEvents = translator.processChunk(geminiChunk);
        for (const event of anthropicEvents) {
          clientRes.write(event);
        }
      }
    });

    geminiRes.on('end', () => {
      if (!clientRes.writable) return;
      // Flush any remaining buffered SSE data
      const remaining = sseParser.flush();
      for (const rawChunk of remaining) {
        const geminiChunk = unwrapCodeAssistResponse(rawChunk);
        const anthropicEvents = translator.processChunk(geminiChunk);
        for (const event of anthropicEvents) {
          clientRes.write(event);
        }
      }
      clientRes.end();
    });

    geminiRes.on('error', (err) => {
      logError(`[GEMINI STREAM ERROR] ${err.message}`);
      if (clientRes.writable) clientRes.end();
    });
  });

  geminiHttpReq.setTimeout(TIMEOUT_STREAMING, () => {
    geminiHttpReq.destroy(new Error(`Gemini streaming request timeout (${TIMEOUT_STREAMING / 1000}s)`));
  });

  geminiHttpReq.on('error', (err) => {
    logError(`[GEMINI REQUEST ERROR] ${err.message}`);
    sendError(clientRes, 502, 'api_error', `Connection error: ${err.message}`);
  });

  geminiHttpReq.write(bodyStr);
  geminiHttpReq.end();
}

async function retryStreaming(
  anthropicReq: AnthropicRequest,
  targetModel: string,
  clientRes: http.ServerResponse,
  retryCount: number
): Promise<void> {
  try {
    const creds: OAuthCreds = JSON.parse(fs.readFileSync(GEMINI_OAUTH_CREDS_PATH, 'utf-8'));
    const refreshed = await refreshToken(creds.refresh_token);
    cachedToken = {
      accessToken: refreshed.access_token,
      expiryDate: Date.now() + refreshed.expires_in * 1000,
    };
    await handleGeminiStreaming(anthropicReq, targetModel, clientRes, retryCount + 1);
  } catch (err: any) {
    logError(`[GEMINI RETRY FAILED] ${err.message}`);
    sendError(clientRes, 502, 'authentication_error', `Token refresh failed: ${err.message}`);
  }
}

export async function handleGeminiNonStreaming(
  anthropicReq: AnthropicRequest,
  targetModel: string,
  clientRes: http.ServerResponse,
  _retryCount = 0
): Promise<void> {
  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err: any) {
    logError(`[GEMINI AUTH ERROR] ${err.message}`);
    sendError(clientRes, 500, 'authentication_error', err.message);
    return;
  }

  const geminiReq = anthropicToGemini(anthropicReq);
  const codeAssistReq = buildCodeAssistRequest(geminiReq, targetModel);
  const bodyStr = JSON.stringify(codeAssistReq);
  const apiPath = `/${CODE_ASSIST_API_VERSION}:generateContent`;

  const options: https.RequestOptions = {
    hostname: CODE_ASSIST_HOST,
    port: 443,
    path: apiPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      Authorization: `Bearer ${accessToken}`,
    },
  };

  const geminiHttpReq = https.request(options, (geminiRes) => {
    let data = '';
    geminiRes.on('data', (chunk) => (data += chunk));
    geminiRes.on('end', async () => {
      if (geminiRes.statusCode === 401 && _retryCount < 1) {
        // Token expired — refresh and retry once
        cachedToken = null;
        try {
          const creds: OAuthCreds = JSON.parse(fs.readFileSync(GEMINI_OAUTH_CREDS_PATH, 'utf-8'));
          const refreshed = await refreshToken(creds.refresh_token);
          cachedToken = {
            accessToken: refreshed.access_token,
            expiryDate: Date.now() + refreshed.expires_in * 1000,
          };
          await handleGeminiNonStreaming(anthropicReq, targetModel, clientRes, _retryCount + 1);
        } catch (err: any) {
          logError(`[GEMINI RETRY FAILED] ${err.message}`);
          sendError(clientRes, 502, 'authentication_error', `Token refresh failed: ${err.message}`);
        }
        return;
      }

      if (geminiRes.statusCode !== 200) {
        logError(`[GEMINI API ERROR] ${geminiRes.statusCode}: ${data.substring(0, 500)}`);
        sendError(
          clientRes,
          502,
          'api_error',
          `Code Assist API error (${geminiRes.statusCode}): ${data.substring(0, 500)}`
        );
        return;
      }

      try {
        const rawResponse = JSON.parse(data);
        const geminiResponse = unwrapCodeAssistResponse(rawResponse);
        const anthropicResponse = convertGeminiToAnthropicResponse(
          geminiResponse,
          anthropicReq.model
        );
        clientRes.writeHead(200, {
          'content-type': 'application/json',
          'x-cmm-provider': 'gemini',
        });
        clientRes.end(JSON.stringify(anthropicResponse));
      } catch (err: any) {
        sendError(clientRes, 502, 'api_error', `Response parse error: ${err.message}`);
      }
    });
  });

  geminiHttpReq.setTimeout(TIMEOUT_NON_STREAMING, () => {
    geminiHttpReq.destroy(new Error(`Gemini non-streaming request timeout (${TIMEOUT_NON_STREAMING / 1000}s)`));
  });

  geminiHttpReq.on('error', (err) => {
    logError(`[GEMINI REQUEST ERROR] ${err.message}`);
    sendError(clientRes, 502, 'api_error', err.message);
  });

  geminiHttpReq.write(bodyStr);
  geminiHttpReq.end();
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
          id: 'toolu_cmm_' + crypto.randomBytes(12).toString('base64url'),
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        });
      } else if (part.thought && part.text) {
        const signature = crypto.randomBytes(64).toString('base64');
        content.push({ type: 'thinking', thinking: part.text, signature });
      } else if (part.text !== undefined) {
        content.push({ type: 'text', text: part.text });
      }
    }
  }

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
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
