/**
 * Anthropic Messages API <-> Gemini API message format conversion
 */

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
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

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: any };
  functionResponse?: { name: string; response: any };
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: GeminiToolDeclaration[];
  toolConfig?: any;
  generationConfig?: any;
}

export interface GeminiToolDeclaration {
  functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: any;
}

/**
 * Build a mapping of tool_use_id → tool name from the message history.
 * Needed for converting tool_result → functionResponse.
 */
function buildToolUseIdMap(messages: AnthropicMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const blocks = normalizeContent(msg.content);
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id && block.name) {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

function normalizeContent(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

/**
 * Convert Anthropic Messages request to Gemini request format
 */
export function anthropicToGemini(req: AnthropicRequest): GeminiRequest {
  const toolIdMap = buildToolUseIdMap(req.messages);

  // Convert messages
  const contents: GeminiContent[] = [];
  for (const msg of req.messages) {
    const geminiRole: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
    const blocks = normalizeContent(msg.content);
    const parts: GeminiPart[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          if (block.text) {
            parts.push({ text: block.text });
          }
          break;

        case 'thinking':
          // Pass thinking content to Gemini as thought-tagged text
          if (block.thinking) {
            parts.push({ text: block.thinking, thought: true } as GeminiPart);
          }
          break;

        case 'tool_use':
          parts.push({
            functionCall: {
              name: block.name!,
              args: block.input || {},
            },
          });
          break;

        case 'tool_result': {
          const toolName = toolIdMap.get(block.tool_use_id!) || 'unknown_tool';
          const resultContent = extractToolResultContent(block);
          parts.push({
            functionResponse: {
              name: toolName,
              response: { result: resultContent },
            },
          });
          break;
        }

        case 'image':
          if (block.source?.type === 'base64') {
            parts.push({
              inlineData: {
                mimeType: block.source.media_type || 'image/png',
                data: block.source.data,
              },
            });
          }
          break;

        default:
          // Unknown block type, skip
          break;
      }
    }

    if (parts.length > 0) {
      // Gemini requires alternating user/model roles
      // If last content has the same role, merge parts
      const last = contents[contents.length - 1];
      if (last && last.role === geminiRole) {
        last.parts.push(...parts);
      } else {
        contents.push({ role: geminiRole, parts });
      }
    }
  }

  const result: GeminiRequest = { contents };

  // Convert system instruction
  if (req.system) {
    const systemParts: GeminiPart[] = [];
    if (typeof req.system === 'string') {
      systemParts.push({ text: req.system });
    } else {
      for (const block of req.system) {
        if (block.type === 'text' && block.text) {
          systemParts.push({ text: block.text });
        }
      }
    }
    if (systemParts.length > 0) {
      result.systemInstruction = { parts: systemParts };
    }
  }

  // Convert tools
  if (req.tools && req.tools.length > 0) {
    result.tools = [
      {
        functionDeclarations: req.tools.map((tool) => {
          const decl: GeminiFunctionDeclaration = { name: tool.name };
          if (tool.description) decl.description = tool.description;
          if (tool.input_schema) decl.parameters = cleanSchema(tool.input_schema);
          return decl;
        }),
      },
    ];

    // Convert tool_choice
    if (req.tool_choice) {
      if (req.tool_choice.type === 'none') {
        result.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      } else if (req.tool_choice.type === 'any') {
        result.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      } else if (req.tool_choice.type === 'tool') {
        result.toolConfig = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [req.tool_choice.name],
          },
        };
      } else {
        result.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      }
    }
  }

  // Generation config
  const genConfig: any = {};
  if (req.max_tokens) genConfig.maxOutputTokens = req.max_tokens;
  if (req.temperature !== undefined) genConfig.temperature = req.temperature;
  if (req.top_p !== undefined) genConfig.topP = req.top_p;
  if (req.top_k !== undefined) genConfig.topK = req.top_k;
  if (req.stop_sequences) genConfig.stopSequences = req.stop_sequences;

  // Thinking support
  if (req.thinking?.type === 'enabled' && req.thinking.budget_tokens) {
    genConfig.thinkingConfig = { thinkingBudget: req.thinking.budget_tokens };
  }

  if (Object.keys(genConfig).length > 0) {
    result.generationConfig = genConfig;
  }

  return result;
}

/**
 * Remove JSON Schema properties that Gemini doesn't support.
 * Uses a whitelist approach — only keeps fields Gemini understands.
 */
const GEMINI_ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'description', 'properties', 'required', 'items',
  'enum', 'format', 'nullable', 'minimum', 'maximum',
  'minItems', 'maxItems', 'minLength', 'maxLength',
  'pattern', 'default', 'example', 'title', 'anyOf', 'oneOf',
]);

function cleanSchema(schema: any, isPropertyMap = false): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map((v) => (typeof v === 'object' && v !== null ? cleanSchema(v) : v));
  }

  const cleaned: any = {};
  for (const [key, value] of Object.entries(schema)) {
    // Inside "properties", keys are user-defined property names — keep all
    if (!isPropertyMap && !GEMINI_ALLOWED_SCHEMA_KEYS.has(key)) continue;
    if (typeof value === 'object' && value !== null) {
      // "properties" is a map of name → schema, so recurse with isPropertyMap=true
      cleaned[key] = cleanSchema(value, key === 'properties');
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function extractToolResultContent(block: AnthropicContentBlock): string {
  if (!block.content) return '';
  if (typeof block.content === 'string') return block.content;
  // Array of content blocks — concatenate text
  return block.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
}
