/**
 * Converts Gemini streaming SSE chunks → Anthropic SSE events
 */

import crypto from 'node:crypto';
import { generateToolUseId, generateMessageId } from './tools';

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        functionCall?: { name: string; args: any };
      }>;
      role?: string;
    };
    finishReason?: string;
    index?: number;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
  error?: any;
}

export class StreamTranslator {
  private messageId: string;
  private fakeModel: string;
  private blockIndex = 0;
  private activeBlockType: 'text' | 'thinking' | null = null;
  private started = false;
  private hasFunctionCall = false;
  private inputTokens = 0;
  private outputTokens = 0;

  constructor(fakeModel: string) {
    this.messageId = generateMessageId();
    this.fakeModel = fakeModel;
  }

  /**
   * Parse a Gemini SSE data line into Anthropic SSE events
   */
  processChunk(chunk: GeminiStreamChunk): string[] {
    const events: string[] = [];

    if (chunk.error) {
      return [this.errorEvent(`Gemini API error: ${JSON.stringify(chunk.error)}`)];
    }

    // Track usage from any chunk that has it
    if (chunk.usageMetadata) {
      if (chunk.usageMetadata.promptTokenCount) {
        this.inputTokens = chunk.usageMetadata.promptTokenCount;
      }
      if (chunk.usageMetadata.candidatesTokenCount) {
        this.outputTokens = chunk.usageMetadata.candidatesTokenCount;
      }
    }

    if (!this.started) {
      events.push(
        this.sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: this.messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: this.fakeModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: this.inputTokens, output_tokens: 0 },
          },
        })
      );
      events.push(this.sseEvent('ping', { type: 'ping' }));
      this.started = true;
    }

    for (const candidate of chunk.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.functionCall) {
          // Close any active block first
          if (this.activeBlockType !== null) {
            if (this.activeBlockType === 'thinking') {
              events.push(...this.emitSignatureDelta());
            }
            events.push(
              this.sseEvent('content_block_stop', {
                type: 'content_block_stop',
                index: this.blockIndex,
              })
            );
            this.blockIndex++;
            this.activeBlockType = null;
          }

          this.hasFunctionCall = true;
          const toolUseId = generateToolUseId();

          events.push(
            this.sseEvent('content_block_start', {
              type: 'content_block_start',
              index: this.blockIndex,
              content_block: {
                type: 'tool_use',
                id: toolUseId,
                name: part.functionCall.name,
                input: {},
              },
            })
          );

          const inputJson = JSON.stringify(part.functionCall.args || {});
          events.push(
            this.sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: this.blockIndex,
              delta: { type: 'input_json_delta', partial_json: inputJson },
            })
          );

          events.push(
            this.sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: this.blockIndex,
            })
          );
          this.blockIndex++;
        } else if (part.thought && part.text) {
          // Thinking/reasoning part
          if (this.activeBlockType !== 'thinking') {
            if (this.activeBlockType !== null) {
              events.push(
                this.sseEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: this.blockIndex,
                })
              );
              this.blockIndex++;
            }
            events.push(
              this.sseEvent('content_block_start', {
                type: 'content_block_start',
                index: this.blockIndex,
                content_block: { type: 'thinking', thinking: '' },
              })
            );
            this.activeBlockType = 'thinking';
          }
          events.push(
            this.sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: this.blockIndex,
              delta: { type: 'thinking_delta', thinking: part.text },
            })
          );
        } else if (part.text !== undefined && part.text !== '') {
          // Regular text part
          if (this.activeBlockType !== 'text') {
            if (this.activeBlockType !== null) {
              if (this.activeBlockType === 'thinking') {
                events.push(...this.emitSignatureDelta());
              }
              events.push(
                this.sseEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: this.blockIndex,
                })
              );
              this.blockIndex++;
            }
            events.push(
              this.sseEvent('content_block_start', {
                type: 'content_block_start',
                index: this.blockIndex,
                content_block: { type: 'text', text: '' },
              })
            );
            this.activeBlockType = 'text';
          }
          events.push(
            this.sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: this.blockIndex,
              delta: { type: 'text_delta', text: part.text },
            })
          );
        }
      }

      // Handle finish
      if (candidate.finishReason) {
        if (this.activeBlockType !== null) {
          if (this.activeBlockType === 'thinking') {
            events.push(...this.emitSignatureDelta());
          }
          events.push(
            this.sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: this.blockIndex,
            })
          );
          this.activeBlockType = null;
        }

        const stopReason = this.hasFunctionCall ? 'tool_use' : 'end_turn';

        events.push(
          this.sseEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: this.outputTokens },
          })
        );
        events.push(this.sseEvent('message_stop', { type: 'message_stop' }));
      }
    }

    return events;
  }

  private emitSignatureDelta(): string[] {
    const sig = crypto.randomBytes(64).toString('base64');
    return [
      this.sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: this.blockIndex,
        delta: { type: 'signature_delta', signature: sig },
      }),
    ];
  }

  private sseEvent(event: string, data: any): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private errorEvent(message: string): string {
    return this.sseEvent('error', {
      type: 'error',
      error: { type: 'api_error', message },
    });
  }
}

/**
 * Parse SSE text into individual data objects
 */
const MAX_SSE_BUFFER = 5 * 1024 * 1024; // 5 MB

export class SSEParser {
  private buffer = '';

  feed(chunk: string): any[] {
    this.buffer += chunk;
    if (this.buffer.length > MAX_SSE_BUFFER) {
      this.buffer = '';
      throw new Error('SSE buffer overflow — response too large');
    }
    return this.extractEvents();
  }

  /**
   * Flush any remaining buffered data (call on stream end)
   */
  flush(): any[] {
    if (this.buffer.trim()) {
      const result = this.parseBlock(this.buffer);
      this.buffer = '';
      return result ? [result] : [];
    }
    return [];
  }

  private extractEvents(): any[] {
    const events: any[] = [];

    // SSE events are separated by double newlines
    const parts = this.buffer.split('\n\n');
    this.buffer = parts.pop() || '';

    for (const part of parts) {
      const parsed = this.parseBlock(part);
      if (parsed) events.push(parsed);
    }

    return events;
  }

  private parseBlock(block: string): any | null {
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) {
        dataLines.push(line.substring(6));
      }
    }
    if (dataLines.length > 0) {
      const data = dataLines.join('\n');
      try {
        return JSON.parse(data);
      } catch {
        // Skip malformed JSON
      }
    }
    return null;
  }
}
