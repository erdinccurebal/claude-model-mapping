import { describe, it, expect } from 'vitest';
import { generateToolUseId, generateMessageId } from './tools';

describe('generateToolUseId', () => {
  it('should start with toolu_cmm_ prefix', () => {
    const id = generateToolUseId();
    expect(id).toMatch(/^toolu_cmm_/);
  });

  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateToolUseId()));
    expect(ids.size).toBe(100);
  });

  it('should be a valid base64url string after prefix', () => {
    const id = generateToolUseId();
    const suffix = id.replace('toolu_cmm_', '');
    expect(suffix).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('generateMessageId', () => {
  it('should start with msg_cmm_ prefix', () => {
    const id = generateMessageId();
    expect(id).toMatch(/^msg_cmm_/);
  });

  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateMessageId()));
    expect(ids.size).toBe(100);
  });
});
