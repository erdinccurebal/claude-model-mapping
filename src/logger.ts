/**
 * File + console logger with size-based rotation
 */

import fs from 'node:fs';
import path from 'node:path';
import { CMM_DIR } from './config';

const LOG_FILE = path.join(CMM_DIR, 'cmm.log');
const MAX_SIZE = 1 * 1024 * 1024; // 1 MB
const MAX_BACKUPS = 3; // cmm.log.1, cmm.log.2, cmm.log.3

let currentSize = -1; // -1 = not yet checked

/**
 * Rotate log files when size exceeds MAX_SIZE
 * Keeps up to MAX_BACKUPS old files: cmm.log.1 (newest) → cmm.log.3 (oldest)
 */
function rotateIfNeeded(): void {
  // Lazy-init current size
  if (currentSize < 0) {
    try {
      currentSize = fs.statSync(LOG_FILE).size;
    } catch {
      currentSize = 0;
    }
  }

  if (currentSize < MAX_SIZE) return;

  // Shift old backups: .3 → delete, .2 → .3, .1 → .2
  for (let i = MAX_BACKUPS; i >= 1; i--) {
    const from = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
    const to = `${LOG_FILE}.${i}`;
    try {
      if (i === MAX_BACKUPS) fs.unlinkSync(to);
    } catch {}
    try {
      fs.renameSync(from, to);
    } catch {}
  }

  currentSize = 0;
}

/**
 * Format timestamp as YYYY-MM-DD HH:MM:SS
 */
function ts(): string {
  const d = new Date();
  const date = d.toISOString().slice(0, 10);
  const time = d.toLocaleTimeString('en-US', { hour12: false });
  return `${date} ${time}`;
}

/**
 * Write a line to console and log file
 */
function writeLine(line: string): void {
  try {
    // Ensure log directory exists
    if (!fs.existsSync(CMM_DIR)) {
      fs.mkdirSync(CMM_DIR, { recursive: true });
    }

    rotateIfNeeded();

    const data = line + '\n';
    fs.appendFileSync(LOG_FILE, data);
    currentSize += Buffer.byteLength(data);
  } catch (err) {
    // Last resort: stderr so we don't lose the error silently
    process.stderr.write(`[logger] failed to write: ${err}\n`);
  }
}

export function log(msg: string): void {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  writeLine(line);
}

export function logError(msg: string): void {
  const line = `[${ts()}] ERROR: ${msg}`;
  console.error(line);
  writeLine(line);
}
