import { Command } from 'commander';
import fs from 'node:fs';
import https from 'node:https';
import {
  CMM_DIR,
  PID_FILE_PATH,
  ANTHROPIC_HOST,
  CA_CERT_PATH,
  MappingConfig,
  VALID_CONFIG_KEYS,
  CONFIG_DEFAULTS,
  ConfigKey,
  readEnvFile,
  writeEnvFile,
} from './config';
import { generateCerts, trustCA, setupNodeCA, certsExist, removeKeychain, removeNodeCA } from './certs';
import { addHostsEntry, removeHostsEntry, isHostsHijacked } from './dns';
import { initAnthropicIP } from './providers/anthropic';
import { startServer } from './server';
import { runE2ETest } from './e2e-test';

const program = new Command();

program
  .name('cmm')
  .description('Claude Model Mapping — Transparent OS-level model interception')
  .version('1.2.0');

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
    console.log('   sudo cmm claude-haiku-4-5 gemini-2.5-flash');
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

    if (!running) process.exit(1);
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

      const mapping = { sourceModel: 'claude-haiku-4-5', targetModel: 'gemini-2.5-flash' };

      const realIP = await initAnthropicIP();
      console.log(`📡 Real IP: ${realIP}`);

      addHostsEntry();

      let server: https.Server;
      try {
        server = await startServer(mapping);
      } catch (err: unknown) {
        removeHostsEntry();
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`❌ Failed to start server: ${msg}`);
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

// ──── cmm config ────
const configCmd = program
  .command('config')
  .description('Get/set proxy configuration in .env file');

configCmd
  .command('list')
  .description('List all configuration values')
  .action(() => {
    const env = readEnvFile();
    const maxLen = Math.max(...VALID_CONFIG_KEYS.map(k => k.length));
    for (const key of VALID_CONFIG_KEYS) {
      const val = env[key] ?? CONFIG_DEFAULTS[key];
      const suffix = !(key in env) && CONFIG_DEFAULTS[key] ? ' (default)' : '';
      console.log(`  ${key.padEnd(maxLen)} = ${val || '(empty)'}${suffix}`);
    }
  });

configCmd
  .command('get <key>')
  .description('Get a configuration value')
  .action((key: string) => {
    if (!isValidKey(key)) return;
    const env = readEnvFile();
    const val = env[key] ?? CONFIG_DEFAULTS[key as ConfigKey];
    console.log(`  ${val || '(empty)'}`);
  });

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key: string, value: string) => {
    if (!isValidKey(key)) return;
    const env = readEnvFile();
    env[key] = value;
    writeEnvFile(env);
    console.log(`  ✅ ${key} = ${value}`);
  });

configCmd
  .command('delete <key>')
  .description('Delete a configuration value (revert to default)')
  .action((key: string) => {
    if (!isValidKey(key)) return;
    const env = readEnvFile();
    if (!(key in env)) {
      console.log(`  ⚠ ${key} is not set in .env`);
      return;
    }
    delete env[key];
    writeEnvFile(env);
    const def = CONFIG_DEFAULTS[key as ConfigKey];
    console.log(`  ✅ ${key} deleted${def ? ` (default: ${def})` : ''}`);
  });

function isValidKey(key: string): key is ConfigKey {
  if (!(VALID_CONFIG_KEYS as readonly string[]).includes(key)) {
    console.error(`  ❌ Unknown key: ${key}`);
    console.error(`  Valid keys: ${VALID_CONFIG_KEYS.join(', ')}`);
    return false;
  }
  return true;
}

// ──── cmm <source> <target> (default command) ────
program
  .argument('[source]', 'Source model to intercept (e.g., claude-haiku-4-5)')
  .argument('[target]', 'Target model to redirect to (e.g., gemini-2.5-flash)')
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

  // Hijack DNS
  console.log(`\n📝 Updating /etc/hosts...`);
  addHostsEntry();

  // Start HTTPS server
  let server: https.Server;
  try {
    server = await startServer(mapping);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Failed to start server: ${msg}`);
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`⚠ Failed to clean /etc/hosts: ${msg}`);
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
}
