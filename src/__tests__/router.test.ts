import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { createRouter } from '../router';

// Mock the providers
vi.mock('../providers/anthropic', () => ({
  forwardToAnthropic: vi.fn(),
}));

vi.mock('../providers/proxy', () => ({
  handleProxyStreaming: vi.fn().mockResolvedValue(undefined),
  handleProxyNonStreaming: vi.fn().mockResolvedValue(undefined),
}));

import { forwardToAnthropic } from '../providers/anthropic';
import { handleProxyStreaming, handleProxyNonStreaming } from '../providers/proxy';

function createMockReq(method: string, url: string, body: any): IncomingMessage {
  const bodyStr = JSON.stringify(body);
  const readable = new Readable();
  readable.push(bodyStr);
  readable.push(null);

  Object.assign(readable, {
    method,
    url,
    headers: { 'content-type': 'application/json' },
  });

  return readable as unknown as IncomingMessage;
}

function createMockRes(): ServerResponse {
  const writable = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  Object.assign(writable, {
    writeHead: vi.fn(),
    headersSent: false,
  });

  return writable as unknown as ServerResponse;
}

describe('createRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should intercept matching model for streaming request', async () => {
    const router = createRouter({
      sourceModel: 'claude-haiku-4-5',
      targetModel: 'gemini-2.5-flash',
    });

    const req = createMockReq('POST', '/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const res = createMockRes();
    router(req, res);

    // Wait for body to be read
    await new Promise((r) => setTimeout(r, 10));

    expect(handleProxyStreaming).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001', stream: true }),
      'gemini-2.5-flash',
      res
    );
    expect(forwardToAnthropic).not.toHaveBeenCalled();
  });

  it('should intercept matching model for non-streaming request', async () => {
    const router = createRouter({
      sourceModel: 'claude-haiku-4-5',
      targetModel: 'gemini-2.5-flash',
    });

    const req = createMockReq('POST', '/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      stream: false,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const res = createMockRes();
    router(req, res);

    await new Promise((r) => setTimeout(r, 10));

    expect(handleProxyNonStreaming).toHaveBeenCalled();
    expect(forwardToAnthropic).not.toHaveBeenCalled();
  });

  it('should passthrough non-matching model', async () => {
    const router = createRouter({
      sourceModel: 'claude-haiku-4-5',
      targetModel: 'gemini-2.5-flash',
    });

    const req = createMockReq('POST', '/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const res = createMockRes();
    router(req, res);

    await new Promise((r) => setTimeout(r, 10));

    expect(forwardToAnthropic).toHaveBeenCalled();
    expect(handleProxyStreaming).not.toHaveBeenCalled();
    expect(handleProxyNonStreaming).not.toHaveBeenCalled();
  });

  it('should intercept when URL has query params like ?beta=true', async () => {
    const router = createRouter({
      sourceModel: 'claude-haiku-4-5',
      targetModel: 'gemini-2.5-flash',
    });

    const req = createMockReq('POST', '/v1/messages?beta=true', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const res = createMockRes();
    router(req, res);

    await new Promise((r) => setTimeout(r, 10));

    expect(handleProxyStreaming).toHaveBeenCalled();
    expect(forwardToAnthropic).not.toHaveBeenCalled();
  });

  it('should passthrough non-messages endpoints', async () => {
    const router = createRouter({
      sourceModel: 'claude-haiku-4-5',
      targetModel: 'gemini-2.5-flash',
    });

    const req = createMockReq('GET', '/v1/models', {});
    const res = createMockRes();
    router(req, res);

    await new Promise((r) => setTimeout(r, 10));

    expect(forwardToAnthropic).toHaveBeenCalled();
  });

  it('should passthrough on JSON parse error', async () => {
    const router = createRouter({
      sourceModel: 'claude-haiku-4-5',
      targetModel: 'gemini-2.5-flash',
    });

    // Create a request with invalid JSON
    const readable = new Readable();
    readable.push('not valid json{{{');
    readable.push(null);
    Object.assign(readable, {
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' },
    });

    const res = createMockRes();
    router(readable as unknown as IncomingMessage, res);

    await new Promise((r) => setTimeout(r, 10));

    expect(forwardToAnthropic).toHaveBeenCalled();
  });

  it('should use prefix matching for model names', async () => {
    const router = createRouter({
      sourceModel: 'claude-haiku',
      targetModel: 'gemini-2.5-flash',
    });

    const req = createMockReq('POST', '/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const res = createMockRes();
    router(req, res);

    await new Promise((r) => setTimeout(r, 10));

    expect(handleProxyStreaming).toHaveBeenCalled();
  });

  it('should not match partial non-prefix model names', async () => {
    const router = createRouter({
      sourceModel: 'claude-opus',
      targetModel: 'gemini-2.5-flash',
    });

    const req = createMockReq('POST', '/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const res = createMockRes();
    router(req, res);

    await new Promise((r) => setTimeout(r, 10));

    expect(forwardToAnthropic).toHaveBeenCalled();
    expect(handleProxyStreaming).not.toHaveBeenCalled();
  });
});
