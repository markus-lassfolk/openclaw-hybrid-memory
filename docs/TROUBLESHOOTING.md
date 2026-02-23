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
| `invalid config: must NOT have additional properties` (plugin entry) | Newer OpenClaw validates plugin config using the plugin's `configSchema`; with `additionalProperties: false` any key not listed was rejected. | The plugin's `openclaw.plugin.json` now sets **`additionalProperties: true`** at the root of `configSchema` so the core accepts all config keys. The plugin still parses and validates config at runtime. If you see this error, ensure you're using a plugin version that has this change (copy `extensions/memory-hybrid/openclaw.plugin.json` from this repo to `~/.openclaw/extensions/openclaw-hybrid-memory/` or upgrade the plugin). |
| Agent doesn't answer chat / tools do nothing | Gateway down, plugin failed to load, or before_agent_start blocking | See [Agent not responding](#agent-not-responding--chat-or-tools-do-nothing) below. |

---

## Agent not responding / chat or tools do nothing

If your local OpenClaw agent does not answer chat messages or run tools, work through these steps.

### 1. Run plugin and config checks

```bash
openclaw hybrid-mem verify
openclaw hybrid-mem verify --fix   # apply safe fixes if offered
```

Fix any **load-blocking** issues (e.g. missing `embedding.apiKey` or `embedding.model`). If the plugin fails to load, OpenClaw may not start the agent correctly.

### 2. Ensure the gateway is running

The agent and all LLM/chat calls go through the OpenClaw gateway. If the gateway is stopped or unreachable, the agent will not respond.

```bash
openclaw gateway status    # or your OpenClaw equivalent
openclaw gateway start     # if not running
```

Do a **full restart** after any config or plugin change (required for native modules and config):

```bash
openclaw gateway stop
openclaw gateway start
```

### 3. Confirm memory slot and plugin load

In `~/.openclaw/openclaw.json` (or `OPENCLAW_HOME/openclaw.json`):

- `plugins.slots.memory` should be `"openclaw-hybrid-memory"` if you use this plugin.
- Under `plugins.entries["openclaw-hybrid-memory"]`: `enabled: true` and a valid `config` (including `embedding.apiKey` and `embedding.model` under `config`).

If the memory slot points to another plugin or the hybrid-memory plugin is disabled, the agent may still run but without this memory; wrong or broken config can prevent the plugin (and sometimes the agent) from loading.

### 4. If the agent still never responds: check before_agent_start

The plugin runs **auto-recall** in a `before_agent_start` hook. That hook calls the embedding API and, if HyDE is enabled, the LLM. If the gateway is down or those calls hang, the agent can appear stuck.

- **Temporarily disable auto-recall** to see if the agent starts answering:
  - In plugin config set `autoRecall.enabled` to `false`, then restart the gateway.
- If the agent works with auto-recall off, the problem is likely gateway/network or embedding/LLM config. Re-run `openclaw hybrid-mem verify` and fix embedding/API key issues; ensure the gateway is up and reachable (e.g. correct `OPENCLAW_GATEWAY_PORT` / `OPENCLAW_GATEWAY_TOKEN` if you use them).

### 5. Check logs

Inspect OpenClaw (or gateway) logs for errors when you send a message. Look for:

- Plugin registration errors (e.g. "embedding.apiKey is required", config parse errors).
- Gateway/connection errors (e.g. ECONNREFUSED, timeouts).
- Errors in `before_agent_start` or from the embedding/LLM calls (e.g. 401/403, timeout).

When **nothing relevant appears** (no timeout, no errors) but the agent still doesn’t respond, the turn may be **stuck** in the plugin’s `before_agent_start` (e.g. waiting on the gateway/LLM for HyDE or embeddings). As of recent plugin versions:

- You should see **`memory-hybrid: auto-recall start (prompt length N)`** when a message is processed. If you see that and never see a follow-up (e.g. "injecting N memories" or "vector step timed out"), the process is hanging inside auto-recall (HyDE, embedding, or vector search). The plugin now applies timeouts (HyDE/chat: 25s, vector step: 30s, chatComplete: 45s); if the gateway never responds, you should see a **timeout** log after that period.
- **Temporarily disable auto-recall** (`autoRecall.enabled: false`) or **HyDE** (`search.hydeEnabled: false`) and restart the gateway. If the agent starts responding, the hang was in that path (often gateway/LLM not responding). Re-enable after fixing the gateway or model config.

Log location depends on your OpenClaw setup (often under `~/.openclaw/` or wherever the gateway is run).

### 6. Provider cooldown / "All models failed"

If scheduled jobs or verify show **"Provider X is in cooldown"** or **"All models failed"**, the gateway may be rate-limiting or temporarily refusing that provider. Chat and tool calls that use the same provider will then fail or time out, so the agent appears not to respond.

- Run `openclaw hybrid-mem verify` and check the "Scheduled jobs" section for recent errors.
- In OpenClaw/gateway config, add a fallback model from another provider (e.g. OpenAI or OpenRouter) so the gateway can retry on cooldown.
- Wait for the cooldown to clear, or temporarily use a different default model in your agent config.

**Plugin `llm` and HyDE:** The plugin uses `llm.default` (and optional `llm.fallbackModel`) for HyDE and other LLM calls. Put a stable provider first so when one is in cooldown, the next is tried:
  - In plugin config set `llm.default` to an array with your preferred model first, e.g. `["google/gemini-2.5-flash", "anthropic/claude-opus-4-6"]`, and `llm.fallbackToDefault: true` (and optionally `llm.fallbackModel`) so the gateway can fall back.
  - Or set `search.hydeModel` to a single model that is rarely rate-limited (e.g. `google/gemini-2.5-flash`), so HyDE does not depend on the default chain.
  - To stop HyDE from using the failing provider at all, set `search.hydeEnabled: false` (recall still works with the raw prompt).

### 7. "HyDE generation failed, using raw prompt" (500, timeout, or "Request was aborted")

This usually means the LLM used for HyDE (query expansion) is failing—e.g. provider in cooldown, gateway 500, or the request timing out (you may see **"Request was aborted"** or **"Gateway/LLM timeout after 25000ms"**). The plugin falls back to the raw user prompt for vector search, so recall still works.

- **Fix:** Use the same options as in [Provider cooldown](#6-provider-cooldown--all-models-failed): set `llm.default` so a working model (e.g. Gemini) is first, or set `search.hydeModel` to a specific model (e.g. `google/gemini-2.5-flash`), or set `search.hydeEnabled: false` to skip HyDE.
- The plugin tries all models in `llm.default` (with retries) for HyDE before falling back to the raw prompt.
- **Log noise:** Retries no longer log per-attempt warnings; you see at most one "HyDE generation failed" per turn. If the auto-recall vector step times out (30s), HyDE is aborted and you won’t get a separate "HyDE generation failed" for that turn (only "vector step timed out, using FTS-only recall").
- **Check which models work:** Run `openclaw hybrid-mem verify --test-llm` (gateway must be running). Each configured default/heavy model is tested with a minimal completion; failures show the error (e.g. disallowed, timeout, 401).

### 8. "400 invalid model ID" when using HyDE or verify --test-llm

The OpenClaw gateway only accepts **model IDs that are in its catalog or allowlist**. If you see **400 invalid model ID** (or "model not allowed"), the IDs in your plugin config (e.g. `llm.default`, `llm.heavy`, `search.hydeModel`) are not recognized by the gateway.

- **Fix:** Use the **exact model IDs** your gateway accepts:
  1. Run **`openclaw models list`** (or **`openclaw models list --all`**) to see available models and their IDs (format is `provider/model`, e.g. `google/gemini-2.0-flash`, `anthropic/claude-sonnet-4-20250514`).
  2. Set **`llm.default`** and **`llm.heavy`** in the plugin config to arrays of those IDs (e.g. `["google/gemini-2.0-flash", "anthropic/claude-sonnet-4-20250514"]`).
  3. If your OpenClaw config has **`agents.defaults.models`** (allowlist), add the models you want the plugin to use to that allowlist so the gateway allows them for chat/completion.
- See OpenClaw docs: [Model providers](https://docs.openclaw.ai/concepts/model-providers), [Models](https://docs.openclaw.ai/concepts/models).
- **If 400 persists** even though `openclaw models list` shows the same IDs: the gateway’s chat-completions endpoint may validate models differently. Ensure the gateway is up to date and that `agents.defaults.models` (allowlist) includes every model you use in the plugin. - **Model ID format:** Use the same IDs as in `openclaw models list` (e.g. `google/gemini-2.5-flash`). The plugin passes the full `provider/model` id to the gateway.

---

## Temporarily disabling hybrid-memory for testing

To test OpenClaw **without** the hybrid-memory plugin (e.g. to isolate "invalid config" or "agent not responding" issues):

1. **Back up** your config: `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak`
2. **Switch the memory slot** to the built-in memory: in `~/.openclaw/openclaw.json`, set `plugins.slots.memory` to `"memory-core"` (instead of `"openclaw-hybrid-memory"`).
3. **Remove the plugin entry** (or set `enabled: false`): delete the `plugins.entries["openclaw-hybrid-memory"]` object entirely so OpenClaw no longer loads or validates that plugin config. Leave `plugins.installs["openclaw-hybrid-memory"]` if you want to re-enable later without reinstalling.
4. **Restart the gateway:** `openclaw gateway stop && openclaw gateway start`

**Re-enabling:** Restore from backup (`cp ~/.openclaw/openclaw.json.bak ~/.openclaw/openclaw.json`) and restart the gateway. If you get `invalid config: must NOT have additional properties` again, the new OpenClaw may be validating plugin config strictly; you may need to wait for a plugin or OpenClaw release that aligns the config schema, or try re-adding only the minimal required keys (`embedding`, `enabled`) under `config` and see if the core accepts that.

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
