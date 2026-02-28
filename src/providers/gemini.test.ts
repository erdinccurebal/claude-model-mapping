import { describe, it, expect } from 'vitest';

// We test the pure functions that don't require network access.

// Import what we can test directly
import { anthropicToGemini } from '../translator/messages';
import { StreamTranslator, SSEParser } from '../translator/streaming';

describe('Gemini Provider - Response Conversion (via StreamTranslator)', () => {
  it('should convert a complete Gemini response with text to Anthropic SSE format', () => {
    const translator = new StreamTranslator('claude-haiku-4-5-20251001');

    // Simulate a Code Assist response (after unwrapping)
    const events = translator.processChunk({
      candidates: [
        {
          content: {
            parts: [{ text: 'Hello, world!' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
      },
    });

    // Parse SSE events
    const parsed = events.map((e) => {
      const lines = e.trim().split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      return {
        event: eventLine?.substring(7) || '',
        data: dataLine ? JSON.parse(dataLine.substring(6)) : null,
      };
    });

    const eventTypes = parsed.map((e) => e.event);

    // Verify full event sequence
    expect(eventTypes).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    // Verify message_start
    expect(parsed[0].data.message.model).toBe('claude-haiku-4-5-20251001');
    expect(parsed[0].data.message.role).toBe('assistant');
    expect(parsed[0].data.message.id).toMatch(/^msg_cmm_/);

    // Verify text content
    expect(parsed[3].data.delta.text).toBe('Hello, world!');

    // Verify stop reason and usage
    expect(parsed[5].data.delta.stop_reason).toBe('end_turn');
    expect(parsed[5].data.usage.output_tokens).toBe(3);
  });

  it('should convert a Gemini tool call response to Anthropic format', () => {
    const translator = new StreamTranslator('claude-haiku-4-5-20251001');

    const events = translator.processChunk({
      candidates: [
        {
          content: {
            parts: [
              { text: "I'll read that file." },
              {
                functionCall: {
                  name: 'Read',
                  args: { file_path: '/tmp/test.txt' },
                },
              },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });

    const parsed = events.map((e) => {
      const lines = e.trim().split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      return {
        event: eventLine?.substring(7) || '',
        data: dataLine ? JSON.parse(dataLine.substring(6)) : null,
      };
    });

    // Find tool_use block start
    const toolStart = parsed.find(
      (e) => e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use'
    );
    expect(toolStart).toBeDefined();
    expect(toolStart!.data.content_block.name).toBe('Read');
    expect(toolStart!.data.content_block.id).toMatch(/^toolu_cmm_/);

    // Find input delta
    const inputDelta = parsed.find(
      (e) => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta'
    );
    expect(inputDelta).toBeDefined();
    expect(JSON.parse(inputDelta!.data.delta.partial_json)).toEqual({
      file_path: '/tmp/test.txt',
    });

    // Stop reason should be tool_use
    const messageDelta = parsed.find((e) => e.event === 'message_delta');
    expect(messageDelta!.data.delta.stop_reason).toBe('tool_use');
  });
});

describe('Gemini Provider - Full Round Trip', () => {
  it('should handle a tool use conversation round trip', () => {
    // Step 1: User asks to read a file
    const req1 = anthropicToGemini({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Read /tmp/test.txt' }],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
      ],
    });

    expect(req1.contents.length).toBe(1);
    expect(req1.tools).toBeDefined();

    // Step 2: Gemini responds with function call (simulated)
    // Step 3: User sends tool result
    const req2 = anthropicToGemini({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Read /tmp/test.txt' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'll read that file." },
            {
              type: 'tool_use',
              id: 'toolu_cmm_abc123',
              name: 'Read',
              input: { file_path: '/tmp/test.txt' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_cmm_abc123',
              content: 'Hello World!',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
      ],
    });

    // Verify conversion
    expect(req2.contents.length).toBe(3);

    // First message: user text
    expect(req2.contents[0].role).toBe('user');
    expect(req2.contents[0].parts[0].text).toBe('Read /tmp/test.txt');

    // Second message: model with text + function call
    expect(req2.contents[1].role).toBe('model');
    expect(req2.contents[1].parts[0].text).toBe("I'll read that file.");
    expect(req2.contents[1].parts[1].functionCall).toEqual({
      name: 'Read',
      args: { file_path: '/tmp/test.txt' },
    });

    // Third message: user with function response
    expect(req2.contents[2].role).toBe('user');
    expect(req2.contents[2].parts[0].functionResponse).toEqual({
      name: 'Read',
      response: { result: 'Hello World!' },
    });
  });

  it('should handle thinking + text + tool use round trip', () => {
    const req = anthropicToGemini({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Analyze this.' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
            { type: 'text', text: "I'll analyze it." },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Analyze',
              input: { target: 'data' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Analysis complete' },
          ],
        },
      ],
      tools: [
        {
          name: 'Analyze',
          input_schema: { type: 'object', properties: { target: { type: 'string' } } },
        },
      ],
      thinking: { type: 'enabled', budget_tokens: 5000 },
    });

    // Model message should have thinking + text + functionCall
    expect(req.contents[1].role).toBe('model');
    expect(req.contents[1].parts.length).toBe(3);
    expect(req.contents[1].parts[0]).toEqual({ text: 'Let me think about this...', thought: true });
    expect(req.contents[1].parts[1]).toEqual({ text: "I'll analyze it." });
    expect(req.contents[1].parts[2].functionCall?.name).toBe('Analyze');

    // Tool result message
    expect(req.contents[2].parts[0].functionResponse?.name).toBe('Analyze');

    // Thinking config should be set
    expect(req.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 5000 });
  });
});

describe('Gemini Provider - SSE Pipeline', () => {
  it('should parse Code Assist wrapped SSE and translate to Anthropic format', () => {
    const parser = new SSEParser();
    const translator = new StreamTranslator('claude-haiku-4-5-20251001');

    // Simulate raw SSE from Code Assist (wrapped response)
    const rawSSE =
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}},"traceId":"abc123"}\n\n';

    const chunks = parser.feed(rawSSE);
    expect(chunks.length).toBe(1);

    // Unwrap Code Assist response
    const unwrapped = chunks[0].response || chunks[0];

    const events = translator.processChunk(unwrapped);
    const parsed = events.map((e) => {
      const lines = e.trim().split('\n');
      const eventLine = lines.find((l: string) => l.startsWith('event: '));
      const dataLine = lines.find((l: string) => l.startsWith('data: '));
      return {
        event: eventLine?.substring(7) || '',
        data: dataLine ? JSON.parse(dataLine.substring(6)) : null,
      };
    });

    const eventTypes = parsed.map((e) => e.event);
    expect(eventTypes).toContain('message_start');
    expect(eventTypes).toContain('content_block_delta');
    expect(eventTypes).toContain('message_stop');

    const textDelta = parsed.find(
      (e) => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta'
    );
    expect(textDelta?.data.delta.text).toBe('Hello');
  });

  it('should handle multi-chunk streaming SSE', () => {
    const parser = new SSEParser();
    const translator = new StreamTranslator('test-model');

    // Chunk 1: partial text
    const chunk1 =
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}]}}\n\n';
    const parsed1 = parser.feed(chunk1);
    expect(parsed1.length).toBe(1);

    const events1 = translator.processChunk(parsed1[0].response);
    expect(events1.length).toBeGreaterThan(0); // message_start, ping, block_start, delta

    // Chunk 2: more text + finish
    const chunk2 =
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":" world!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3}}}\n\n';
    const parsed2 = parser.feed(chunk2);
    expect(parsed2.length).toBe(1);

    const events2 = translator.processChunk(parsed2[0].response);

    const allEvents = events2.map((e) => {
      const lines = e.trim().split('\n');
      const eventLine = lines.find((l: string) => l.startsWith('event: '));
      return eventLine?.substring(7) || '';
    });

    expect(allEvents).toContain('content_block_delta');
    expect(allEvents).toContain('content_block_stop');
    expect(allEvents).toContain('message_delta');
    expect(allEvents).toContain('message_stop');
  });
});
