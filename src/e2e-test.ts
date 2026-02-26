/**
 * End-to-end integration test for cmm
 * Usage: sudo cmm test
 *
 * 1. Starts the interceptor (haiku → gemini)
 * 2. Sends a haiku request → expects INTERCEPTED (x-cmm-provider: gemini)
 * 3. Sends an opus request → expects PASSTHROUGH (no x-cmm-provider)
 * 4. Cleans up
 */

import https from 'node:https';
import fs from 'node:fs';
import { CA_CERT_PATH, ANTHROPIC_HOST } from './config';

const TIMEOUT = 30_000;

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

function makeRequest(
  model: string,
  caCert: Buffer
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      max_tokens: 50,
      stream: false,
      messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
    });

    const timer = setTimeout(() => reject(new Error('Request timeout')), TIMEOUT);

    const req = https.request(
      {
        hostname: ANTHROPIC_HOST,
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'test-key',
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(payload),
        },
        ca: caCert,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers as Record<string, string>,
            body,
          });
        });
      }
    );

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

export async function runE2ETest(): Promise<boolean> {
  const results: TestResult[] = [];

  // Check CA cert
  if (!fs.existsSync(CA_CERT_PATH)) {
    console.error('❌ CA cert not found. Run "cmm setup" first.');
    return false;
  }
  const caCert = fs.readFileSync(CA_CERT_PATH);

  console.log('\n🧪 cmm E2E Test\n');

  // Test 1: haiku model → should be INTERCEPTED
  console.log('  [1/2] haiku → Gemini (expecting INTERCEPTED)...');
  try {
    const res = await makeRequest('claude-haiku-4-5-20251001', caCert);
    const provider = res.headers['x-cmm-provider'];
    if (provider === 'gemini') {
      results.push({
        name: 'haiku → INTERCEPTED',
        pass: true,
        detail: `✅ status=${res.statusCode}, provider=${provider}`,
      });
    } else if (res.statusCode === 200) {
      // Got 200 but no x-cmm-provider — went to real Anthropic
      results.push({
        name: 'haiku → INTERCEPTED',
        pass: false,
        detail: `❌ Got passthrough! No x-cmm-provider header. Status=${res.statusCode}`,
      });
    } else {
      // Parse error body
      let errMsg = `status=${res.statusCode}`;
      try {
        const errBody = JSON.parse(res.body);
        errMsg += `: ${errBody.error?.message || res.body.substring(0, 200)}`;
      } catch {
        errMsg += `: ${res.body.substring(0, 200)}`;
      }
      results.push({
        name: 'haiku → INTERCEPTED',
        pass: false,
        detail: `❌ Error: ${errMsg}`,
      });
    }
  } catch (err: any) {
    results.push({
      name: 'haiku → INTERCEPTED',
      pass: false,
      detail: `❌ Connection error: ${err.message}`,
    });
  }

  // Test 2: opus model → should be PASSTHROUGH
  console.log('  [2/2] opus → Anthropic (expecting PASSTHROUGH)...');
  try {
    const res = await makeRequest('claude-opus-4-20250514', caCert);
    const provider = res.headers['x-cmm-provider'];
    if (!provider) {
      results.push({
        name: 'opus → PASSTHROUGH',
        pass: true,
        detail: `✅ status=${res.statusCode}, no x-cmm-provider (passthrough)`,
      });
    } else {
      results.push({
        name: 'opus → PASSTHROUGH',
        pass: false,
        detail: `❌ Got intercepted! x-cmm-provider=${provider}`,
      });
    }
  } catch (err: any) {
    // Connection error might mean passthrough IP is wrong, but that's still a failure
    results.push({
      name: 'opus → PASSTHROUGH',
      pass: false,
      detail: `❌ Connection error: ${err.message}`,
    });
  }

  // Print results
  console.log('\n  ─── Results ───\n');
  let allPass = true;
  for (const r of results) {
    console.log(`  ${r.detail}`);
    console.log(`     ${r.name}\n`);
    if (!r.pass) allPass = false;
  }

  if (allPass) {
    console.log('  🎉 All tests passed!\n');
  } else {
    console.log('  💥 Some tests failed.\n');
  }

  return allPass;
}
