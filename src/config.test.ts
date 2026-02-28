import { describe, it, expect } from 'vitest';
import {
  CMM_DIR,
  CA_KEY_PATH,
  CA_CERT_PATH,
  SERVER_KEY_PATH,
  SERVER_CERT_PATH,
  IP_CACHE_PATH,
  PID_FILE_PATH,
  ANTHROPIC_HOST,
  HOSTS_MARKER,
  TIMEOUT_STREAMING,
  TIMEOUT_NON_STREAMING,
  TIMEOUT_PASSTHROUGH,
} from './config';

describe('Config', () => {
  it('should define all required paths', () => {
    expect(CMM_DIR).toMatch(/\.cmm$/);
    expect(CA_KEY_PATH).toMatch(/ca\.key$/);
    expect(CA_CERT_PATH).toMatch(/ca\.crt$/);
    expect(SERVER_KEY_PATH).toMatch(/server\.key$/);
    expect(SERVER_CERT_PATH).toMatch(/server\.crt$/);
  });

  it('should define cache and PID paths', () => {
    expect(IP_CACHE_PATH).toMatch(/anthropic-ip\.cache$/);
    expect(PID_FILE_PATH).toMatch(/cmm\.pid$/);
  });

  it('should have correct Anthropic host', () => {
    expect(ANTHROPIC_HOST).toBe('api.anthropic.com');
  });

  it('should define hosts marker for /etc/hosts', () => {
    expect(HOSTS_MARKER).toBe('# cmm-managed');
  });

  it('should define reasonable timeouts', () => {
    expect(TIMEOUT_STREAMING).toBe(300_000); // 5 min
    expect(TIMEOUT_NON_STREAMING).toBe(120_000); // 2 min
    expect(TIMEOUT_PASSTHROUGH).toBe(120_000); // 2 min
    expect(TIMEOUT_STREAMING).toBeGreaterThan(TIMEOUT_NON_STREAMING);
  });

  it('should have paths in CMM_DIR', () => {
    expect(CA_KEY_PATH).toContain(CMM_DIR);
    expect(CA_CERT_PATH).toContain(CMM_DIR);
    expect(SERVER_KEY_PATH).toContain(CMM_DIR);
    expect(SERVER_CERT_PATH).toContain(CMM_DIR);
  });

  it('should be importable and define all exports', () => {
    // Verify that all constants are defined (they were used in other assertions)
    expect(CMM_DIR).toBeTruthy();
    expect(ANTHROPIC_HOST).toBeTruthy();
    expect(HOSTS_MARKER).toBeTruthy();
  });
});
