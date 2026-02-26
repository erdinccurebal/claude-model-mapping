import { describe, it, expect } from 'vitest';
import { StreamTranslator, SSEParser } from './streaming';

// ─── Helper to parse SSE events from string array ───
function parseSSEEvents(events: string[]): Array<{ event: string; data: any }> {
  return events.map((e) => {
    const lines = e.trim().split('\n');
    const eventLine = lines.find((l) => l.startsWith('event: '));
    const dataLine = lines.find((l) => l.startsWith('data: '));
    return {
      event: eventLine ? eventLine.substring(7) : '',
      data: dataLine ? JSON.parse(dataLine.substring(6)) : null,
    };
  });
}

describe('StreamTranslator', () => {
  // ─── Basic text streaming ───

  it('should emit message_start and ping on first chunk', () => {
    const translator = new StreamTranslator('claude-haiku-4-5-20251001');

    const events = translator.processChunk({
      candidates: [
        {
          content: { parts: [{ text: 'Hello' }], role: 'model' },
        },
      ],
    });

    const parsed = parseSSEEvents(events);
    expect(parsed[0].event).toBe('message_start');
    expect(parsed[0].data.type).toBe('message_start');
    expect(parsed[0].data.message.model).toBe('claude-haiku-4-5-20251001');
    expect(parsed[0].data.message.role).toBe('assistant');
    expect(parsed[1].event).toBe('ping');
  });

  it('should emit content_block_start and content_block_delta for text', () => {
    const translator = new StreamTranslator('test-model');

    const events = translator.processChunk({
      candidates: [
        {
          content: { parts: [{ text: 'Hello' }], role: 'model' },
        },
      ],
    });

    const parsed = parseSSEEvents(events);
    // message_start, ping, content_block_start, content_block_delta
    expect(parsed[2].event).toBe('content_block_start');
    expect(parsed[2].data.content_block.type).toBe('text');
    expect(parsed[2].data.index).toBe(0);

    expect(parsed[3].event).toBe('content_block_delta');
    expect(parsed[3].data.delta.type).toBe('text_delta');
    expect(parsed[3].data.delta.text).toBe('Hello');
  });

  it('should emit multiple text deltas for multiple chunks', () => {
    const translator = new StreamTranslator('test-model');

    translator.processChunk({
      candidates: [{ content: { parts: [{ text: 'Hello' }], role: 'model' } }],
    });

    const events2 = translator.processChunk({
      candidates: [{ content: { parts: [{ text: ' world' }], role: 'model' } }],
    });

    const parsed = parseSSEEvents(events2);
    // Only delta — no new content_block_start since block is still active
    expect(parsed.length).toBe(1);
    expect(parsed[0].event).toBe('content_block_delta');
    expect(parsed[0].data.delta.text).toBe(' world');
    expect(parsed[0].data.index).toBe(0);
  });

  it('should emit finish events on finishReason', () => {
    const translator = new StreamTranslator('test-model');

    translator.processChunk({
      candidates: [{ content: { parts: [{ text: 'Hi' }], role: 'model' } }],
    });

    const events = translator.processChunk({
      candidates: [
        {
          content: { parts: [{ text: '!' }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    });

    const parsed = parseSSEEvents(events);
    const eventTypes = parsed.map((e) => e.event);

    expect(eventTypes).toContain('content_block_stop');
    expect(eventTypes).toContain('message_delta');
    expect(eventTypes).toContain('message_stop');

    const messageDelta = parsed.find((e) => e.event === 'message_delta');
    expect(messageDelta?.data.delta.stop_reason).toBe('end_turn');
    expect(messageDelta?.data.usage.output_tokens).toBe(5);
  });

  // ─── Function call streaming ───

  it('should emit tool_use events for functionCall', () => {
    const translator = new StreamTranslator('test-model');

    const events = translator.processChunk({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'get_weather', args: { location: 'NYC' } } },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });

    const parsed = parseSSEEvents(events);
    const eventTypes = parsed.map((e) => e.event);

    expect(eventTypes).toContain('content_block_start');
    expect(eventTypes).toContain('content_block_delta');
    expect(eventTypes).toContain('content_block_stop');

    const blockStart = parsed.find(
      (e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use'
    );
    expect(blockStart?.data.content_block.name).toBe('get_weather');
    expect(blockStart?.data.content_block.id).toMatch(/^toolu_cmm_/);
    expect(blockStart?.data.content_block.input).toEqual({});

    const inputDelta = parsed.find(
      (e) => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta'
    );
    expect(inputDelta?.data.delta.partial_json).toBe('{"location":"NYC"}');

    const messageDelta = parsed.find((e) => e.event === 'message_delta');
    expect(messageDelta?.data.delta.stop_reason).toBe('tool_use');
  });

  it('should handle text followed by function call', () => {
    const translator = new StreamTranslator('test-model');

    // First chunk: text
    translator.processChunk({
      candidates: [
        { content: { parts: [{ text: 'Let me check that.' }], role: 'model' } },
      ],
    });

    // Second chunk: function call
    const events = translator.processChunk({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'read_file', args: { path: '/tmp/x' } } }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });

    const parsed = parseSSEEvents(events);
    const eventTypes = parsed.map((e) => e.event);

    // Should close text block, open tool_use block
    expect(eventTypes).toContain('content_block_stop'); // close text block
    expect(eventTypes).toContain('content_block_start'); // open tool_use block
  });

  // ─── Thinking streaming ───

  it('should emit thinking events for thought parts', () => {
    const translator = new StreamTranslator('test-model');

    const events = translator.processChunk({
      candidates: [
        {
          content: {
            parts: [{ text: 'Let me think...', thought: true }],
            role: 'model',
          },
        },
      ],
    });

    const parsed = parseSSEEvents(events);

    const blockStart = parsed.find(
      (e) => e.event === 'content_block_start' && e.data.content_block?.type === 'thinking'
    );
    expect(blockStart).toBeDefined();

    const thinkingDelta = parsed.find(
      (e) => e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta'
    );
    expect(thinkingDelta?.data.delta.thinking).toBe('Let me think...');
  });

  it('should transition from thinking to text', () => {
    const translator = new StreamTranslator('test-model');

    // Thinking chunk
    translator.processChunk({
      candidates: [
        {
          content: { parts: [{ text: 'Thinking...', thought: true }], role: 'model' },
        },
      ],
    });

    // Text chunk
    const events = translator.processChunk({
      candidates: [
        {
          content: { parts: [{ text: 'The answer is 42.' }], role: 'model' },
        },
      ],
    });

    const parsed = parseSSEEvents(events);
    const eventTypes = parsed.map((e) => e.event);

    // Should close thinking block and start text block
    expect(eventTypes).toContain('content_block_stop');
    expect(eventTypes).toContain('content_block_start');
    expect(eventTypes).toContain('content_block_delta');

    const textDelta = parsed.find(
      (e) => e.data?.delta?.type === 'text_delta'
    );
    expect(textDelta?.data.delta.text).toBe('The answer is 42.');
  });

  // ─── Usage metadata ───

  it('should track usage metadata from any chunk', () => {
    const translator = new StreamTranslator('test-model');

    translator.processChunk({
      candidates: [{ content: { parts: [{ text: 'Hi' }], role: 'model' } }],
      usageMetadata: { promptTokenCount: 25 },
    });

    const events = translator.processChunk({
      candidates: [
        {
          content: { parts: [{ text: '!' }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 10 },
    });

    const parsed = parseSSEEvents(events);
    const messageDelta = parsed.find((e) => e.event === 'message_delta');
    expect(messageDelta?.data.usage.output_tokens).toBe(10);
  });

  // ─── Error handling ───

  it('should handle error chunks', () => {
    const translator = new StreamTranslator('test-model');

    const events = translator.processChunk({
      error: { code: 500, message: 'Internal error' },
    });

    const parsed = parseSSEEvents(events);
    expect(parsed[0].event).toBe('error');
    expect(parsed[0].data.error.message).toContain('Internal error');
  });

  // ─── Empty/edge cases ───

  it('should handle empty candidates', () => {
    const translator = new StreamTranslator('test-model');

    const events = translator.processChunk({ candidates: [] });

    const parsed = parseSSEEvents(events);
    // Only message_start and ping
    expect(parsed.length).toBe(2);
    expect(parsed[0].event).toBe('message_start');
    expect(parsed[1].event).toBe('ping');
  });

  it('should skip empty text parts', () => {
    const translator = new StreamTranslator('test-model');

    const events = translator.processChunk({
      candidates: [
        { content: { parts: [{ text: '' }], role: 'model' } },
      ],
    });

    const parsed = parseSSEEvents(events);
    // Only message_start and ping — no content block events
    expect(parsed.length).toBe(2);
  });

  it('should handle multiple function calls in one chunk', () => {
    const translator = new StreamTranslator('test-model');

    const events = translator.processChunk({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'tool_a', args: { x: 1 } } },
              { functionCall: { name: 'tool_b', args: { y: 2 } } },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });

    const parsed = parseSSEEvents(events);

    // Should have two tool_use blocks with different indices
    const toolStarts = parsed.filter(
      (e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use'
    );
    expect(toolStarts.length).toBe(2);
    expect(toolStarts[0].data.content_block.name).toBe('tool_a');
    expect(toolStarts[1].data.content_block.name).toBe('tool_b');
    expect(toolStarts[0].data.index).not.toBe(toolStarts[1].data.index);
  });
});

describe('SSEParser', () => {
  it('should parse a single SSE event', () => {
    const parser = new SSEParser();

    const events = parser.feed('data: {"text":"hello"}\n\n');

    expect(events).toEqual([{ text: 'hello' }]);
  });

  it('should parse multiple SSE events', () => {
    const parser = new SSEParser();

    const events = parser.feed(
      'data: {"a":1}\n\ndata: {"b":2}\n\n'
    );

    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('should buffer incomplete events', () => {
    const parser = new SSEParser();

    // First chunk: incomplete
    const events1 = parser.feed('data: {"text":"hel');
    expect(events1).toEqual([]);

    // Second chunk: completes the event
    const events2 = parser.feed('lo"}\n\n');
    expect(events2).toEqual([{ text: 'hello' }]);
  });

  it('should handle chunks split across events', () => {
    const parser = new SSEParser();

    const events1 = parser.feed('data: {"a":1}\n\ndata: {"b":');
    expect(events1).toEqual([{ a: 1 }]);

    const events2 = parser.feed('2}\n\n');
    expect(events2).toEqual([{ b: 2 }]);
  });

  it('should flush remaining buffer', () => {
    const parser = new SSEParser();

    // Feed data without trailing double newline
    parser.feed('data: {"final":true}');

    // Nothing emitted yet
    const events = parser.flush();
    expect(events).toEqual([{ final: true }]);
  });

  it('should skip malformed JSON', () => {
    const parser = new SSEParser();

    const events = parser.feed('data: {invalid json}\n\n');
    expect(events).toEqual([]);
  });

  it('should handle empty input', () => {
    const parser = new SSEParser();

    const events = parser.feed('');
    expect(events).toEqual([]);
  });

  it('should ignore non-data lines', () => {
    const parser = new SSEParser();

    const events = parser.feed('event: update\nid: 123\ndata: {"ok":true}\n\n');
    expect(events).toEqual([{ ok: true }]);
  });

  it('should flush empty buffer without errors', () => {
    const parser = new SSEParser();
    const events = parser.flush();
    expect(events).toEqual([]);
  });
});
