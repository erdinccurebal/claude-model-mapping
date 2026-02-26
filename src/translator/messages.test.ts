import { describe, it, expect } from 'vitest';
import { anthropicToGemini, AnthropicRequest } from './messages';

describe('anthropicToGemini', () => {
  // ─── Basic text messages ───

  it('should convert simple text message', () => {
    const req: AnthropicRequest = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const result = anthropicToGemini(req);

    expect(result.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
    ]);
  });

  it('should convert string content to text part', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    };

    const result = anthropicToGemini(req);

    expect(result.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there' }] },
    ]);
  });

  it('should convert array content blocks', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First part' },
            { type: 'text', text: 'Second part' },
          ],
        },
      ],
    };

    const result = anthropicToGemini(req);

    expect(result.contents[0].parts).toEqual([
      { text: 'First part' },
      { text: 'Second part' },
    ]);
  });

  it('should map assistant role to model role', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ],
    };

    const result = anthropicToGemini(req);

    expect(result.contents[1].role).toBe('model');
  });

  // ─── Role merging ───

  it('should merge consecutive same-role messages', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'Message 1' },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' }],
        },
      ],
    };

    const result = anthropicToGemini(req);

    // Should be merged into a single user content
    expect(result.contents.length).toBe(1);
    expect(result.contents[0].role).toBe('user');
    expect(result.contents[0].parts.length).toBe(2);
  });

  // ─── System instruction ───

  it('should convert string system to systemInstruction', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      system: 'You are helpful.',
    };

    const result = anthropicToGemini(req);

    expect(result.systemInstruction).toEqual({
      parts: [{ text: 'You are helpful.' }],
    });
  });

  it('should convert array system to systemInstruction', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      system: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
    };

    const result = anthropicToGemini(req);

    expect(result.systemInstruction).toEqual({
      parts: [{ text: 'Part 1' }, { text: 'Part 2' }],
    });
  });

  // ─── Tool use ───

  it('should convert tool_use to functionCall', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'Read the file' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_123',
              name: 'Read',
              input: { file_path: '/tmp/test.txt' },
            },
          ],
        },
      ],
    };

    const result = anthropicToGemini(req);

    expect(result.contents[1].role).toBe('model');
    expect(result.contents[1].parts[0]).toEqual({
      functionCall: {
        name: 'Read',
        args: { file_path: '/tmp/test.txt' },
      },
    });
  });

  it('should convert tool_result to functionResponse with correct name', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'Read the file' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_123',
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
              tool_use_id: 'toolu_123',
              content: 'File contents here',
            },
          ],
        },
      ],
    };

    const result = anthropicToGemini(req);

    // The tool_result should reference the tool name "Read"
    const toolResultPart = result.contents[2].parts[0];
    expect(toolResultPart.functionResponse).toEqual({
      name: 'Read',
      response: { result: 'File contents here' },
    });
  });

  it('should handle tool_result with array content', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'text', text: 'file1.txt' },
                { type: 'text', text: 'file2.txt' },
              ],
            },
          ],
        },
      ],
    };

    const result = anthropicToGemini(req);

    const responsePart = result.contents[1].parts[0];
    expect(responsePart.functionResponse?.response.result).toBe('file1.txt\nfile2.txt');
  });

  it('should handle missing tool_use_id mapping gracefully', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'unknown_id', content: 'result' },
          ],
        },
      ],
    };

    const result = anthropicToGemini(req);

    expect(result.contents[0].parts[0].functionResponse?.name).toBe('unknown_tool');
  });

  // ─── Thinking blocks ───

  it('should convert thinking blocks to thought-tagged parts', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' },
            { type: 'text', text: 'Here is the answer.' },
          ],
        },
      ],
    };

    const result = anthropicToGemini(req);

    expect(result.contents[0].parts[0]).toEqual({
      text: 'Let me think about this...',
      thought: true,
    });
    expect(result.contents[0].parts[1]).toEqual({
      text: 'Here is the answer.',
    });
  });

  // ─── Image content ───

  it('should convert base64 image content', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgo=',
              },
            },
          ],
        },
      ],
    };

    const result = anthropicToGemini(req);

    expect(result.contents[0].parts[0]).toEqual({
      inlineData: {
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
      },
    });
  });

  // ─── Tool declarations ───

  it('should convert tool definitions to functionDeclarations', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get the weather',
          input_schema: {
            type: 'object',
            properties: {
              location: { type: 'string' },
            },
            required: ['location'],
          },
        },
      ],
    };

    const result = anthropicToGemini(req);

    expect(result.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get the weather',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' },
              },
              required: ['location'],
            },
          },
        ],
      },
    ]);
  });

  it('should clean unsupported schema fields (whitelist approach)', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          name: 'test_tool',
          input_schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              age: { type: 'number', exclusiveMinimum: 0 },
              tags: { type: 'object', propertyNames: { type: 'string' } },
            },
            additionalProperties: false,
            $schema: 'http://json-schema.org/draft-07/schema#',
          },
        },
      ],
    };

    const result = anthropicToGemini(req);

    const params = result.tools![0].functionDeclarations[0].parameters;
    expect(params.additionalProperties).toBeUndefined();
    expect(params.$schema).toBeUndefined();
    expect(params.properties.age.exclusiveMinimum).toBeUndefined();
    expect(params.properties.tags.propertyNames).toBeUndefined();
    expect(params.type).toBe('object');
    expect(params.properties.name.type).toBe('string');
  });

  // ─── Tool choice ───

  it('should convert tool_choice type "any" to ANY mode', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ name: 'test', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    };

    const result = anthropicToGemini(req);

    expect(result.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY' },
    });
  });

  it('should convert tool_choice type "tool" with specific name', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ name: 'get_time', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'get_time' },
    };

    const result = anthropicToGemini(req);

    expect(result.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_time'] },
    });
  });

  it('should convert tool_choice type "auto" to AUTO mode', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ name: 'test', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
    };

    const result = anthropicToGemini(req);

    expect(result.toolConfig).toEqual({
      functionCallingConfig: { mode: 'AUTO' },
    });
  });

  // ─── Generation config ───

  it('should convert generation parameters', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['END'],
    };

    const result = anthropicToGemini(req);

    expect(result.generationConfig).toEqual({
      maxOutputTokens: 4096,
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      stopSequences: ['END'],
    });
  });

  it('should convert thinking config', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 8096,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'enabled', budget_tokens: 10000 },
    };

    const result = anthropicToGemini(req);

    expect(result.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 10000,
    });
  });

  // ─── Edge cases ───

  it('should handle empty messages array', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [],
    };

    const result = anthropicToGemini(req);

    expect(result.contents).toEqual([]);
  });

  it('should skip empty text blocks', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: 'Hello' },
          ],
        },
      ],
    };

    const result = anthropicToGemini(req);

    expect(result.contents[0].parts).toEqual([{ text: 'Hello' }]);
  });

  it('should skip unknown content block types', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'unknown_type' as any, text: 'data' },
            { type: 'text', text: 'Hello' },
          ],
        },
      ],
    };

    const result = anthropicToGemini(req);

    expect(result.contents[0].parts).toEqual([{ text: 'Hello' }]);
  });

  it('should not include systemInstruction when system is undefined', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    };

    const result = anthropicToGemini(req);

    expect(result.systemInstruction).toBeUndefined();
  });

  it('should not include tools when none provided', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
    };

    const result = anthropicToGemini(req);

    expect(result.tools).toBeUndefined();
  });

  it('should handle tool_result with empty content', () => {
    const req: AnthropicRequest = {
      model: 'test',
      max_tokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1' },
          ],
        },
      ],
    };

    const result = anthropicToGemini(req);

    const responsePart = result.contents[1].parts[0];
    expect(responsePart.functionResponse?.response.result).toBe('');
  });
});
