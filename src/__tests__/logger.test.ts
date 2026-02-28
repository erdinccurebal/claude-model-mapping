import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mock config before importing logger
vi.mock('../config', () => ({
  CMM_DIR: path.join(process.cwd(), '.test-cmm'),
}));

import { log, logError } from '../logger';

const TEST_DIR = path.join(process.cwd(), '.test-cmm');
const LOG_FILE = path.join(TEST_DIR, 'cmm.log');

describe('Logger', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('should log messages with date+time timestamps', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    log('test message');

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0];
    expect(output).toContain('test message');
    // YYYY-MM-DD HH:MM:SS format
    expect(output).toMatch(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);

    consoleSpy.mockRestore();
  });

  it('should log errors with ERROR prefix', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logError('error message');

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0];
    expect(output).toContain('ERROR:');
    expect(output).toContain('error message');

    consoleSpy.mockRestore();
  });

  it('should write logs to file', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    log('file write test');

    expect(fs.existsSync(LOG_FILE)).toBe(true);
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    expect(content).toContain('file write test');

    vi.restoreAllMocks();
  });

  it('should create log directory if missing', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(fs.existsSync(TEST_DIR)).toBe(false);
    log('creates dir');
    expect(fs.existsSync(TEST_DIR)).toBe(true);

    vi.restoreAllMocks();
  });

  it('should append multiple log lines', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    log('line 1');
    log('line 2');
    log('line 3');

    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('line 1');
    expect(lines[2]).toContain('line 3');

    vi.restoreAllMocks();
  });
});
