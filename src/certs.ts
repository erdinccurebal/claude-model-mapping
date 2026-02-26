import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CMM_DIR,
  CA_KEY_PATH,
  CA_CERT_PATH,
  SERVER_KEY_PATH,
  SERVER_CERT_PATH,
  ANTHROPIC_HOST,
} from './config';

function ensureCmmDir(): void {
  if (!fs.existsSync(CMM_DIR)) {
    fs.mkdirSync(CMM_DIR, { recursive: true });
  }
}

export function certsExist(): boolean {
  return (
    fs.existsSync(CA_KEY_PATH) &&
    fs.existsSync(CA_CERT_PATH) &&
    fs.existsSync(SERVER_KEY_PATH) &&
    fs.existsSync(SERVER_CERT_PATH)
  );
}

export function generateCerts(): void {
  ensureCmmDir();

  console.log('\n🔐 Generating Root CA certificate...');

  // Generate CA private key
  execSync(`openssl genrsa -out "${CA_KEY_PATH}" 4096 2>/dev/null`);
  fs.chmodSync(CA_KEY_PATH, 0o600);
  console.log(`   → ${CA_KEY_PATH} (private key)`);

  // Generate CA certificate
  execSync(
    `openssl req -new -x509 -key "${CA_KEY_PATH}" -out "${CA_CERT_PATH}" -days 3650 ` +
    `-subj "/CN=cmm Root CA/O=cmm" 2>/dev/null`
  );
  console.log(`   → ${CA_CERT_PATH} (root certificate)`);

  console.log(`\n🔐 Generating server certificate for ${ANTHROPIC_HOST}...`);

  // Generate server private key
  execSync(`openssl genrsa -out "${SERVER_KEY_PATH}" 2048 2>/dev/null`);
  fs.chmodSync(SERVER_KEY_PATH, 0o600);
  console.log(`   → ${SERVER_KEY_PATH}`);

  // Create a temporary OpenSSL config for SANs
  const extFile = path.join(CMM_DIR, 'server_ext.cnf');
  fs.writeFileSync(
    extFile,
    [
      '[req]',
      'distinguished_name = req_dn',
      'req_extensions = v3_req',
      'prompt = no',
      '',
      '[req_dn]',
      `CN = ${ANTHROPIC_HOST}`,
      'O = cmm',
      '',
      '[v3_req]',
      `subjectAltName = DNS:${ANTHROPIC_HOST}`,
      '',
      '[v3_ca]',
      `subjectAltName = DNS:${ANTHROPIC_HOST}`,
    ].join('\n')
  );

  // Generate CSR
  const csrPath = path.join(CMM_DIR, 'server.csr');
  execSync(
    `openssl req -new -key "${SERVER_KEY_PATH}" -out "${csrPath}" ` +
    `-subj "/CN=${ANTHROPIC_HOST}/O=cmm" 2>/dev/null`
  );

  // Sign with CA
  execSync(
    `openssl x509 -req -in "${csrPath}" -CA "${CA_CERT_PATH}" -CAkey "${CA_KEY_PATH}" ` +
    `-CAcreateserial -out "${SERVER_CERT_PATH}" -days 365 ` +
    `-extfile "${extFile}" -extensions v3_ca 2>/dev/null`
  );
  console.log(`   → ${SERVER_CERT_PATH} (signed by CA)`);

  // Cleanup temp files
  for (const f of [csrPath, extFile, path.join(CMM_DIR, 'ca.srl')]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

export function trustCA(): void {
  console.log('\n🔑 Adding Root CA to macOS Keychain...');
  try {
    execSync(
      `sudo security add-trusted-cert -d -r trustRoot ` +
      `-k /Library/Keychains/System.keychain "${CA_CERT_PATH}"`,
      { stdio: 'inherit' }
    );
    console.log('   → Added as trusted certificate "cmm Root CA" ✓');
  } catch {
    console.error('   ⚠ Failed to add to Keychain. You can add it manually.');
  }
}

export function setupNodeCA(): void {
  const shellProfile = path.join(os.homedir(), '.zshrc');
  const envLine = `export NODE_EXTRA_CA_CERTS="${CA_CERT_PATH}" ${getHostsMarker()}`;

  if (fs.existsSync(shellProfile)) {
    const content = fs.readFileSync(shellProfile, 'utf-8');
    if (content.includes('NODE_EXTRA_CA_CERTS') && content.includes('cmm')) {
      console.log('\n📝 NODE_EXTRA_CA_CERTS already set in .zshrc ✓');
      return;
    }
  }

  console.log('\n📝 Adding NODE_EXTRA_CA_CERTS to ~/.zshrc...');
  fs.appendFileSync(shellProfile, `\n${envLine}\n`);
  console.log(`   → ${envLine}`);
  console.log('   ⚠ Open a new terminal or run: source ~/.zshrc for changes to take effect');
}

export function removeNodeCA(): void {
  const shellProfile = path.join(os.homedir(), '.zshrc');
  if (!fs.existsSync(shellProfile)) return;

  const content = fs.readFileSync(shellProfile, 'utf-8');
  const lines = content.split('\n');
  const filtered = lines.filter(
    (line) => !(line.includes('NODE_EXTRA_CA_CERTS') && line.includes('cmm'))
  );
  if (filtered.length !== lines.length) {
    fs.writeFileSync(shellProfile, filtered.join('\n'));
    console.log('📝 NODE_EXTRA_CA_CERTS removed from ~/.zshrc');
  }
}

export function removeKeychain(): void {
  try {
    execSync(
      `sudo security remove-trusted-cert -d "${CA_CERT_PATH}" 2>/dev/null`,
      { stdio: 'pipe' }
    );
    console.log('🔑 Root CA removed from Keychain');
  } catch {
    // May not exist
  }
}

function getHostsMarker(): string {
  return '# cmm-managed';
}
