# Changelog

All notable changes to the OpenClaw Hybrid Memory project (memory-hybrid plugin, v3 deployment guide, and related tooling) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses a **date-based version** (YYYY.M.D, e.g. 2026.2.15) for the plugin and repo releases.

---

## [Unreleased]

### Added

- **Auto-recall token cap (1.1)**: Configurable limit on how many tokens are injected when auto-recall runs. New config: `autoRecall` can be an object with `enabled`, `maxTokens` (default 800), and `maxPerMemoryChars` (default 0). When `maxTokens` is set, memories are added in score order until the cap is reached; when `maxPerMemoryChars` > 0, each memory text is truncated with "…". Legacy `autoRecall: true` remains valid and uses defaults. See [docs/MEMORY-ENHANCEMENT-IDEAS.md](docs/MEMORY-ENHANCEMENT-IDEAS.md).
- **Honor captureMaxChars (1.3)**: `captureMaxChars` is now in config and schema (default 5000). Auto-capture filter (`shouldCapture`) rejects messages longer than `captureMaxChars`. When storing (tool or auto-capture), text longer than the cap is truncated and stored with " [truncated]". Plugin schema and UI hints updated.
- **Shorter injection format (1.2)**: Auto-recall injection format is configurable via `autoRecall.injectionFormat`: `full` (default, `[backend/category] text`), `short` (`category: text`), or `minimal` (text only). Saves tokens when set to short or minimal. Tool responses and logs still show backend/category.
- **Configurable recall limit and minScore (2.1)**: `autoRecall.limit` (default 5) sets the max number of memories considered for injection; `autoRecall.minScore` (default 0.3) sets the vector search minimum score (0–1). Replaces hardcoded values in the before_agent_start handler.
- **Decay-class–aware auto-recall (3.1)**: When `autoRecall.preferLongTerm` is true, scores are boosted for `permanent` (×1.2) and `stable` (×1.1) before re-sorting, so lasting facts are preferred when relevance is close. Default false.
- **Importance and recency in composite score (3.3)**: When `autoRecall.useImportanceRecency` is true, relevance score is combined with importance (0.7 + 0.3×importance) and recency (lastConfirmedAt over 90 days). More important or recently confirmed facts can rank higher. Lance results (lastConfirmedAt 0) get neutral recency. Default false.
- **Entity-centric recall (4.1)**: When `autoRecall.entityLookup.enabled` is true and `entities` is set (e.g. `["user", "owner"]`), if the prompt mentions an entity (case-insensitive), `factsDb.lookup(entity)` results are merged into auto-recall candidates (up to `maxFactsPerEntity` per entity, default 2). Deeper, entity-specific context without changing main search.
- **Chunked long facts / summary (4.3)**: Facts longer than `summaryThreshold` (default 300 chars) get a short summary stored (first `summaryMaxChars` chars + "…", default 80). At auto-recall, when `useSummaryInInjection` is true (default), the summary is injected instead of full text to save tokens; full text remains in DB and in `memory_recall`. New `summary` column in SQLite (migration added).

---

## [2026.2.15] - 2026-02-15

### Added

- **Hybrid memory system**: Combines structured + vector memory (SQLite + FTS5 + LanceDB) from [Clawdboss.ai](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory) with hierarchical file memory (MEMORY.md index + `memory/` drill-down) from [ucsandman’s OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System).
- **memory-hybrid plugin** (`extensions/memory-hybrid/`): Two-tier storage (SQLite+FTS5 for facts, LanceDB for semantic search), auto-capture, auto-recall, decay tiers with TTL, checkpoints, optional LLM auto-classification and custom categories.
- **Tools**: `memory_store`, `memory_recall`, `memory_forget`, `memory_checkpoint`, `memory_prune`.
- **CLI** (`openclaw hybrid-mem`): `stats`, `prune`, `checkpoint`, `backfill-decay`, `extract-daily`, `search`, `lookup`, `classify`, `categories`.
- **Full deployment reference**: [docs/hybrid-memory-manager-v3.md](docs/hybrid-memory-manager-v3.md) — architecture, plugin install (§3), config (§4), MEMORY.md template (§6), AGENTS.md Memory Protocol (§7), single deployment flow (§8), verification (§11), troubleshooting (§12), CLI (§13), upgrades (§14).
- **Autonomous setup**: [docs/SETUP-AUTONOMOUS.md](docs/SETUP-AUTONOMOUS.md) for AI-driven install, config, backfill, and verification.
- **Deploy snippet**: [deploy/openclaw.memory-snippet.json](deploy/openclaw.memory-snippet.json) (memory-hybrid + memorySearch, compaction, bootstrap limits) and [deploy/README.md](deploy/README.md).
- **Backfill script**: [scripts/backfill-memory.mjs](scripts/backfill-memory.mjs) — dynamic section handling, no hardcoded dates; safe on new systems.
- **Upgrade helpers**: [scripts/post-upgrade.sh](scripts/post-upgrade.sh), [scripts/upgrade.sh](scripts/upgrade.sh), [scripts/README.md](scripts/README.md) for post–OpenClaw-upgrade LanceDB reinstall and one-command upgrade flow.
- **Version metadata**: [extensions/memory-hybrid/versionInfo.ts](extensions/memory-hybrid/versionInfo.ts) — `pluginVersion` (from package.json), `memoryManagerVersion` (3.0), `schemaVersion`; exposed on plugin, in `openclaw.plugin.json`, and in `openclaw hybrid-mem stats` and gateway logs. Doc §3.3 describes versioning and upgrades.
- **CHANGELOG**: This file.

### Changed

- **Pre-compaction memory flush**: Customized `memoryFlush` prompts so the flush turn instructs the model to save to **both** `memory_store` (structured) and `memory/YYYY-MM-DD.md` (file-based), preserving hybrid memory across compaction.
- **Context window docs**: Removed hardcoded `contextTokens: 180000` from v3 guide and SETUP-AUTONOMOUS; OpenClaw auto-detects model context from the provider catalog. `contextTokens` is documented as an optional override only when users hit prompt-overflow (e.g. set to ~90% of model window).
- **v3 §4.4**: Clarified that `contextWindow` in the compaction flush formula comes from the **model catalog**, not from config.
- **v3 §12 (Troubleshooting)**: Updated “prompt too large for model” row to describe `contextTokens` as an optional override with examples (200k vs 1M models).

### Fixed

- **registerCli**: Corrected casing to match the actual OpenClaw API.
- **Stale closure and build**: Resolved closure bug and compile errors; repo hygiene (`.gitignore`, LICENSE, README, package.json).
- **Timestamp units**: SQLite and LanceDB now use **seconds** consistently for `created_at` and decay-related columns; added migration for DBs that previously stored milliseconds.
- **SQLite concurrency**: `busy_timeout` and WAL checkpointing for safer concurrent access.
- **Categories**: Documented default and custom categories in config and v3 guide.

### Credits

- **Clawdboss.ai** — [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory): plugin design (SQLite+FTS5+LanceDB, decay, checkpoints).
- **ucsandman** — [OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System): hierarchical file layout (MEMORY.md + `memory/`), token discipline, directory structure.

---

[Unreleased]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.2.15...HEAD
[2026.2.15]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.15
