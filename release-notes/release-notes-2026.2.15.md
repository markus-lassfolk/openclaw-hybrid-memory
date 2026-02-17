## 2026.2.15 (2026-02-15)

### Added

- **Hybrid memory system**: Combines structured + vector memory (SQLite + FTS5 + LanceDB) from [Clawdboss.ai](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory) with hierarchical file memory (MEMORY.md index + `memory/` drill-down) from [ucsandman's OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System).
- **memory-hybrid plugin** (`extensions/memory-hybrid/`): Two-tier storage (SQLite+FTS5 for facts, LanceDB for semantic search), auto-capture, auto-recall, decay tiers with TTL, checkpoints, optional LLM auto-classification and custom categories.
- **Tools**: `memory_store`, `memory_recall`, `memory_forget`, `memory_checkpoint`, `memory_prune`.
- **CLI** (`openclaw hybrid-mem`): `stats`, `prune`, `checkpoint`, `backfill-decay`, `extract-daily`, `search`, `lookup`, `classify`, `categories`.
- **Full deployment reference**: See [docs/QUICKSTART.md](../docs/QUICKSTART.md), [docs/CONFIGURATION.md](../docs/CONFIGURATION.md), [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md), and other focused docs under `docs/`.
- **Autonomous setup**: [docs/SETUP-AUTONOMOUS.md](../docs/SETUP-AUTONOMOUS.md) for AI-driven install, config, backfill, and verification.
- **Deploy snippet**: [deploy/openclaw.memory-snippet.json](../deploy/openclaw.memory-snippet.json) (memory-hybrid + memorySearch, compaction, bootstrap limits) and [deploy/README.md](../deploy/README.md).
- **Backfill script**: [scripts/backfill-memory.mjs](../scripts/backfill-memory.mjs) — dynamic section handling, no hardcoded dates; safe on new systems.
- **Upgrade helpers**: [scripts/post-upgrade.sh](../scripts/post-upgrade.sh), [scripts/upgrade.sh](../scripts/upgrade.sh), [scripts/README.md](../scripts/README.md) for post–OpenClaw-upgrade LanceDB reinstall and one-command upgrade flow.
- **Version metadata**: [extensions/memory-hybrid/versionInfo.ts](../extensions/memory-hybrid/versionInfo.ts) — `pluginVersion` (from package.json), `memoryManagerVersion` (3.0), `schemaVersion`; exposed on plugin, in `openclaw.plugin.json`, and in `openclaw hybrid-mem stats` and gateway logs. Doc §3.3 describes versioning and upgrades.
- **CHANGELOG**: This file.

### Changed

- **Pre-compaction memory flush**: Customized `memoryFlush` prompts so the flush turn instructs the model to save to **both** `memory_store` (structured) and `memory/YYYY-MM-DD.md` (file-based), preserving hybrid memory across compaction.
- **Context window docs**: Removed hardcoded `contextTokens: 180000` from v3 guide and SETUP-AUTONOMOUS; OpenClaw auto-detects model context from the provider catalog. `contextTokens` is documented as an optional override only when users hit prompt-overflow (e.g. set to ~90% of model window).
- **v3 §4.4**: Clarified that `contextWindow` in the compaction flush formula comes from the **model catalog**, not from config.
- **v3 §12 (Troubleshooting)**: Updated "prompt too large for model" row to describe `contextTokens` as an optional override with examples (200k vs 1M models).

### Fixed

- **registerCli**: Corrected casing to match the actual OpenClaw API.
- **Stale closure and build**: Resolved closure bug and compile errors; repo hygiene (`.gitignore`, LICENSE, README, package.json).
- **Timestamp units**: SQLite and LanceDB now use **seconds** consistently for `created_at` and decay-related columns; added migration for DBs that previously stored milliseconds.
- **SQLite concurrency**: `busy_timeout` and WAL checkpointing for safer concurrent access.
- **Categories**: Documented default and custom categories in config and v3 guide.

### Credits

- **Clawdboss.ai** — [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory): plugin design (SQLite+FTS5+LanceDB, decay, checkpoints).
- **ucsandman** — [OpenClaw-Hierarchical-Memory-System](https://github.com/ucsandman/OpenClaw-Hierarchical-Memory-System): hierarchical file layout (MEMORY.md + `memory/`), token discipline, directory structure.
