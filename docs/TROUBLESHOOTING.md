---
layout: default
title: Troubleshooting
parent: Operations & Maintenance
nav_order: 8
---
# Troubleshooting

Common issues, causes, and fixes for the memory-hybrid plugin.

---

## Quick diagnostics

```bash
openclaw hybrid-mem verify        # check config, DBs, API key
openclaw hybrid-mem verify --fix  # apply safe auto-fixes
openclaw hybrid-mem stats         # show fact/vector counts
```

---

## Install warning: "dangerous code patterns" / "credential harvesting"

When you run `openclaw plugins install openclaw-hybrid-memory`, the OpenClaw plugin scanner may show:

```text
WARNING: Plugin "openclaw-hybrid-memory" contains dangerous code patterns: Environment variable access combined with network send — possible credential harvesting
```

This is a **false positive**. The plugin only uses your OpenAI API key to call OpenAI’s embedding API; it does not send credentials anywhere else. The scanner flags any plugin that both reads environment variables (e.g. for config) and performs network requests. You can ignore this warning and continue. To use your key from the environment, set `embedding.apiKey` in config to `"${OPENAI_API_KEY}"` (see [CONFIGURATION.md](CONFIGURATION.md)).

---

## Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| memory-hybrid disabled / "memory slot set to memory-core" | Slot not set | Set `plugins.slots.memory` to `"openclaw-hybrid-memory"` in `openclaw.json` |
| Plugin fails to load / "embedding.apiKey is required" | No OpenAI key in config | Add `embedding.apiKey` and `embedding.model` to plugin config. See [CONFIGURATION.md](CONFIGURATION.md). |
| Invalid or expired API key | Key wrong, revoked, or out of credits | First embed or `verify` will fail with 401/403. Fix the key and restart. |
| Missing env var for API key | Env not loaded in non-interactive shell | Inline key in config or ensure env is set for the process |
| `Cannot find module '@lancedb/lancedb'`, `better-sqlite3`, or `@sinclair/typebox` | Extension deps not installed, or OpenClaw was upgraded | Run `npm install` in the extension dir: `cd ~/.openclaw/extensions/openclaw-hybrid-memory && npm install`. See [QUICKSTART.md](QUICKSTART.md); after upgrades run post-upgrade ([MAINTENANCE.md](MAINTENANCE.md)). Full gateway stop/start. |
| Recall/capture failed after npm install | Stale module cache from SIGUSR1 reload | **Full stop then start** (`openclaw gateway stop` then `start`). Required for native modules. |
| Bootstrap file truncation | Limits too low | Increase `bootstrapMaxChars` (15000) and `bootstrapTotalMaxChars` (50000). See [CONFIGURATION.md](CONFIGURATION.md). |
| config.patch reverts API key to `${ENV_VAR}` | Gateway tool substitutes secrets | Edit config file directly for API keys |
| Prompt too large for model | Need lower cap | Set `contextTokens` to ~90% of your model's window |
| Memory files not found by search | File index stale | Ensure `sync.onSessionStart: true` and `sync.watch: true`; restart and start a new session |
| `hybrid-mem stats` still 0 after seed | Seed used wrong paths or schema | Point seed at same DB paths as plugin |
| `npm install` fails ("openclaw": "workspace:*") | devDependencies reference workspace protocols | Remove devDependencies: `node -e "let p=require('./package.json'); delete p.devDependencies; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))"` then `npm install` |
| `openclaw plugin install` fails or does nothing (singular "plugin") | The correct command uses **plugins** (plural) | Use **`openclaw plugins install`** (plural). See [issue #36](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/36). |
| "plugin not found: openclaw-hybrid-memory" (blocks `plugins install`) | Config references the plugin but folder is missing | Use a standalone installer: `npx -y openclaw-hybrid-memory-install` or `curl -sSL https://raw.githubusercontent.com/markus-lassfolk/openclaw-hybrid-memory/main/scripts/install.sh \| bash`. See [UPGRADE-PLUGIN.md](UPGRADE-PLUGIN.md#when-plugin-not-found-blocks-install). |
| "duplicate plugin id detected" / two copies of memory-hybrid | Plugin exists in both global openclaw and ~/.openclaw/extensions | Use NPM only: run `./scripts/use-npm-only.sh` (from this repo) to remove the global copy. Then use `openclaw plugins install openclaw-hybrid-memory` for upgrades. See [UPGRADE-PLUGIN.md](UPGRADE-PLUGIN.md#using-npm-only-recommended). |
| Could not locate bindings file (better_sqlite3.node) | Native module not built after install or rebuild was interrupted | Run `cd ~/.openclaw/extensions/openclaw-hybrid-memory && npm rebuild better-sqlite3 @lancedb/lancedb`, then `openclaw gateway stop && openclaw gateway start`. If `npm rebuild` exits non-zero (e.g. node-gyp `node_gyp_bins` ENOENT on Node 25), check whether `node_modules/better-sqlite3/build/Release/better_sqlite3.node` exists — if it does, restarting the gateway may be enough. The published package runs rebuild in `postinstall`; ensure build tools (e.g. `build-essential`, `python3`) are installed. |
| "Unrecognized keys: autoCapture, autoRecall, embedding" | Config keys placed at wrong nesting level | Move those keys under `config`. Correct structure: `plugins.entries["openclaw-hybrid-memory"]` = `{ enabled: true, config: { autoCapture, autoRecall, embedding, ... } }`. See [Config nesting](#config-nesting) below. |

---

## Config nesting

If you see an error like **"Unrecognized keys: autoCapture, autoRecall, embedding"**, the plugin config is at the wrong nesting level.

**Wrong** (keys directly under the plugin entry):

```json
"openclaw-hybrid-memory": {
  "enabled": true,
  "autoCapture": true,
  "autoRecall": true,
  "embedding": { "apiKey": "...", "model": "text-embedding-3-small" }
}
```

**Correct** (keys nested under `config`):

```json
"openclaw-hybrid-memory": {
  "enabled": true,
  "config": {
    "autoCapture": true,
    "autoRecall": true,
    "embedding": { "apiKey": "...", "model": "text-embedding-3-small" }
  }
}
```

Move `autoCapture`, `autoRecall`, `embedding`, and any other plugin settings into `plugins.entries["openclaw-hybrid-memory"].config`. See [CONFIGURATION.md](CONFIGURATION.md).

---

## API key detection and behaviour

### At config load

If `embedding.apiKey` is missing or not a string, the plugin throws and does not register. You must supply a key.

### At runtime

Embeddings are used for vector search, auto-recall, store, consolidate, and find-duplicates. If the key is invalid or the API fails (401, 403, network):

- Those operations log a warning and skip or return empty
- Auto-recall falls back to FTS-only
- Store skips the vector write
- SQLite-only paths (lookup, FTS search, prune, stats) still work

### Detection

Run `openclaw hybrid-mem verify` — it checks for a non-placeholder key and calls the embedding API once. If invalid, verify reports "Embedding API: FAIL".

### Failover

The plugin does **not** support automatic failover to another provider. All embeddings and LLM calls use the configured OpenAI key only.

---

## Related docs

- [FAQ.md](FAQ.md) — Quick answers to common questions
- [QUICKSTART.md](QUICKSTART.md) — Installation
- [CONFIGURATION.md](CONFIGURATION.md) — Full config reference
- [OPERATIONS.md](OPERATIONS.md) — Background jobs, scripts, upgrades
- [CLI-REFERENCE.md](CLI-REFERENCE.md) — All CLI commands
- [CREDENTIALS.md](CREDENTIALS.md) — Credential vault troubleshooting
- [WAL-CRASH-RESILIENCE.md](WAL-CRASH-RESILIENCE.md) — Write-ahead log design
