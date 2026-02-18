# openclaw-hybrid-memory-install

Standalone installer for the [openclaw-hybrid-memory](https://www.npmjs.com/package/openclaw-hybrid-memory) plugin. Use when OpenClaw config validation fails (e.g. "plugin not found" because the plugin folder is missing).

## Usage

```bash
# Install latest
npx -y openclaw-hybrid-memory-install

# Install specific version
npx -y openclaw-hybrid-memory-install 2026.2.176
```

## When to use

- You see `plugin not found: openclaw-hybrid-memory` and `openclaw plugins install` fails
- The plugin folder was removed or corrupted
- You want to install without using the OpenClaw CLI

## What it does

1. Removes any existing plugin at `~/.openclaw/extensions/openclaw-hybrid-memory`
2. Fetches the package via `npm pack`
3. Extracts and runs `npm install` (with postinstall rebuild)
4. Prints instructions to restart the gateway

## Environment

- `OPENCLAW_EXTENSIONS_DIR` — Override the extensions directory (default: `~/.openclaw/extensions`)

## Alternative: curl install

```bash
curl -sSL https://raw.githubusercontent.com/markus-lassfolk/openclaw-hybrid-memory/main/scripts/install.sh | bash
```
