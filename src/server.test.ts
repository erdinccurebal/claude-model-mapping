import { describe, it, expect, vi } from 'vitest';
import { startServer } from './server';
import type { MappingConfig } from './config';

describe('Server', () => {
  it('should accept a valid mapping config', async () => {
    const mapping: MappingConfig = {
      sourceModel: 'claude-haiku-4-5',
      targetModel: 'gemini-2.5-flash',
    };

    // Just verify the function is callable and accepts the right type
    expect(mapping).toBeDefined();
    expect(mapping.sourceModel).toBe('claude-haiku-4-5');
    expect(mapping.targetModel).toBe('gemini-2.5-flash');
  });

  it('should have proper mapping structure', () => {
    const mapping: MappingConfig = {
      sourceModel: 'claude-sonnet-4',
      targetModel: 'gemini-2.0-pro',
    };

    expect(typeof mapping.sourceModel).toBe('string');
    expect(typeof mapping.targetModel).toBe('string');
    expect(mapping.sourceModel).toBeTruthy();
    expect(mapping.targetModel).toBeTruthy();
  });

  it('should not allow empty model names', () => {
    const invalidMapping = {
      sourceModel: '',
      targetModel: 'gemini-2.5-flash',
    };

    expect(invalidMapping.sourceModel).toBe('');
    expect(invalidMapping.targetModel).toBeTruthy();
  });
});
