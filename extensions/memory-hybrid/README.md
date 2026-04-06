# OpenClaw `memory-hybrid` plugin (npm: `openclaw-hybrid-memory`)

This folder is the **published OpenClaw extension**: durable agent memory (structured store + semantic recall, auto-capture / auto-recall, configurable decay and maintenance, optional graph and credential vault).

**User-facing overview, scenarios, and install:** [Repository README](https://github.com/markus-lassfolk/openclaw-hybrid-memory#readme) · **[Documentation site](https://markus-lassfolk.github.io/openclaw-hybrid-memory/)** · [Quick start](https://github.com/markus-lassfolk/openclaw-hybrid-memory/blob/main/docs/QUICKSTART.md)

---

## Install & verify

```bash
openclaw plugins install openclaw-hybrid-memory
openclaw hybrid-mem install
# Configure embedding (required) in ~/.openclaw/openclaw.json — see LLM-AND-PROVIDERS.md
openclaw gateway stop && openclaw gateway start
openclaw hybrid-mem verify
```

Upgrade: `openclaw hybrid-mem upgrade` (then restart the gateway).

---

## Requirements (short)

| Requirement | Notes |
|-------------|--------|
| **Node.js** | `>=22.12.0` (`engines` in `package.json`) |
| **OpenClaw** | v2026.3.8+ (peer); current 2026.3.x recommended |
| **Embeddings** | Required — OpenAI, Ollama, ONNX, or Google; see [LLM-AND-PROVIDERS.md](../../docs/LLM-AND-PROVIDERS.md) |
| **Build toolchain** | For `@lancedb/lancedb`: C++ build tools + Python 3 on the install machine |

---

## Agent tools

All tools use **underscore** names (`memory_store`, `memory_recall`, …). Dotted aliases are invalid for some providers.

---

## Package layout

| Path | Role |
|------|------|
| `openclaw.plugin.json` | Manifest and config schema |
| `index.ts` | Plugin entry: stores, tools, CLI, lifecycle |
| `config.ts` | Defaults and config parsing |
| `backends/` | SQLite, LanceDB, event bus, etc. |
| `tools/` | Tool implementations and dashboard routes |
| `cli/` | `hybrid-mem` commands |
| `skills/hybrid-memory/` | Bundled Agent Skill (`SKILL.md` + references); copied to `{workspace}/skills/hybrid-memory/` on **first plugin start** if absent (or use `hybrid-mem install` to refresh) |

---

| File | Description |
|------|-------------|
| `package.json` | npm package and OpenClaw extension entry |
| `openclaw.plugin.json` | Plugin manifest and config schema |
| `config.ts` | Decay classes, TTL defaults, config parsing (incl. autoRecall, store, etc.) |
| `index.ts` | Plugin implementation (SQLite+FTS5, LanceDB, tools, CLI, lifecycle) |
| `versionInfo.ts` | Plugin and memory-manager version metadata |
| `backends/event-bus.ts` | Event Bus — append-only `memory_events` SQLite table for sensor → Rumination Engine pipeline |
| `tools/dashboard-routes.ts` | Dashboard HTTP route registration — registers all `/plugins/memory-dashboard/*` routes with consistent auth (Issue #279) |
| `tools/public-api-routes.ts` | Public API surface routes (`/plugins/memory-public/*`) for health/search/timeline/stats/export/fact (Issue #1027) |
| `services/public-export-bundle.ts` | Stable export bundle builder used by `GET /plugins/memory-public/export` (Issue #1027) |

| Topic | Doc |
|--------|-----|
| Full config | [CONFIGURATION.md](../../docs/CONFIGURATION.md) |
| CLI | [CLI-REFERENCE.md](../../docs/CLI-REFERENCE.md) |
| Architecture | [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) |
| Event bus API | [docs/event-bus.md](docs/event-bus.md) |
| Retrieval / RRF | [docs/rrf-retrieval.md](docs/rrf-retrieval.md), [RETRIEVAL-MODES.md](../../docs/RETRIEVAL-MODES.md) |
| Graph / contacts | [GRAPH-MEMORY.md](../../docs/GRAPH-MEMORY.md) |
| ONNX embeddings | [README](#local-onnx-embeddings-optional) below |

### Local ONNX embeddings (optional)

## Entity layer (contacts, organizations, NER)

When **`graph.enabled`** is true, new facts are enriched asynchronously with **PERSON** and **ORG** mentions (language hint via **franc**, extraction via LLM). Data lives in SQLite (`organizations`, `contacts`, `fact_entity_mentions`, `org_fact_links`). The **`memory_directory`** tool exposes **`list_contacts`** and **`org_view`** for structured lists—use **`memory_recall`** for ranked semantic search. Backfill older facts with **`openclaw hybrid-mem enrich-entities`**. See [GRAPH-MEMORY.md](../../docs/GRAPH-MEMORY.md#person-and-organization-enrichment-entity-layer) and [MULTILINGUAL-SUPPORT.md](../../docs/MULTILINGUAL-SUPPORT.md).

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

## Public API HTTP Routes

`tools/public-api-routes.ts` registers a compact, beginner-friendly REST surface under `/plugins/memory-public/`:

| Route | Description |
|-------|-------------|
| `GET /plugins/memory-public/health` | API surface health + version metadata |
| `GET /plugins/memory-public/search?q=<query>&limit=<n>` | Simple full-text memory search |
| `GET /plugins/memory-public/timeline?limit=<n>` | Reverse-chronological memory timeline |
| `GET /plugins/memory-public/stats` | Core memory stats (facts/episodes/procedures/links) |
| `GET /plugins/memory-public/export` | Stable JSON export bundle (facts, episodes, procedures, narratives, provenance) |
| `GET /plugins/memory-public/fact?id=<uuid>` | Inspect a single fact plus incoming/outgoing links |

Routes use the same `health.authenticated` setting to keep auth behavior consistent per prefix.

See `docs/PUBLIC-API-SURFACE.md` for demo flows and payload shape details.


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

Then set `embedding.provider: "onnx"` in plugin config. See repository [TROUBLESHOOTING.md](../../docs/TROUBLESHOOTING.md) if loading fails.

### Recall timing diagnostics

Optional `autoRecall.recallTiming` (`off` | `basic` | `verbose`) — see [INTERACTIVE-RECALL-LATENCY.md](../../docs/INTERACTIVE-RECALL-LATENCY.md) and [CONFIGURATION.md](../../docs/CONFIGURATION.md).

---

## Credits

Design lineage and a full list of extensions in this repo: [CREDITS-AND-ATTRIBUTION.md](../../docs/CREDITS-AND-ATTRIBUTION.md). Based on [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory) (Clawdboss.ai).
