import { Command } from 'commander';
import fs from 'node:fs';
import https from 'node:https';
import {
  CMM_DIR,
  PID_FILE_PATH,
  ANTHROPIC_HOST,
  GEMINI_OAUTH_CREDS_PATH,
  CA_CERT_PATH,
  MappingConfig,
} from './config';
import { generateCerts, trustCA, setupNodeCA, certsExist, removeKeychain, removeNodeCA } from './certs';
import { addHostsEntry, removeHostsEntry, isHostsHijacked, resolveAnthropicIP } from './dns';
import { initAnthropicIP } from './providers/anthropic';
import { initCodeAssist } from './providers/gemini';
import { startServer } from './server';
import { runE2ETest } from './e2e-test';

const program = new Command();

program
  .name('cmm')
  .description('Claude Model Mapping — Transparent OS-level model interception')
  .version('1.0.0');

// ──── cmm setup ────
program
  .command('setup')
  .description('Generate certificates and trust them (run once)')
  .action(async () => {
    // Check prerequisites
    checkPrerequisites();

    generateCerts();
    trustCA();
    setupNodeCA();

    console.log('\n✅ Setup complete!');
    console.log('   Now open a new terminal and start using it:');
    console.log('   sudo cmm claude-haiku-4-5 gemini-3.1-pro-preview');
  });

// ──── cmm stop ────
program
  .command('stop')
  .description('Stop interceptor and clean up')
  .action(() => {
    cleanup();
    console.log('✅ Clean shutdown');
  });

// ──── cmm status ────
program
  .command('status')
  .description('Check if cmm is running')
  .action(() => {
    const hostsActive = isHostsHijacked();
    const pidExists = fs.existsSync(PID_FILE_PATH);
    let running = false;

    if (pidExists) {
      const pid = parseInt(fs.readFileSync(PID_FILE_PATH, 'utf-8').trim());
      if (!isNaN(pid) && pid > 0) {
        try {
          process.kill(pid, 0); // Check if process exists
          running = true;
        } catch {
          // Process not running, stale PID file
        }
      }
    }

    if (running) {
      console.log('✅ cmm is running');
      console.log(`   PID: ${fs.readFileSync(PID_FILE_PATH, 'utf-8').trim()}`);
    } else {
      console.log('❌ cmm is not running');
    }
    console.log(`   /etc/hosts: ${hostsActive ? 'hijacked ✓' : 'clean'}`);
    console.log(`   Certificates: ${certsExist() ? 'present ✓' : 'missing'}`);
  });

// ──── cmm uninstall ────
program
  .command('uninstall')
  .description('Remove all cmm certificates and configuration')
  .action(() => {
    cleanup();
    removeKeychain();
    removeNodeCA();
    if (fs.existsSync(CMM_DIR)) {
      fs.rmSync(CMM_DIR, { recursive: true });
      console.log(`🗑  ${CMM_DIR} removed`);
    }
    console.log('✅ cmm completely uninstalled');
  });

// ──── cmm test ────
program
  .command('test')
  .description('Run E2E integration test (cmm must be running)')
  .action(async () => {
    // Check if cmm is already running
    if (!isHostsHijacked()) {
      // Start a temporary interceptor for the test
      console.log('cmm is not running, starting temporarily for testing...\n');

      if (!certsExist()) {
        console.error('❌ Certificates not found. Run "cmm setup" first.');
        process.exit(1);
      }
      if (!fs.existsSync(GEMINI_OAUTH_CREDS_PATH)) {
        console.error('❌ Gemini OAuth credentials not found.');
        process.exit(1);
      }

      const mapping = { sourceModel: 'claude-haiku-4-5', targetModel: 'gemini-3.1-pro-preview' };

      const realIP = await initAnthropicIP();
      console.log(`📡 Real IP: ${realIP}`);

      console.log('🤖 Connecting to Gemini Code Assist...');
      await initCodeAssist();

      addHostsEntry();

      let server: https.Server;
      try {
        server = await startServer(mapping);
      } catch (err: any) {
        removeHostsEntry();
        console.error(`❌ Failed to start server: ${err.message}`);
        process.exit(1);
      }

      // Run test
      const pass = await runE2ETest();

      // Cleanup
      server.close();
      removeHostsEntry();

      process.exit(pass ? 0 : 1);
    } else {
      // cmm is already running, just run tests against it
      const pass = await runE2ETest();
      process.exit(pass ? 0 : 1);
    }
  });

// ──── cmm <source> <target> (default command) ────
program
  .argument('[source]', 'Source model to intercept (e.g., claude-haiku-4-5)')
  .argument('[target]', 'Target model to redirect to (e.g., gemini-3.1-pro-preview)')
  .action(async (source?: string, target?: string) => {
    if (!source || !target) {
      // No arguments and no subcommand — show help
      program.help();
      return;
    }

    await startInterceptor(source, target);
  });

program.parse();

// ──── Core functions ────

async function startInterceptor(source: string, target: string): Promise<void> {
  // Check prerequisites
  if (!certsExist()) {
    console.error('❌ Certificates not found. Run "cmm setup" first.');
    process.exit(1);
  }

  if (!fs.existsSync(GEMINI_OAUTH_CREDS_PATH)) {
    console.error('❌ Gemini OAuth credentials not found.');
    console.error('   Install and log in to Gemini CLI: npm install -g @google/gemini-cli && gemini');
    process.exit(1);
  }

  // Check NODE_EXTRA_CA_CERTS
  if (!process.env.NODE_EXTRA_CA_CERTS) {
    console.warn('⚠ NODE_EXTRA_CA_CERTS is not set.');
    console.warn(`   Run "cmm setup" or: export NODE_EXTRA_CA_CERTS="${CA_CERT_PATH}"`);
  }

  const mapping: MappingConfig = { sourceModel: source, targetModel: target };

  // Resolve real Anthropic IP before hijacking DNS
  console.log(`\n📡 Resolving ${ANTHROPIC_HOST}...`);
  const realIP = await initAnthropicIP();
  console.log(`   → Real IP: ${realIP} (cached)`);

  // Initialize Gemini Code Assist
  console.log(`\n🤖 Connecting to Gemini Code Assist...`);
  await initCodeAssist();

  // Hijack DNS
  console.log(`\n📝 Updating /etc/hosts...`);
  addHostsEntry();

  // Start HTTPS server
  let server: https.Server;
  try {
    server = await startServer(mapping);
  } catch (err: any) {
    console.error(`\n❌ Failed to start server: ${err.message}`);
    removeHostsEntry();
    process.exit(1);
  }

  // Write PID file
  if (!fs.existsSync(CMM_DIR)) fs.mkdirSync(CMM_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE_PATH, String(process.pid));

  console.log(`\n🔌 HTTPS interceptor started: https://127.0.0.1:443`);
  console.log(`\n✅ Active! Mapping:`);
  console.log(`   ${source}* → ${target}`);
  console.log(`   other models → ${ANTHROPIC_HOST} (${realIP})`);
  console.log(`\n📊 Log:`);

  // Graceful shutdown (guard against double invocation)
  let shuttingDown = false;
  const shutdownHandler = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n');
    server.close();
    cleanup();
    console.log('✅ Clean shutdown');
    process.exit(0);
  };

  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);
}

function cleanup(): void {
  // Remove /etc/hosts entry
  try {
    removeHostsEntry();
  } catch (err: any) {
    console.error(`⚠ Failed to clean /etc/hosts: ${err.message}`);
  }

  // Remove PID file
  if (fs.existsSync(PID_FILE_PATH)) {
    // Check if we should kill the process
    const pid = parseInt(fs.readFileSync(PID_FILE_PATH, 'utf-8').trim());
    if (!isNaN(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`🔌 cmm process (PID ${pid}) stopped`);
      } catch {
        // Process may already be dead
      }
    }
    fs.unlinkSync(PID_FILE_PATH);
  }
}

function checkPrerequisites(): void {
  // Check Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0]);
  if (major < 18) {
    console.error(`❌ Node.js v18+ required. Current: ${nodeVersion}`);
    process.exit(1);
  }

  // Check Gemini CLI credentials
  if (!fs.existsSync(GEMINI_OAUTH_CREDS_PATH)) {
    console.warn('⚠ Gemini CLI credentials not found (~/.gemini/oauth_creds.json)');
    console.warn('   Install and log in to Gemini CLI: npm install -g @google/gemini-cli && gemini');
  }
}
