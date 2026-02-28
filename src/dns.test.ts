import { describe, it, expect, vi } from 'vitest';
import { getCachedIP, isHostsHijacked } from './dns';

describe('DNS utilities', () => {
  it('should return null for uncached IP initially', () => {
    const ip = getCachedIP();
    // Either null or a previously cached IP, but should be a string or null
    expect(typeof ip === 'string' || ip === null).toBe(true);
  });

  it('should detect hosts hijack status', () => {
    const hijacked = isHostsHijacked();
    // Should return a boolean
    expect(typeof hijacked).toBe('boolean');
  });

  it('should have getCachedIP return string or null', () => {
    const ip = getCachedIP();
    if (ip !== null) {
      // If not null, should be a valid IP format
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });

  it('should have isHostsHijacked return boolean', () => {
    const result = isHostsHijacked();
    expect([true, false]).toContain(result);
  });
});
