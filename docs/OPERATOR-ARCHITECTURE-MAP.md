---
layout: default
title: Operator Architecture Map
parent: Operations & Maintenance
nav_order: 3
---
# Operator Architecture Map (Minimal)

One-page operator view of what runs where, where data lives, and where to look first during incidents.

---

## Core components

| Component | Responsibility | Primary implementation |
|---|---|---|
| Plugin runtime | Bootstraps config, backends, tools, lifecycle hooks | [`../extensions/memory-hybrid/index.ts`](../extensions/memory-hybrid/index.ts), [`../extensions/memory-hybrid/setup/register-plugin.ts`](../extensions/memory-hybrid/setup/register-plugin.ts), [`../extensions/memory-hybrid/setup/bootstrap-databases.ts`](../extensions/memory-hybrid/setup/bootstrap-databases.ts) |
| Structured store (SQLite + FTS5) | Durable fact rows, structured lookups, full-text search | [`../extensions/memory-hybrid/backends/facts-db.ts`](../extensions/memory-hybrid/backends/facts-db.ts), [`../extensions/memory-hybrid/backends/facts-db/crud.ts`](../extensions/memory-hybrid/backends/facts-db/crud.ts), [`../extensions/memory-hybrid/backends/facts-db/search.ts`](../extensions/memory-hybrid/backends/facts-db/search.ts) |
| Semantic store (LanceDB) | Vector indexing/search for semantic recall | [`../extensions/memory-hybrid/backends/vector-db.ts`](../extensions/memory-hybrid/backends/vector-db.ts), [`../extensions/memory-hybrid/backends/vector-db/vector-db-class.ts`](../extensions/memory-hybrid/backends/vector-db/vector-db-class.ts) |
| Retrieval orchestration | Multi-strategy recall (FTS + semantic + graph), fusion/ranking, token packing | [`../extensions/memory-hybrid/services/retrieval-orchestrator.ts`](../extensions/memory-hybrid/services/retrieval-orchestrator.ts), [`../extensions/memory-hybrid/services/rrf-fusion.ts`](../extensions/memory-hybrid/services/rrf-fusion.ts) |
| Lifecycle stages | Turn-time recall, injection, capture, cleanup | [`../extensions/memory-hybrid/lifecycle/stage-recall.ts`](../extensions/memory-hybrid/lifecycle/stage-recall.ts), [`../extensions/memory-hybrid/lifecycle/stage-injection.ts`](../extensions/memory-hybrid/lifecycle/stage-injection.ts), [`../extensions/memory-hybrid/lifecycle/stage-capture.ts`](../extensions/memory-hybrid/lifecycle/stage-capture.ts) |
| Crash resilience (WAL) | Pre-commit write-ahead log + replay on startup | [`../extensions/memory-hybrid/backends/wal.ts`](../extensions/memory-hybrid/backends/wal.ts), [`../extensions/memory-hybrid/utils/wal-replay.ts`](../extensions/memory-hybrid/utils/wal-replay.ts), [`../extensions/memory-hybrid/services/wal-helpers.ts`](../extensions/memory-hybrid/services/wal-helpers.ts) |
| Health/ops surfaces | Verify/doctor/status/health/dashboard and storage maintenance CLI | [`../extensions/memory-hybrid/cli/verify.ts`](../extensions/memory-hybrid/cli/verify.ts), [`../extensions/memory-hybrid/cli/cmd-status.ts`](../extensions/memory-hybrid/cli/cmd-status.ts), [`../extensions/memory-hybrid/cli/cmd-health.ts`](../extensions/memory-hybrid/cli/cmd-health.ts), [`../extensions/memory-hybrid/cli/commands/manage/register-storage-maintenance.ts`](../extensions/memory-hybrid/cli/commands/manage/register-storage-maintenance.ts), [`../extensions/memory-hybrid/routes/dashboard/server.ts`](../extensions/memory-hybrid/routes/dashboard/server.ts) |

---

## Data flows

### 1) Write path (capture/tool store)

```text
agent/tool output
  -> capture filters + dedupe policy
  -> WAL write (if enabled)
  -> SQLite fact write/update
  -> LanceDB vector write/update
  -> WAL cleanup
```

Primary modules:
- [`../extensions/memory-hybrid/lifecycle/stage-capture.ts`](../extensions/memory-hybrid/lifecycle/stage-capture.ts)
- [`../extensions/memory-hybrid/backends/facts-db/crud.ts`](../extensions/memory-hybrid/backends/facts-db/crud.ts)
- [`../extensions/memory-hybrid/backends/wal.ts`](../extensions/memory-hybrid/backends/wal.ts)

### 2) Read path (turn-time recall)

```text
user prompt
  -> embed query
  -> FTS search + vector search (+ optional graph/aliases)
  -> RRF fusion + rerank + budget pack
  -> inject memory context before agent turn
```

Primary modules:
- [`../extensions/memory-hybrid/lifecycle/stage-recall.ts`](../extensions/memory-hybrid/lifecycle/stage-recall.ts)
- [`../extensions/memory-hybrid/services/retrieval-orchestrator.ts`](../extensions/memory-hybrid/services/retrieval-orchestrator.ts)

### 3) Maintenance/consistency path

```text
scheduled jobs + operator CLI
  -> prune/compact/re-index/reconcile
  -> sync and health checks
  -> dashboard + status reporting
```

Primary modules:
- [`../extensions/memory-hybrid/cli/commands/manage/register-storage-maintenance.ts`](../extensions/memory-hybrid/cli/commands/manage/register-storage-maintenance.ts)
- [`../extensions/memory-hybrid/cli/verify/sections/reconcile.ts`](../extensions/memory-hybrid/cli/verify/sections/reconcile.ts)
- [`../extensions/memory-hybrid/routes/dashboard/collectors.ts`](../extensions/memory-hybrid/routes/dashboard/collectors.ts)

---

## Storage surfaces

Default paths (unless overridden in config):

| Surface | Default location | Notes |
|---|---|---|
| SQLite facts DB | `~/.openclaw/memory/facts.db` | Set by `sqlitePath`; contains facts, FTS, and metadata. |
| LanceDB vector store | `~/.openclaw/memory/lancedb` | Set by `lanceDbPath`; semantic vectors. |
| Memory WAL | `~/.openclaw/memory/memory.wal` | Defaults to same directory as `sqlitePath`; controlled by `wal.*`. |
| Optional adjacent DBs | Same directory as `sqlitePath` (e.g. `credentials.db`, `event-log.db`, `issues.db`) | Initialized in optional bootstrap services. |

Reference points:
- [`../extensions/memory-hybrid/config/parsers/core.ts`](../extensions/memory-hybrid/config/parsers/core.ts)
- [`../extensions/memory-hybrid/services/bootstrap-optional.ts`](../extensions/memory-hybrid/services/bootstrap-optional.ts)
- [CONFIGURATION.md](CONFIGURATION.md)

---

## Operator command surfaces

| Surface | Primary command(s) | What it is for | Primary implementation |
|---|---|---|---|
| Verify | `openclaw hybrid-mem verify [--fix] [--test-llm] [--reconcile]` | Canonical runtime/storage/config validation and guided fixes | [`../extensions/memory-hybrid/cli/verify.ts`](../extensions/memory-hybrid/cli/verify.ts), [`../extensions/memory-hybrid/cli/verify/sections/`](../extensions/memory-hybrid/cli/verify/sections/) |
| Doctor | `openclaw hybrid-mem doctor [--fix] [--dry-run]` | Guided install+verify flow for onboarding/remediation | [`../extensions/memory-hybrid/cli/verify.ts`](../extensions/memory-hybrid/cli/verify.ts) |
| Health home | `openclaw hybrid-mem status [--json]` | Unified operational summary + Mission Control URL | [`../extensions/memory-hybrid/cli/cmd-status.ts`](../extensions/memory-hybrid/cli/cmd-status.ts) |
| Quick health | `openclaw hybrid-mem health [--json]` | Traffic-light quick checks | [`../extensions/memory-hybrid/cli/cmd-health.ts`](../extensions/memory-hybrid/cli/cmd-health.ts) |
| Mission Control | `openclaw hybrid-mem dashboard` | Dashboard URL and server surface | [`../extensions/memory-hybrid/routes/dashboard/server.ts`](../extensions/memory-hybrid/routes/dashboard/server.ts) |
| Storage maintenance | `stats`, `prune`, `checkpoint`, `re-index`, `vectordb-optimize`, `run-all` | Consistency, cleanup, and recovery operations | [`../extensions/memory-hybrid/cli/commands/manage/register-storage-maintenance.ts`](../extensions/memory-hybrid/cli/commands/manage/register-storage-maintenance.ts), [`../extensions/memory-hybrid/cli/commands/manage/register-agents-audit-runall.ts`](../extensions/memory-hybrid/cli/commands/manage/register-agents-audit-runall.ts) |

See also: [CLI-REFERENCE.md](CLI-REFERENCE.md), [OPERATIONS.md](OPERATIONS.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Incident lookup: where to look first

| Symptom | First checks | Deep code pointers |
|---|---|---|
| `verify` fails on DB/embeddings/cron | `openclaw hybrid-mem verify` then `verify --fix` | [`../extensions/memory-hybrid/cli/verify/sections/infrastructure.ts`](../extensions/memory-hybrid/cli/verify/sections/infrastructure.ts), [`../extensions/memory-hybrid/cli/verify/sections/embeddings.ts`](../extensions/memory-hybrid/cli/verify/sections/embeddings.ts), [`../extensions/memory-hybrid/cli/verify/sections/config-cron.ts`](../extensions/memory-hybrid/cli/verify/sections/config-cron.ts) |
| SQLite facts and vectors drift | `openclaw hybrid-mem verify --reconcile`, `openclaw hybrid-mem stats` | [`../extensions/memory-hybrid/cli/verify/sections/reconcile.ts`](../extensions/memory-hybrid/cli/verify/sections/reconcile.ts), [`../extensions/memory-hybrid/backends/facts-db/crud.ts`](../extensions/memory-hybrid/backends/facts-db/crud.ts), [`../extensions/memory-hybrid/backends/vector-db/vector-db-class.ts`](../extensions/memory-hybrid/backends/vector-db/vector-db-class.ts) |
| Semantic recall weak/empty | `openclaw hybrid-mem verify --test-llm`, `openclaw hybrid-mem search "..."` | [`../extensions/memory-hybrid/services/retrieval-orchestrator.ts`](../extensions/memory-hybrid/services/retrieval-orchestrator.ts), [`../extensions/memory-hybrid/lifecycle/stage-recall.ts`](../extensions/memory-hybrid/lifecycle/stage-recall.ts) |
| Writes missing after crash/restart | check WAL status + startup logs; run `verify` | [`../extensions/memory-hybrid/backends/wal.ts`](../extensions/memory-hybrid/backends/wal.ts), [`../extensions/memory-hybrid/utils/wal-replay.ts`](../extensions/memory-hybrid/utils/wal-replay.ts), [WAL-CRASH-RESILIENCE.md](WAL-CRASH-RESILIENCE.md) |
| Dashboard/status mismatch | `openclaw hybrid-mem status --json`, open Mission Control | [`../extensions/memory-hybrid/cli/cmd-status.ts`](../extensions/memory-hybrid/cli/cmd-status.ts), [`../extensions/memory-hybrid/routes/dashboard/collectors.ts`](../extensions/memory-hybrid/routes/dashboard/collectors.ts) |
| Maintenance jobs appear stale | `openclaw hybrid-mem verify`, inspect cron section/logs, run `run-all` for ad-hoc sweep | [`../extensions/memory-hybrid/cli/verify/sections/config-cron.ts`](../extensions/memory-hybrid/cli/verify/sections/config-cron.ts), [`../extensions/memory-hybrid/cli/commands/manage/register-agents-audit-runall.ts`](../extensions/memory-hybrid/cli/commands/manage/register-agents-audit-runall.ts) |

---

## Related docs

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [ARCHITECTURE-CENTER.md](ARCHITECTURE-CENTER.md)
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md)
- [OPERATIONS.md](OPERATIONS.md)
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
