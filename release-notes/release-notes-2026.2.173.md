## 2026.2.173 (2026-02-17)

### Added

**Explicit Memory Scoping (FR-006).** Four scope types for stored memories:

- **Global** — available to all
- **User-Private** — only when talking to a specific user
- **Agent-Specific** — only by this agent
- **Session-Scoped** — ephemeral, cleared on session end unless promoted

New `scope` and `scope_target` columns; `memory_store` accepts optional `scope` and `scopeTarget`; `memory_recall` accepts `userId`, `agentId`, `sessionId` to filter. New tool `memory_promote` promotes session-scoped memories. CLI: `hybrid-mem store --scope user --scope-target alice`, `hybrid-mem search --user-id alice`, `hybrid-mem scope prune-session <session-id>`, `hybrid-mem scope promote --id <fact-id> --scope global`. Config: `autoRecall.scopeFilter`. See [MEMORY-SCOPING.md](../docs/MEMORY-SCOPING.md) and [issue #6](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/6).

**Graph-based spreading activation (FR-007).** Typed relationships between facts; `memory_links` table with five link types; tools `memory_link`, `memory_graph`; graph traversal in recall when enabled. See [GRAPH-MEMORY.md](../docs/GRAPH-MEMORY.md).

**Write-Ahead Log (WAL) for crash resilience (FR-003).** Durable WAL before commit; automatic recovery on startup. See [WAL-CRASH-RESILIENCE.md](../docs/WAL-CRASH-RESILIENCE.md).

**Reflection Layer (FR-011).** Pattern and rule categories; `openclaw hybrid-mem reflect` and `memory_reflect` tool. See [REFLECTION.md](../docs/REFLECTION.md).

**Memory Operation Classification (FR-008).** Pre-write classification (ADD/UPDATE/DELETE/NOOP); embedding-based similar-fact retrieval; supersession tracking. See [issue #8](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/8).

**Progressive Disclosure (FR-009).** Auto-recall can inject a memory index; agent fetches specific memories on demand.

**Bi-temporal fact tracking (FR-010).** `valid_from`, `valid_until`, `supersedes_id`; point-in-time recall with `asOf`; CLI `--as-of`, `--include-superseded`, `--supersedes`. See [issue #10](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/10).

**Dynamic Salience Scoring (FR-005).** Access boost, time decay, Hebbian reinforcement (RELATED_TO when recalled together). See [issue #5](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/5).

### Fixed

- **Stability:** Plugin closes LanceDB on stop; WAL fsync for durability; LanceDB failures no longer crash the plugin (graceful fallbacks and logging).
- **Performance:** Bulk UPDATE for `refreshAccessedFacts` (batches of 500); `find-duplicates` uses LanceDB vector search; superseded-facts cache TTL 60s → 5 minutes.

### Changed

- **Reopen guard:** DB instances closed/cleared at start of `register()` to avoid leaks on reload.
- **Module split:** FactsDB → `backends/facts-db.ts`; tag/dedupe, dates, decay → `utils/*.ts`.
- **WAL:** Append-only NDJSON; legacy JSON-array files still read.
- **CLI:** All commands moved to `cli/register.ts` via `registerHybridMemCli`; no CLI blocks left in index.
- **Blocking I/O:** Hot-path sync I/O converted to async `fs/promises`.
- **Embeddings:** In-memory LRU cache (max 500) for repeated text.
- **Docs:** v3 guide split into QUICKSTART, ARCHITECTURE, CONFIGURATION, FEATURES, CLI-REFERENCE, TROUBLESHOOTING, MAINTENANCE, MEMORY-PROTOCOL.
