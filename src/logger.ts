import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_FILE = path.join(os.homedir(), '.cmm', 'cmm.log');
const MAX_SIZE = 1 * 1024 * 1024; // 1 MB

function rotate(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size >= MAX_SIZE) {
      const old = LOG_FILE + '.old';
      try { fs.unlinkSync(old); } catch {}
      fs.renameSync(LOG_FILE, old);
    }
  } catch {}
}

function ts(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

export function log(msg: string): void {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try {
    rotate();
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

export function logError(msg: string): void {
  const line = `[${ts()}] ERROR: ${msg}`;
  console.error(line);
  try {
    rotate();
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}
