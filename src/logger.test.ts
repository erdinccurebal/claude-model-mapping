import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { log, logError } from './logger';

const LOG_FILE = path.join(process.cwd(), '.test-cmm.log');

describe('Logger', () => {
  beforeEach(() => {
    // Clean up test log file before each test
    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
    }
  });

  afterEach(() => {
    // Clean up after tests
    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
    }
  });

  it('should log messages with timestamps', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    log('test message');

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0];
    expect(output).toContain('test message');
    expect(output).toMatch(/\[\d{2}:\d{2}:\d{2}\]/); // HH:MM:SS format

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

  it('should format log output consistently', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    log('message 1');
    log('message 2');

    expect(consoleSpy).toHaveBeenCalledTimes(2);

    // Both should have timestamps
    expect(consoleSpy.mock.calls[0][0]).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    expect(consoleSpy.mock.calls[1][0]).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);

    consoleSpy.mockRestore();
  });
});
