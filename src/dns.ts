import dns from 'node:dns';
import fs from 'node:fs';
import { ANTHROPIC_HOST, IP_CACHE_PATH, HOSTS_MARKER } from './config';

const HOSTS_FILE = '/etc/hosts';

export async function resolveAnthropicIP(): Promise<string> {
  return new Promise((resolve, reject) => {
    dns.resolve4(ANTHROPIC_HOST, (err, addresses) => {
      if (err) return reject(err);
      if (!addresses || addresses.length === 0) {
        return reject(new Error(`Could not resolve ${ANTHROPIC_HOST}`));
      }
      const ip = addresses[0];
      fs.writeFileSync(IP_CACHE_PATH, ip);
      fs.chmodSync(IP_CACHE_PATH, 0o600);
      resolve(ip);
    });
  });
}

export function getCachedIP(): string {
  if (!fs.existsSync(IP_CACHE_PATH)) {
    throw new Error('No cached IP found. Run cmm start first.');
  }
  return fs.readFileSync(IP_CACHE_PATH, 'utf-8').trim();
}

export function addHostsEntry(): void {
  const entry = `127.0.0.1 ${ANTHROPIC_HOST} ${HOSTS_MARKER}`;
  const content = fs.readFileSync(HOSTS_FILE, 'utf-8');

  if (content.includes(HOSTS_MARKER)) {
    console.log(`📝 /etc/hosts already up to date ✓`);
    return;
  }

  fs.writeFileSync(HOSTS_FILE, content.trimEnd() + '\n' + entry + '\n');
  console.log(`📝 /etc/hosts updated → 127.0.0.1 ${ANTHROPIC_HOST}`);
}

export function removeHostsEntry(): void {
  if (!fs.existsSync(HOSTS_FILE)) return;

  const content = fs.readFileSync(HOSTS_FILE, 'utf-8');
  const lines = content.split('\n');
  const filtered = lines.filter((line) => !line.includes(HOSTS_MARKER));

  if (filtered.length !== lines.length) {
    fs.writeFileSync(HOSTS_FILE, filtered.join('\n'));
    console.log(`🧹 /etc/hosts cleaned → ${ANTHROPIC_HOST} removed`);
  }
}

export function isHostsHijacked(): boolean {
  if (!fs.existsSync(HOSTS_FILE)) return false;
  const content = fs.readFileSync(HOSTS_FILE, 'utf-8');
  return content.includes(HOSTS_MARKER);
}
