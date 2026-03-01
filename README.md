# cmm — Claude Model Mapping

[![npm](https://img.shields.io/npm/v/claude-model-mapping)](https://www.npmjs.com/package/claude-model-mapping)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**[Documentation](https://cmm.erdinc.curebal.dev)** | **[npm](https://www.npmjs.com/package/claude-model-mapping)** | **[GitHub](https://github.com/erdinccurebal/claude-model-mapping)**

Transparent OS-level interception for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Redirect any Claude model to CLIProxyAPI without modifying Claude Code itself.

```
sudo cmm claude-haiku-4-5 gemini-2.5-flash
```

That's it. Open Claude Code normally — haiku requests go to CLIProxyAPI, everything else passes through untouched.

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
│  model matches source?           │
│    YES → CLIProxyAPI (:8317)     │
│    NO  → Real api.anthropic.com  │
└──────────────────────────────────┘
```

1. `/etc/hosts` redirects `api.anthropic.com` to `127.0.0.1`
2. cmm runs a local HTTPS server on port 443 with a trusted self-signed certificate
3. Incoming requests are routed by model name:
   - **Matched model** → forwarded to CLIProxyAPI on localhost:8317
   - **Other models** → forwarded to real Anthropic API using cached IP

Claude Code sees normal Anthropic API responses. No env vars, no config changes, no patches.

## Prerequisites

- **macOS** (uses Keychain for certificate trust)
- **Node.js 18+**
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** installed and logged in
- **CLIProxyAPI** running on localhost:8317

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

# Or with defaults configured:
cmm config set DEFAULT_SOURCE_MODEL claude-haiku-4-5
cmm config set DEFAULT_TARGET_MODEL gemini-2.5-flash
sudo cmm
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

### Configure proxy settings

Manage CLIProxyAPI connection settings stored in `~/.cmm/.env` without editing the file manually.

```bash
# List all settings
cmm config list

# Get a single value
cmm config get PROXY_API_KEY

# Set a value
cmm config set PROXY_API_KEY sk-abc123

# Delete a value (reverts to default)
cmm config delete PROXY_URL
```

Available keys:

| Key | Default | Description |
|---|---|---|
| `PROXY_API_KEY` | *(empty)* | API key for CLIProxyAPI |
| `PROXY_URL` | `http://localhost:8317/v1/messages` | CLIProxyAPI endpoint URL (supports http/https) |
| `DEFAULT_SOURCE_MODEL` | *(empty)* | Default source model (allows running `sudo cmm` with no args) |
| `DEFAULT_TARGET_MODEL` | *(empty)* | Default target model |

### Uninstall

```bash
sudo cmm uninstall
```

Removes certificates, Keychain entry, `NODE_EXTRA_CA_CERTS` from `.zshrc`, and the `~/.cmm` directory.

## What gets intercepted?

| Request model | Behavior | Destination |
|---|---|---|
| Matches `<source-model>*` | **INTERCEPTED** | CLIProxyAPI (target model) |
| Everything else | **PASSTHROUGH** | Real api.anthropic.com |

Non-messages endpoints (`/v1/models`, `/api/oauth/*`, etc.) always pass through.

### Verifying interception

Intercepted responses include an `x-cmm-provider: cliproxyapi` header. You can check it in logs or with `curl`:

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
[2026-02-28 18:01:32] claude-opus-4-6              → PASSTHROUGH ✓
[2026-02-28 18:01:45] claude-haiku-4-5-20251001    → INTERCEPTED → gemini-2.5-flash ✓
[2026-02-28 18:02:01] GET /v1/models               → PASSTHROUGH
```

Logs are also written to `~/.cmm/cmm.log` (1 MB max, auto-rotated with 3 backups).

## Architecture

```
src/
├── index.ts              # CLI entry point (setup/stop/status/test)
├── config.ts             # Paths, constants, and proxy settings
├── types.ts              # Anthropic API type definitions
├── certs.ts              # Certificate generation + Keychain management
├── dns.ts                # /etc/hosts manipulation
├── server.ts             # HTTPS server on port 443
├── router.ts             # Model-based request routing
├── logger.ts             # File + console logging with rotation
├── e2e-test.ts           # End-to-end integration test
└── providers/
    ├── anthropic.ts      # Passthrough to real Anthropic API
    └── proxy.ts          # CLIProxyAPI handler (streaming + non-streaming)
```

## Runtime files

```
~/.cmm/
├── ca.key           # Root CA private key (chmod 600)
├── ca.crt           # Root CA certificate
├── server.key       # Server private key (chmod 600)
├── server.crt       # Server certificate (signed by CA)
├── .env             # Proxy configuration (chmod 600)
├── cmm.pid          # PID file for running instance
├── cmm.log          # Request log (1 MB max, 3 backups)
└── anthropic-ip.cache  # Cached real IP of api.anthropic.com
```

## Security

- The Root CA private key is stored with `chmod 600` (owner-only read)
- `/etc/hosts` modification and port 443 binding require `sudo`
- `cmm stop` or `Ctrl+C` always restores `/etc/hosts` (SIGINT/SIGTERM handlers)
- Certificates are scoped to `api.anthropic.com` only

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

### CLIProxyAPI connection refused

Make sure CLIProxyAPI is running on localhost:8317.

### Claude Code not connecting

Make sure you opened a **new terminal** after `cmm setup` (so `NODE_EXTRA_CA_CERTS` takes effect).

## License

MIT
