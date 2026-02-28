# cmm — Claude Model Mapping

[![npm](https://img.shields.io/npm/v/claude-model-mapping)](https://www.npmjs.com/package/claude-model-mapping)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**[Documentation](https://cmm.erdinc.curebal.dev)** | **[npm](https://www.npmjs.com/package/claude-model-mapping)** | **[GitHub](https://github.com/erdinccurebal/claude-model-mapping)**

Transparent OS-level interception for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Redirect any Claude model to Google Gemini without modifying Claude Code itself.

```
sudo cmm claude-haiku-4-5 gemini-2.5-flash
```

That's it. Open Claude Code normally — haiku requests go to Gemini, everything else passes through untouched.

## How It Works

```
Claude Code (unmodified)
    │
    │  HTTPS → api.anthropic.com:443
    │
    ▼
┌──────────────────────────────────┐
│  cmm — Local HTTPS Server (:443) │
│                                  │
│  model = haiku?                  │
│    YES → Gemini API              │
│    NO  → Real api.anthropic.com  │
└──────────────────────────────────┘
```

1. `/etc/hosts` redirects `api.anthropic.com` to `127.0.0.1`
2. cmm runs a local HTTPS server on port 443 with a trusted self-signed certificate
3. Incoming requests are routed by model name:
   - **Matched model** → translated to Gemini format, sent to CLIProxyAPI on localhost:8317, response translated back to Anthropic format
   - **Other models** → forwarded to real Anthropic API using cached IP

Claude Code sees normal Anthropic API responses. No env vars, no config changes, no patches.

## Prerequisites

- **macOS** (uses Keychain for certificate trust)
- **Node.js 18+**
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** installed and logged in
- **[Gemini CLI](https://github.com/google-gemini/gemini-cli)** installed and logged in (for OAuth credentials)

```bash
# Install Gemini CLI and log in
npm install -g @google/gemini-cli
gemini  # Follow the OAuth login flow
```

## Installation

```bash
npm install -g claude-model-mapping
```

Or from source:

```bash
git clone https://github.com/erdinccurebal/claude-model-mapping.git
cd claude-model-mapping
npm install && npm run build && npm link
```

### First-time setup (once)

```bash
cmm setup
```

This will:
- Generate a Root CA + server certificate for `api.anthropic.com`
- Add the CA to macOS Keychain (requires password/Touch ID)
- Set `NODE_EXTRA_CA_CERTS` in `~/.zshrc`

Open a **new terminal** after setup.

## Usage

### Start intercepting

```bash
sudo cmm <source-model> <target-model>
```

Examples:

```bash
# Redirect haiku to Gemini 2.5 Flash
sudo cmm claude-haiku-4-5 gemini-2.5-flash

# Redirect haiku to Gemini 2.5 Pro
sudo cmm claude-haiku-4-5 gemini-2.5-pro

# Redirect sonnet to Gemini
sudo cmm claude-sonnet-4 gemini-2.5-pro
```

Model names use **prefix matching** — `claude-haiku-4-5` matches `claude-haiku-4-5-20251001` and any future versions.

Then open Claude Code normally in another terminal:

```bash
claude
```

### Stop intercepting

```bash
sudo cmm stop
# or press Ctrl+C in the cmm terminal
```

### Check status

```bash
cmm status
```

### Run E2E test

```bash
sudo cmm test
```

### Uninstall

```bash
sudo cmm uninstall
```

Removes certificates, Keychain entry, `NODE_EXTRA_CA_CERTS` from `.zshrc`, and the `~/.cmm` directory.

## What gets intercepted?

| Request model | Behavior | Destination |
|---|---|---|
| Matches `<source-model>*` | **INTERCEPTED** | Gemini API (target model) |
| Everything else | **PASSTHROUGH** | Real api.anthropic.com |

Non-messages endpoints (`/v1/models`, `/api/oauth/*`, etc.) always pass through.

### Verifying interception

Intercepted responses include an `x-cmm-provider: gemini` header. You can check it in logs or with `curl`:

```bash
curl -s -D- https://api.anthropic.com/v1/messages \
  --cacert ~/.cmm/ca.crt \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":50,"stream":false,"messages":[{"role":"user","content":"hi"}]}' \
  2>&1 | grep x-cmm-provider
```

## Logs

Live logs appear in the terminal:

```
[18:01:32] claude-opus-4-6              → PASSTHROUGH ✓
[18:01:45] claude-haiku-4-5-20251001    → INTERCEPTED → gemini-2.5-flash ✓
[18:02:01] GET /v1/models               → PASSTHROUGH
```

Logs are also written to `~/.cmm/cmm.log` (1 MB max, auto-rotated).

## Architecture

```
src/
├── index.ts              # CLI entry point (setup/stop/status/test)
├── config.ts             # Paths and constants
├── certs.ts              # Certificate generation + Keychain management
├── dns.ts                # /etc/hosts manipulation
├── server.ts             # HTTPS server on port 443
├── router.ts             # Model-based request routing
├── logger.ts             # File + console logging with rotation
├── e2e-test.ts           # End-to-end integration test
├── providers/
│   ├── anthropic.ts      # Passthrough to real Anthropic API
│   └── gemini.ts         # Gemini Code Assist API + OAuth token management
└── translator/
    ├── messages.ts       # Anthropic ↔ Gemini message format conversion
    ├── streaming.ts      # Gemini SSE → Anthropic SSE streaming translation
    └── tools.ts          # Tool use ID generation + format helpers
```

### Translation layer

cmm translates between Anthropic Messages API and Gemini API formats in real-time:

- **Messages**: `messages[]` ↔ `contents[]` with role mapping
- **System prompts**: `system` ↔ `systemInstruction`
- **Tool use**: `tool_use`/`tool_result` ↔ `functionCall`/`functionResponse`
- **Streaming**: Gemini SSE chunks → Anthropic SSE events (`message_start`, `content_block_delta`, `message_stop`, etc.)
- **Thinking**: `thinking` blocks with `signature` field
- **Images**: Base64 `image` blocks ↔ `inlineData`
- **Schemas**: JSON Schema cleaning (whitelist approach for Gemini compatibility)

### Authentication

cmm uses Gemini CLI's existing OAuth credentials (`~/.gemini/oauth_creds.json`) — no separate API key needed. Tokens are automatically refreshed when expired.

## Runtime files

```
~/.cmm/
├── ca.key           # Root CA private key (chmod 600)
├── ca.crt           # Root CA certificate
├── server.key       # Server private key (chmod 600)
├── server.crt       # Server certificate (signed by CA)
├── cmm.pid          # PID file for running instance
├── cmm.log          # Request log (1 MB max)
└── anthropic-ip.cache  # Cached real IP of api.anthropic.com
```

## Security

- The Root CA private key is stored with `chmod 600` (owner-only read)
- `/etc/hosts` modification and port 443 binding require `sudo`
- `cmm stop` or `Ctrl+C` always restores `/etc/hosts` (SIGINT/SIGTERM handlers)
- Certificates are scoped to `api.anthropic.com` only
- OAuth client credentials are the same public values used by [Gemini CLI](https://github.com/google-gemini/gemini-cli) (open source)

## Troubleshooting

### `DEPTH_ZERO_SELF_SIGNED_CERT` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`

`NODE_EXTRA_CA_CERTS` is not set. Run `cmm setup` again or:

```bash
export NODE_EXTRA_CA_CERTS="$HOME/.cmm/ca.crt"
```

### `EACCES: permission denied, open '/etc/hosts'`

cmm needs root to modify `/etc/hosts` and bind to port 443:

```bash
sudo cmm <source> <target>
```

### `Port 443 is already in use`

Another cmm instance is running. Stop it first:

```bash
sudo cmm stop
```

### Gemini returns 401

OAuth token expired. cmm auto-retries once. If it persists, re-login to Gemini CLI:

```bash
gemini  # Re-authenticate
```

### Claude Code not connecting

Make sure you opened a **new terminal** after `cmm setup` (so `NODE_EXTRA_CA_CERTS` takes effect).

## License

MIT
