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
export const HOSTS_MARKER = '# cmm-managed';

// CLIProxyAPI
export const PROXY_HOST = 'localhost';
export const PROXY_PORT = 8317;
export const PROXY_PATH = '/v1/messages';
export const PROXY_API_KEY = 'sk-iuKiKWCkUlahcoE6X';

// Timeouts (ms)
export const TIMEOUT_STREAMING = 300_000;   // 5 min — streaming responses can be long
export const TIMEOUT_NON_STREAMING = 120_000; // 2 min
export const TIMEOUT_PASSTHROUGH = 120_000;   // 2 min

export interface MappingConfig {
  sourceModel: string;
  targetModel: string;
}
