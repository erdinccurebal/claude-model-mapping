import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CMM_DIR = path.join(os.homedir(), '.cmm');

/** Strip surrounding single or double quotes from a value */
function stripQuotes(val: string): string {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

// Load .env file from ~/.cmm/.env
function loadEnv(): void {
  try {
    migrateOldEnv();
    const content = fs.readFileSync(path.join(CMM_DIR, '.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = stripQuotes(trimmed.slice(eqIdx + 1).trim());
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}

/** Migrate legacy .env from package root to ~/.cmm/.env */
function migrateOldEnv(): void {
  const oldPath = path.join(__dirname, '..', '.env');
  const newPath = path.join(CMM_DIR, '.env');
  try {
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      if (!fs.existsSync(CMM_DIR)) fs.mkdirSync(CMM_DIR, { recursive: true });
      fs.copyFileSync(oldPath, newPath);
      fs.chmodSync(newPath, 0o600);
    }
  } catch {}
}

loadEnv();
export const CA_KEY_PATH = path.join(CMM_DIR, 'ca.key');
export const CA_CERT_PATH = path.join(CMM_DIR, 'ca.crt');
export const SERVER_KEY_PATH = path.join(CMM_DIR, 'server.key');
export const SERVER_CERT_PATH = path.join(CMM_DIR, 'server.crt');
export const IP_CACHE_PATH = path.join(CMM_DIR, 'anthropic-ip.cache');
export const PID_FILE_PATH = path.join(CMM_DIR, 'cmm.pid');

export const ANTHROPIC_HOST = 'api.anthropic.com';
export const HOSTS_MARKER = '# cmm-managed';

// CLIProxyAPI
export const PROXY_URL = process.env.PROXY_URL || 'http://localhost:8317/v1/messages';
export const PROXY_API_KEY = process.env.PROXY_API_KEY || '';

// Timeouts (ms)
export const TIMEOUT_STREAMING = 300_000;   // 5 min — streaming responses can be long
export const TIMEOUT_NON_STREAMING = 120_000; // 2 min
export const TIMEOUT_PASSTHROUGH = 120_000;   // 2 min

export interface MappingConfig {
  sourceModel: string;
  targetModel: string;
}

// ──── .env read/write helpers ────

export const ENV_PATH = path.join(CMM_DIR, '.env');

export const VALID_CONFIG_KEYS = ['PROXY_API_KEY', 'PROXY_URL', 'DEFAULT_SOURCE_MODEL', 'DEFAULT_TARGET_MODEL'] as const;
export type ConfigKey = (typeof VALID_CONFIG_KEYS)[number];

export const CONFIG_DEFAULTS: Record<ConfigKey, string> = {
  PROXY_API_KEY: '',
  PROXY_URL: 'http://localhost:8317/v1/messages',
  DEFAULT_SOURCE_MODEL: '',
  DEFAULT_TARGET_MODEL: '',
};

export function readEnvFile(): Record<string, string> {
  const entries: Record<string, string> = {};
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = stripQuotes(trimmed.slice(eqIdx + 1).trim());
      entries[key] = val;
    }
  } catch {}
  return entries;
}

export function writeEnvFile(entries: Record<string, string>): void {
  if (!fs.existsSync(CMM_DIR)) fs.mkdirSync(CMM_DIR, { recursive: true });
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf-8');
  fs.chmodSync(ENV_PATH, 0o600);
}
