import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { CMM_DIR, CA_CERT_PATH, PLIST_LABEL, PLIST_PATH } from './config';
import { certsExist } from './certs';

/** Resolve the real user's home dir (handles sudo correctly) */
function getRealHome(): string {
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser) return `/Users/${sudoUser}`;
  return os.homedir();
}

const SERVICE_LOG_PATH = path.join(CMM_DIR, 'cmm-service.log');
const WRAPPER_PATH = path.join(CMM_DIR, 'cmm-daemon');

/** Compile a tiny native wrapper so macOS shows "cmm" instead of "Node.js Foundation" in Login Items */
function ensureWrapper(): void {
  const nodePath = process.execPath;
  const cSource = `
#include <unistd.h>
#include <string.h>
int main(int argc, char *argv[]) {
    /* Replace argv[0] with node path, keep the rest */
    argv[0] = "${nodePath}";
    execv(argv[0], argv);
    return 1;
}
`;
  const cFile = path.join(CMM_DIR, 'cmm-daemon.c');
  fs.writeFileSync(cFile, cSource, 'utf-8');
  execFileSync('cc', ['-o', WRAPPER_PATH, cFile], { stdio: 'inherit' });
  fs.unlinkSync(cFile);
  fs.chmodSync(WRAPPER_PATH, 0o755);
}

function generatePlist(source: string, target: string): string {
  const entryPoint = path.resolve(__dirname, 'index.js');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${WRAPPER_PATH}</string>
    <string>${entryPoint}</string>
    <string>--daemon</string>
    <string>${source}</string>
    <string>${target}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${getRealHome()}</string>
    <key>NODE_EXTRA_CA_CERTS</key>
    <string>${CA_CERT_PATH}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${SERVICE_LOG_PATH}</string>

  <key>StandardErrorPath</key>
  <string>${SERVICE_LOG_PATH}</string>

</dict>
</plist>
`;
}

export function serviceInstall(source: string, target: string): void {
  if (!certsExist()) {
    console.error('Certificates not found. Run "cmm setup" first.');
    process.exit(1);
  }

  ensureWrapper();
  const plist = generatePlist(source, target);
  fs.writeFileSync(PLIST_PATH, plist, 'utf-8');

  execFileSync('launchctl', ['load', '-w', PLIST_PATH], { stdio: 'inherit' });

  console.log(`Service installed and started.`);
  console.log(`  Label:   ${PLIST_LABEL}`);
  console.log(`  Plist:   ${PLIST_PATH}`);
  console.log(`  Mapping: ${source} -> ${target}`);
  console.log(`  Log:     ${SERVICE_LOG_PATH}`);
}

export function serviceUninstall(): void {
  if (!fs.existsSync(PLIST_PATH)) {
    console.error(`Service not installed (${PLIST_PATH} not found).`);
    process.exit(1);
  }

  try {
    execFileSync('launchctl', ['unload', '-w', PLIST_PATH], { stdio: 'inherit' });
  } catch {
    // Service may already be unloaded
  }

  fs.unlinkSync(PLIST_PATH);
  try { fs.unlinkSync(WRAPPER_PATH); } catch {}
  console.log('Service uninstalled.');
}

export function serviceStart(): void {
  try {
    execFileSync('launchctl', ['start', PLIST_LABEL], { stdio: 'inherit' });
    console.log('Service start requested.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to start service: ${msg}`);
    process.exit(1);
  }
}

export function serviceStop(): void {
  try {
    execFileSync('launchctl', ['stop', PLIST_LABEL], { stdio: 'inherit' });
    console.log('Service stop requested.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to stop service: ${msg}`);
    process.exit(1);
  }
}

export function serviceRestart(): void {
  try {
    execFileSync('launchctl', ['stop', PLIST_LABEL], { stdio: 'inherit' });
  } catch {
    // Service may not be running
  }
  // Small delay to allow stop to complete
  execFileSync('sleep', ['1']);
  try {
    execFileSync('launchctl', ['start', PLIST_LABEL], { stdio: 'inherit' });
    console.log('Service restarted.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to restart service: ${msg}`);
    process.exit(1);
  }
}

export function serviceStatus(): void {
  try {
    const output = execFileSync('launchctl', ['list', PLIST_LABEL], { encoding: 'utf-8' });
    // Parse PID from launchctl list output (format: "PID\tStatus\tLabel" or key-value)
    const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
    const pid = pidMatch ? pidMatch[1] : null;

    if (pid && pid !== '0') {
      console.log(`Service is running (PID ${pid}).`);
    } else {
      console.log('Service is loaded but not currently running.');
    }
    console.log(`  Label: ${PLIST_LABEL}`);
    console.log(`  Plist: ${PLIST_PATH}`);
  } catch {
    console.log('Service is not installed.');
    process.exit(1);
  }
}
