# Changelog

All notable changes to the OpenClaw Hybrid Memory project (memory-hybrid plugin, v3 deployment guide, and related tooling) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses a **date-based version** (YYYY.M.D for date; same-day revisions use a three-part **npm** version with patch = day×10 + revision, e.g. 2026.2.170, 2026.2.171, so npm accepts it as a normal release).

---

## [Unreleased]

### Added

- **Write-Ahead Log (WAL) for crash resilience (FR-003):** Memory operations are now written to a durable WAL file before being committed to SQLite/LanceDB. If the agent crashes, times out, or is killed during generation, uncommitted operations are automatically recovered on startup. WAL is enabled by default. Configuration: `wal.enabled` (default true), `wal.walPath` (default `~/.openclaw/memory/memory.wal`), `wal.maxAge` (default 5 minutes). See [docs/WAL-CRASH-RESILIENCE.md](docs/WAL-CRASH-RESILIENCE.md) for architecture, recovery process, and troubleshooting.

---

## [2026.2.172] - 2026-02-17

### Added

- **Category discovery (LLM-suggested):** When `autoClassify.suggestCategories` is true (default), the auto-classify job first asks the LLM to group "other" facts by free-form topic labels (e.g. food, travel). Any label that appears on at least `minFactsForNewCategory` facts (default 10) is created as a new category and those facts are reclassified. The threshold is not shown to the LLM. New categories are persisted to `~/.openclaw/memory/.discovered-categories.json` and loaded on next startup. Config: `autoClassify.suggestCategories` (default true), `autoClassify.minFactsForNewCategory` (default 10). See v3 guide §4.8 Stage 3 and §4.8.4.
- **Nightly job in deploy snippet and verify --fix:** The deploy snippet (`deploy/openclaw.memory-snippet.json`) now includes the `nightly-memory-sweep` job so users who merge only the snippet get session distillation by default. `openclaw hybrid-mem verify --fix` adds the nightly job to `openclaw.json` when it is missing, so upgrade or snippet-only users get it without running the full install.

### Changed

- **Session distillation docs:** SESSION-DISTILLATION.md "What the job should do" and the suggested nightly job message now state that extracted credentials are routed the same way as in real time (to the secure vault plus pointer when vault is enabled, or to memory when it is not).
- **Verify --fix:** Now applies the nightly-memory-sweep job when missing (same definition as install), in addition to embedding block and memory directory.

---

## [2026.2.17.1] - 2026-02-17

### Fixed

- **Credentials (vault enabled):** When the vault is enabled, credential-like content that could not be parsed as a structured credential was still being written to memory (facts). It is now skipped: `memory_store` returns a message and does not store; extract-daily and CLI `hybrid-mem store` skip the line; CLI store exits with code 1 and an error message. Ensures no raw credential-like text is stored in facts when vault is on.

---

## [2026.2.17.0] - 2026-02-17

### Added

- **Credential migration when vault is enabled**: When the credential vault is enabled, existing credentials that were stored in memory (facts with entity `Credentials`) are automatically moved into the vault and redacted from SQLite and LanceDB. Migration runs once on first plugin load (flag file `.credential-redaction-migrated`). New pointer facts are written so the agent still knows credentials exist and can use `credential_get`. See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) § Migration.
- **CLI `credentials migrate-to-vault`**: `openclaw hybrid-mem credentials migrate-to-vault` runs the same migration on demand (idempotent; skips facts that are already pointers). Use after enabling the vault if you had credential facts stored in memory before.

### Changed

- **Model-agnostic analysis**: [docs/MODEL-AGNOSTIC-ANALYSIS.md](docs/MODEL-AGNOSTIC-ANALYSIS.md) documents the Option B exploration result (OpenClaw plugin SDK does not expose chat/embed APIs; Option B not available). Decision: keep hardcoded models (OpenAI embeddings/chat, Gemini in docs for distillation) for now; analysis and options retained for future reference.
- **CREDENTIALS.md**: New section “Migration: existing credentials into vault” describing automatic and manual migration when vault is enabled.

---

## [2026.2.16] - 2026-02-16

### Added

- **Session distillation pipeline (Phase 1)**: Batch fact-extraction pipeline for retrospective analysis of historical OpenClaw conversation transcripts. Located in `scripts/distill-sessions/` with components: `batch-sessions.sh` (organize sessions into batches), `extract-text.sh` (convert JSONL to readable text), `store-facts.sh` (generate memory_store commands), `gemini-prompt.md` (LLM extraction template), `run-stats.md` (metrics tracking). Two-phase approach: bulk historical distillation (one-time; typical yield ~20–30 net new facts per full sweep, cost on the order of a few dollars) + nightly incremental sweep (automated, 2–5 new facts per run). All facts tagged with original session date `[YYYY-MM-DD]` for temporal provenance. Recovers knowledge missed by live auto-capture. Documentation: [docs/SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md), example run report: [docs/run-reports/example-distillation-report.md](docs/run-reports/example-distillation-report.md). Concept inspired by virtual-context's "memory archaeology" approach.
- **Nightly memory sweep**: Automated session distillation job (e.g. cron at 02:00 local time) processing last 3 days of sessions using isolated session + Gemini model. Expected yield: 2–5 new facts per run. Logs to `scripts/distill-sessions/nightly-logs/`. Setup via OpenClaw jobs config with `isolated: true` and `model: gemini`. Complements real-time auto-capture.
- **Auto-recall token cap (1.1)**: Configurable limit on how many tokens are injected when auto-recall runs. New config: `autoRecall` can be an object with `enabled`, `maxTokens` (default 800), and `maxPerMemoryChars` (default 0). When `maxTokens` is set, memories are added in score order until the cap is reached; when `maxPerMemoryChars` > 0, each memory text is truncated with "…". Legacy `autoRecall: true` remains valid and uses defaults. See v3 guide and README "What this repo adds" for options.
- **Honor captureMaxChars (1.3)**: `captureMaxChars` is now in config and schema (default 5000). Auto-capture filter (`shouldCapture`) rejects messages longer than `captureMaxChars`. When storing (tool or auto-capture), text longer than the cap is truncated and stored with " [truncated]". Plugin schema and UI hints updated.
- **Shorter injection format (1.2)**: Auto-recall injection format is configurable via `autoRecall.injectionFormat`: `full` (default, `[backend/category] text`), `short` (`category: text`), or `minimal` (text only). Saves tokens when set to short or minimal. Tool responses and logs still show backend/category.
- **Configurable recall limit and minScore (2.1)**: `autoRecall.limit` (default 5) sets the max number of memories considered for injection; `autoRecall.minScore` (default 0.3) sets the vector search minimum score (0–1). Replaces hardcoded values in the before_agent_start handler.
- **Decay-class–aware auto-recall (3.1)**: When `autoRecall.preferLongTerm` is true, scores are boosted for `permanent` (×1.2) and `stable` (×1.1) before re-sorting, so lasting facts are preferred when relevance is close. Default false.
- **Importance and recency in composite score (3.3)**: When `autoRecall.useImportanceRecency` is true, relevance score is combined with importance (0.7 + 0.3×importance) and recency (lastConfirmedAt over 90 days). More important or recently confirmed facts can rank higher. Lance results (lastConfirmedAt 0) get neutral recency. Default false.
- **Entity-centric recall (4.1)**: When `autoRecall.entityLookup.enabled` is true and `entities` is set (e.g. `["user", "owner"]`), if the prompt mentions an entity (case-insensitive), `factsDb.lookup(entity)` results are merged into auto-recall candidates (up to `maxFactsPerEntity` per entity, default 2). Deeper, entity-specific context without changing main search.
- **Chunked long facts / summary (4.3)**: Facts longer than `summaryThreshold` (default 300 chars) get a short summary stored (first `summaryMaxChars` chars + "…", default 80). At auto-recall, when `useSummaryInInjection` is true (default), the summary is injected instead of full text to save tokens; full text remains in DB and in `memory_recall`. New `summary` column in SQLite (migration added).
- **Consolidation job (2.4)**: `openclaw hybrid-mem consolidate [--threshold 0.92] [--include-structured] [--dry-run] [--limit 300] [--model gpt-4o-mini]` finds clusters of semantically similar facts (re-embed from SQLite, pairwise similarity), merges each cluster with a cheap LLM into one concise fact, stores the merged fact in SQLite + LanceDB, and deletes the cluster from SQLite. By default skips identifier-like facts (IP, email, phone, etc.); use `--include-structured` to include them. Dry-run reports clusters without writing.
- **Summarize when over budget (1.4)**: When `autoRecall.summarizeWhenOverBudget` is true and the token cap forces dropping memories, the plugin calls a cheap LLM (`autoRecall.summarizeModel`, default gpt-4o-mini) to summarize all candidate memories into 2–3 short sentences and injects that single block instead. On LLM failure it falls back to the truncated bullet list.
- **Find-duplicates CLI (2.2)**: `openclaw hybrid-mem find-duplicates [--threshold 0.92] [--include-structured] [--limit 300]` reports pairs of facts with embedding similarity ≥ threshold. Uses SQLite as source, re-embeds, pairwise comparison; by default skips identifier-like facts (IP, email, phone, UUID, etc.); `--include-structured` to include them. Report-only; no merge or store changes.
- **Fuzzy text deduplication in SQLite (2.3)**: When `store.fuzzyDedupe` is true, facts are normalized (trim, collapse whitespace, lowercase), hashed (SHA-256), and stored in `normalized_hash`. Before insert, exact match is checked; then duplicate is detected by normalized hash — store is skipped and existing fact is returned. Migration adds column and backfills. Default false.
- **Verify and uninstall CLI**: `openclaw hybrid-mem verify [--fix] [--log-file <path>]` checks config (embedding API key/model), SQLite, LanceDB, and embedding API; reports background jobs (prune 60min, auto-classify 24h); with `--fix` prints missing config suggestions and a minimal snippet; with `--log-file` scans for memory-hybrid/cron errors. Use with `openclaw doctor` when the host supports it. `openclaw hybrid-mem uninstall` **automatically restores the default memory manager** by updating `openclaw.json` (sets `plugins.slots.memory` to `memory-core` and disables memory-hybrid); `--leave-config` skips config change; `--clean-all` or `--force-cleanup` removes SQLite and LanceDB data (irreversible).

### Changed (2026.2.16)

- **First-install experience**: `openclaw hybrid-mem install` applies full defaults (config, compaction prompts, nightly-memory-sweep job); `verify --fix` applies safe fixes (embedding block, jobs, memory dir). Standalone `scripts/install-hybrid-config.mjs` for config before first gateway start. Credentials auto-enable when a valid encryption key is set. Clear error messages and load-blocking vs other issues in verify. Uninstall reverts to default memory without breaking OpenClaw.
- **Verify**: Optional/suggested jobs (nightly-memory-sweep defined/enabled), credentials vault check, session-distillation last run, record-distill CLI. Prerequisite checks at plugin init (embedding API, credentials vault).
- **npm install path**: Package name set to `openclaw-hybrid-memory` for `openclaw plugins install openclaw-hybrid-memory` (maintainer publish steps in internal docs).

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

[Unreleased]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.2.172...HEAD
[2026.2.172]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.172
[2026.2.17.1]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.17.1
[2026.2.17.0]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.17.0
[2026.2.16]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.16
[2026.2.15]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.15
