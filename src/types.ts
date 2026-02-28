/**
 * Anthropic Messages API type definitions
 */

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: any;
  is_error?: boolean;
  cache_control?: any;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  tools?: AnthropicTool[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tool_choice?: any;
  thinking?: { type: string; budget_tokens?: number };
  metadata?: any;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: any;
}
