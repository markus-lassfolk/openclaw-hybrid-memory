# OpenClaw memory-hybrid plugin

Your OpenClaw agent forgets after each session. This plugin gives it **lasting memory**: structured facts (SQLite + FTS5) and semantic search (LanceDB), with auto-capture, auto-recall, TTL-based decay, **dynamic memory tiering (hot/warm/cold)**, LLM auto-classification, graph-based spreading activation for zero-LLM recall, and an optional credential vault. **Progressive disclosure** lets you inject a lightweight memory index instead of full texts—the agent uses `memory_recall` to fetch only what it needs, saving tokens. One install, one config—then your agent remembers preferences, decisions, and context across conversations.

Part of the [OpenClaw Hybrid Memory](https://github.com/markus-lassfolk/openclaw-hybrid-memory) v3 deployment.

**Repository:** [GitHub](https://github.com/markus-lassfolk/openclaw-hybrid-memory) · **Docs:** [Quick Start](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/QUICKSTART.md) · [README](https://github.com/markus-lassfolk/openclaw-hybrid-memory#quick-start)

## Requirements

- **Node.js `^20.19.0 || >=22.12.0`** — Node 20.0–20.18 and 22.0–22.11 are **not** supported; npm will reject the install with `EBADENGINE` on those versions.
- **OpenClaw v2026.3.8+** (required) — the plugin enforces this minimum version at startup to ensure CLI subcommands and config reloads work.
- **Embedding provider** — Required. The plugin needs an embedding provider to load. Four options:
  - **OpenAI** (default): set `embedding.apiKey` and `embedding.model` (e.g. `text-embedding-3-small`). Requires an OpenAI API key.
  - **Ollama** (local): set `embedding.provider: "ollama"` and `embedding.model` (e.g. `nomic-embed-text`). No API key required — runs fully locally via a local Ollama instance.
  - **ONNX** (local): set `embedding.provider: "onnx"` and `embedding.model` (e.g. `all-MiniLM-L6-v2`). Fully local; models auto-downloaded from HuggingFace. Requires `onnxruntime-node` (`npm i onnxruntime-node`).
  - **Google** (Gemini API): set `embedding.provider: "google"`, `embedding.model: "text-embedding-004"`, `embedding.dimensions: 768`, and `llm.providers.google.apiKey`.
  
  Use `embedding.preferredProviders` (e.g. `["ollama", "openai"]`) for automatic ordered failover between providers. Optional features (auto-classify, summarize, consolidate, **memory classification**) use a chat model (e.g. `gpt-4o-mini`). With `store.classifyBeforeWrite: true`, new facts are classified as ADD/UPDATE/DELETE/NOOP against similar existing facts before storing; reduces duplicates and stale contradictions. Applies to the `memory_store` tool, auto-capture, CLI `hybrid-mem store`, and `extract-daily`. **Maintenance cron jobs and self-correction spawn** use a model chosen from your config (Gemini / OpenAI / Claude)—no hardcoded model names. See [CONFIGURATION.md](../../docs/CONFIGURATION.md) and [LLM-AND-PROVIDERS.md](../../docs/LLM-AND-PROVIDERS.md#embedding-providers) and [TROUBLESHOOTING.md](../../docs/TROUBLESHOOTING.md).
- **Build tools** for `@lancedb/lancedb`: C++ toolchain (e.g. `build-essential` on Linux, Visual Studio Build Tools on Windows), Python 3.

## Installation

**1. Install the plugin** (OpenClaw installs to `~/.openclaw/extensions` and runs `npm install`; a `postinstall` script rebuilds `@lancedb/lancedb` for your platform if needed):

```bash
openclaw plugins install openclaw-hybrid-memory
```

If you see **"duplicate plugin id detected"**, remove the global copy once so only the NPM copy is used: run `./scripts/use-npm-only.sh` from the [repo root](https://github.com/markus-lassfolk/openclaw-hybrid-memory). Then use `openclaw hybrid-mem upgrade` for upgrades.

**Upgrade to latest** — One command, no fighting:

```bash
openclaw hybrid-mem upgrade
```

Then restart the gateway. The upgrade command removes the current install, fetches the latest from npm, rebuilds native deps, and tells you to restart.

Outdated installs now check the latest published plugin version in the background. If your local version falls behind, the plugin mutes GlitchTip telemetry for that client and logs an upgrade reminder. You can tune reminder behavior with `errorReporting.updateNudge.enabled`, `errorReporting.updateNudge.intervalHours`, and `errorReporting.updateNudge.cacheTtlHours`.

Or with npm directly: `npm i openclaw-hybrid-memory` in your OpenClaw extensions folder if you manage it yourself.

**2. Configure.** Set your OpenAI API key and enable the plugin. Easiest: run `openclaw hybrid-mem install` to merge full defaults (memory slot, compaction prompts, nightly session-distillation job) into `~/.openclaw/openclaw.json`, then set `plugins.entries["openclaw-hybrid-memory"].config.embedding.apiKey` to your key.

**3. Restart the gateway** and run **`openclaw hybrid-mem verify [--fix]`** to confirm SQLite, LanceDB, and the embedding API. Use `--fix` to add any missing config (e.g. embedding block, nightly job).

**More options:** [Quick Start](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/QUICKSTART.md) and [Configuration](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/CONFIGURATION.md) (manual config merge, from-source install).

## Files in this directory

| File | Description |
|------|-------------|
| `package.json` | npm package and OpenClaw extension entry |
| `openclaw.plugin.json` | Plugin manifest and config schema |
| `config.ts` | Decay classes, TTL defaults, config parsing (incl. autoRecall, store, etc.) |
| `index.ts` | Plugin implementation (SQLite+FTS5, LanceDB, tools, CLI, lifecycle) |
| `versionInfo.ts` | Plugin and memory-manager version metadata |
| `backends/event-bus.ts` | Event Bus — append-only `memory_events` SQLite table for sensor → Rumination Engine pipeline |
| `tools/dashboard-routes.ts` | Dashboard HTTP route registration — registers all `/plugins/memory-dashboard/*` routes with consistent auth (Issue #279) |

## Event Bus

`backends/event-bus.ts` adds an **Event Bus**: an append-only `memory_events` SQLite table that decouples sensor sweeps (producers) from the Rumination Engine (consumer).

Key API:

| Method | Description |
|--------|-------------|
| `appendEvent(type, source, payload, importance?, fingerprint?)` | Append a new event; returns its auto-generated id |
| `queryEvents(filter?)` | Filter by `status`, `event_type`, `since`, `limit` |
| `updateStatus(id, newStatus)` | Advance an event through the status lifecycle |
| `dedup(fingerprint, cooldownHours?)` | Return `true` if a duplicate exists within the cooldown window |
| `pruneArchived(olderThanDays?)` | Delete archived events older than N days |

Status lifecycle: `raw → processed → surfaced → pushed → archived`

`computeFingerprint(input)` is a SHA-256 helper for building stable dedup keys.

See [`docs/event-bus.md`](docs/event-bus.md) for the full schema, API reference, and integration example.

## Dashboard HTTP Routes

`tools/dashboard-routes.ts` registers two HTTP routes under the `/plugins/memory-dashboard/` prefix:

| Route | Description |
|-------|-------------|
| `GET /plugins/memory-dashboard/` | HTML dashboard shell |
| `GET /plugins/memory-dashboard/api/health` | JSON health report (`{ status, generatedAt }`) |

Routes are only registered when `health.enabled` is `true` (the default). OpenClaw v2026.3.8 enforces a **consistent-auth requirement**: every route under the same path prefix must use the same `authenticated` value. `dashboard-routes.ts` satisfies this by reading `cfg.health.authenticated` once and applying it to all routes via a single shared `routeOpts` object.

**Config field:** `health.authenticated` (boolean, default `true`) — controls whether dashboard routes require an authenticated session. Set to `false` only if you intentionally want unauthenticated access.

```json
"health": {
  "enabled": true,
  "authenticated": true
}
```

## Lifecycle & Shutdown

The plugin registers `SIGUSR1` / `SIGUSR2` signal handlers to close all database connections cleanly on process shutdown:

```typescript
import { closeAllDatabases } from "./backends/base-sqlite-store";

// Called automatically on SIGUSR1/SIGUSR2, or invoke manually:
await closeAllDatabases();
```

All stores (`FactsDB`, `CredentialsDB`, `EventBus`, etc.) implement a `close()` method that:
- Flushes pending writes
- Closes the SQLite connection
- Prevents further operations (throws `"<StoreName> is closed"` if accessed afterward)

The `EventBus` additionally enters a terminal `closed` state after `close()` is called — any subsequent `appendEvent()` call throws `"EventBus is closed"`.

## Dependencies

- Built-in `node:sqlite` (ships with supported Node.js versions)
- `@lancedb/lancedb` ^0.26.2
- `@sinclair/typebox` 0.34.48
- `openai` ^6.16.0 — **peer dependency (must be directly provided by the host)**. The `openai` package is not bundled with this plugin. Your host environment must directly declare and install `openai ^6.16.0` — a transitive copy (e.g. one pulled in via a sub-dependency of OpenClaw) is **not** sufficient under pnpm, Yarn PnP, or other strict package managers. Install it explicitly alongside this plugin: `npm i openai`.

Build tools required for `@lancedb/lancedb`: C++ toolchain (e.g. `build-essential` on Linux, Visual Studio Build Tools on Windows), Python 3.

## Local ONNX Embeddings (optional)

For local embedding inference without an API key, install `onnxruntime-node` into the **OpenClaw extensions folder** (`~/.openclaw/extensions`) — one level above the plugin package — so that it survives `openclaw hybrid-mem upgrade`:

```bash
npm install --prefix ~/.openclaw/extensions onnxruntime-node@^1.18.0
```

Installing at this level means Node's module resolution finds it by traversing up from the plugin directory, and the ~513 MB binary is not removed when the plugin is reinstalled. If you install it inside the plugin's own directory (`~/.openclaw/extensions/openclaw-hybrid-memory`) instead, you will need to re-run the install after each upgrade.

Then set `embedding.provider: "onnx"` in your plugin config. Models are auto-downloaded from HuggingFace on first use. `onnxruntime-node` is not listed as a dependency of this package — it is a ~513 MB optional native binary that most users do not need. The plugin detects its absence and shows a clear error if you configure the `onnx` provider without installing it.

## Credits

Based on the design in **[Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory)** (Clawdboss.ai). The plugin has since been extended with auto-capture, auto-recall, decay/TTL, auto-classify, token caps, consolidation, verify/uninstall CLI, and more — see the [repo README](../../README.md) and [docs/](../../docs/).
