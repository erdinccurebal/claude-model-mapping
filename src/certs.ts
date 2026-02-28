import { execFileSync } from 'node:child_process';
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
  HOSTS_MARKER,
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
  const tempFiles = [
    path.join(CMM_DIR, 'server.csr'),
    path.join(CMM_DIR, 'server_ext.cnf'),
    path.join(CMM_DIR, 'ca.srl'),
  ];

  try {
    ensureCmmDir();

    console.log('\n🔐 Generating Root CA certificate...');

    // Generate CA private key
    execFileSync('openssl', ['genrsa', '-out', CA_KEY_PATH, '4096'], { stdio: 'pipe' });
    fs.chmodSync(CA_KEY_PATH, 0o600);
    console.log(`   → ${CA_KEY_PATH} (private key)`);

    // Generate CA certificate
    execFileSync('openssl', [
      'req', '-new', '-x509', '-key', CA_KEY_PATH, '-out', CA_CERT_PATH,
      '-days', '3650', '-subj', '/CN=cmm Root CA/O=cmm',
    ], { stdio: 'pipe' });
    console.log(`   → ${CA_CERT_PATH} (root certificate)`);

    console.log(`\n🔐 Generating server certificate for ${ANTHROPIC_HOST}...`);

    // Generate server private key
    execFileSync('openssl', ['genrsa', '-out', SERVER_KEY_PATH, '2048'], { stdio: 'pipe' });
    fs.chmodSync(SERVER_KEY_PATH, 0o600);
    console.log(`   → ${SERVER_KEY_PATH}`);

    // Create a temporary OpenSSL config for SANs
    const extFile = tempFiles[1];
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
    const csrPath = tempFiles[0];
    execFileSync('openssl', [
      'req', '-new', '-key', SERVER_KEY_PATH, '-out', csrPath,
      '-subj', `/CN=${ANTHROPIC_HOST}/O=cmm`,
    ], { stdio: 'pipe' });

    // Sign with CA
    execFileSync('openssl', [
      'x509', '-req', '-in', csrPath, '-CA', CA_CERT_PATH, '-CAkey', CA_KEY_PATH,
      '-CAcreateserial', '-out', SERVER_CERT_PATH, '-days', '365',
      '-extfile', extFile, '-extensions', 'v3_ca',
    ], { stdio: 'pipe' });
    console.log(`   → ${SERVER_CERT_PATH} (signed by CA)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Certificate generation failed: ${msg}`);
    process.exit(1);
  } finally {
    // Always clean up temp files, even on error
    for (const f of tempFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
}

export function trustCA(): void {
  console.log('\n🔑 Adding Root CA to macOS Keychain...');
  try {
    execFileSync('sudo', [
      'security', 'add-trusted-cert', '-d', '-r', 'trustRoot',
      '-k', '/Library/Keychains/System.keychain', CA_CERT_PATH,
    ], { stdio: 'inherit' });
    console.log('   → Added as trusted certificate "cmm Root CA" ✓');
  } catch {
    console.error('   ⚠ Failed to add to Keychain. You can add it manually.');
  }
}

export function setupNodeCA(): void {
  const shellProfile = path.join(os.homedir(), '.zshrc');
  const envLine = `export NODE_EXTRA_CA_CERTS="${CA_CERT_PATH}" ${HOSTS_MARKER}`;

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
    execFileSync('sudo', [
      'security', 'remove-trusted-cert', '-d', CA_CERT_PATH,
    ], { stdio: 'pipe' });
    console.log('🔑 Root CA removed from Keychain');
  } catch {
    // May not exist
  }
}
