import path from 'node:path';
import os from 'node:os';

export const CMM_DIR = path.join(os.homedir(), '.cmm');
export const CA_KEY_PATH = path.join(CMM_DIR, 'ca.key');
export const CA_CERT_PATH = path.join(CMM_DIR, 'ca.crt');
export const SERVER_KEY_PATH = path.join(CMM_DIR, 'server.key');
export const SERVER_CERT_PATH = path.join(CMM_DIR, 'server.crt');
export const IP_CACHE_PATH = path.join(CMM_DIR, 'anthropic-ip.cache');
export const PID_FILE_PATH = path.join(CMM_DIR, 'cmm.pid');

export const ANTHROPIC_HOST = 'api.anthropic.com';
export const CODE_ASSIST_HOST = 'cloudcode-pa.googleapis.com';
export const CODE_ASSIST_API_VERSION = 'v1internal';
export const GEMINI_OAUTH_CREDS_PATH = path.join(os.homedir(), '.gemini', 'oauth_creds.json');

// Public OAuth credentials from Gemini CLI (intentionally public, same as in the open-source CLI)
export const GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
export const GEMINI_CLIENT_SECRET = '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';

export const HOSTS_MARKER = '# cmm-managed';

export interface MappingConfig {
  sourceModel: string;
  targetModel: string;
}
