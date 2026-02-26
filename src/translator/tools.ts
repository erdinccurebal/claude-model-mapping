/**
 * Tool use conversion helpers between Anthropic and Gemini formats
 */

import crypto from 'node:crypto';

export function generateToolUseId(): string {
  return 'toolu_cmm_' + crypto.randomBytes(12).toString('base64url');
}

export function generateMessageId(): string {
  return 'msg_cmm_' + crypto.randomBytes(12).toString('base64url');
}
