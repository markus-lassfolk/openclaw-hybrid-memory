# Changelog

All notable changes to the OpenClaw Hybrid Memory project (memory-hybrid plugin, v3 deployment guide, and related tooling) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses a **date-based version** (YYYY.M.D for date; same-day revisions use a three-part **npm** version with patch = day×10 + revision, e.g. 2026.2.170, 2026.2.171, so npm accepts it as a normal release).

---

## [2026.2.181] - 2026-02-18

### Added

- **Self-correction analysis (issue #34, closes #34):** Nightly pipeline to detect user corrections in session logs and auto-remediate. Multi-language correction detection via `.language-keywords.json` (run `build-languages` first for non-English). CLI: `openclaw hybrid-mem self-correction-extract [--days N] [--output path]`, `openclaw hybrid-mem self-correction-run [--extract path] [--approve] [--no-apply-tools] [--model M]`. Phases: (1) extract incidents from session JSONL using correction signals, (2) LLM analyze (category, severity, remediation type), (3) remediate: MEMORY_STORE with semantic dedup, TOOLS.md rules under configurable section (default apply; opt-out with `applyToolsByDefault: false` or `--no-apply-tools`), AGENTS/SKILL as proposals. Optional: `autoRewriteTools: true` for LLM rewrite of TOOLS.md; `analyzeViaSpawn` for Phase 2 via `openclaw sessions spawn` (Gemini, large batches). Config: `selfCorrection.semanticDedup`, `semanticDedupThreshold`, `toolsSection`, `applyToolsByDefault`, `autoRewriteTools`, `analyzeViaSpawn`, `spawnThreshold`, `spawnModel`. Report: `memory/reports/self-correction-YYYY-MM-DD.md`. Docs: SELF-CORRECTION-PIPELINE.md, CONFIGURATION.md. Optional cron job `self-correction-analysis` in install script.

- **RRF and search improvements (issue #33, closes #33):**
  - **Reciprocal Rank Fusion (RRF)** — Replaced naive score-based merge in `services/merge-results.ts` with RRF. BM25 (SQLite) and cosine (LanceDB) scores are on incompatible scales; RRF uses rank-based fusion `rrf_score = sum(1/(k+rank))` so items ranking well in both keyword and semantic search naturally float to the top. Default k=60. Optional `mergeResults(..., { k })`.
  - **`openclaw hybrid-mem ingest-files`** — Index workspace markdown (skills, TOOLS.md, AGENTS.md) as facts via LLM extraction. Config `ingest.paths`, `ingest.chunkSize`, `ingest.overlap`. Facts stored with `category: technical`, `decayClass: stable`, tags include `ingest`.
  - **HyDE query expansion** — Opt-in: `search.hydeEnabled: true` generates a hypothetical answer before embedding for vector search (memory_recall + auto-recall). Config `search.hydeModel` (default gpt-4o-mini). Adds latency/API cost per search.

- **Procedural memory (issue #23, closes #23):** Auto-generated skills from learned patterns. Three layers:
  - **Layer 1 — Procedure tagging:** During session processing, multi-step tool-call sequences are extracted from session JSONL; successful runs are stored as positive procedures, failures as negative procedures. New `procedures` table and optional columns on `facts` (`procedure_type`, `success_count`, `last_validated`, `source_sessions`). CLI: `openclaw hybrid-mem extract-procedures [--dir path] [--days N] [--dry-run]` to scan session logs and upsert procedures. Secrets are never stored in recipes (redacted in procedure-extractor).
  - **Layer 2 — Procedure-aware recall:** `memory_recall_procedures(taskDescription)` tool returns "Last time this worked" steps and "⚠️ Known issue" warnings. Auto-recall injects a `<relevant-procedures>` block when the prompt matches stored procedures (positive and negative). Config: `procedures.enabled` (default true), `procedures.sessionsDir`, `procedures.minSteps`, etc.
  - **Layer 3 — Skill generation:** When a procedure is validated N times (default 3), auto-generate `skills/auto/{slug}/SKILL.md` and `recipe.json`. CLI: `openclaw hybrid-mem generate-auto-skills [--dry-run]`. Skills are sandboxed under `procedures.skillsAutoPath` (default `skills/auto`). Stale procedures (past `skillTTLDays`) are available for revalidation. Config: `procedures.validationThreshold`, `procedures.skillTTLDays`, `procedures.requireApprovalForPromote`.

### Fixed

- **CLI:** Removed duplicate registration of `extract-procedures` and `generate-auto-skills` in `registerHybridMemCli` (copy-paste had registered each command two extra times).

---

## [Unreleased]

### Added

---

## [2026.2.176] - 2026-02-17

### Added

- **Gemini support for distill** — `openclaw hybrid-mem distill` can use Google Gemini (e.g. `gemini-2.0-flash`) via `--model` or config `distill.defaultModel`. Config `distill.apiKey` (raw or `env:VAR`); env fallback: `GOOGLE_API_KEY` / `GEMINI_API_KEY`. Gemini uses 500k-token batches (vs 80k for OpenAI). New `services/chat.ts` routes by model name; `distillBatchTokenLimit()` returns batch size. See CONFIGURATION.md, SESSION-DISTILLATION.md.
- **distill: chunk oversized sessions instead of truncating** — Sessions exceeding `--max-session-tokens` are now split into overlapping windows (10% overlap) rather than truncated. Each chunk is tagged as `SESSION: <file> (chunk N/M)`. Existing dedup (0.85 threshold) handles cross-chunk duplicates. New CLI flag: `--max-session-tokens <n>` (default: batch limit). See [issue #32](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/32).

### Changed

- **Documentation:** CONFIGURATION.md adds "Session distillation (Gemini)" section; SESSION-DISTILLATION documents `--model` and Gemini config; CLI-REFERENCE documents distill `--model` and batch sizes.
- **Tests:** `chat.test.ts` (isGeminiModel, distillBatchTokenLimit, chatComplete routing/errors); config.test.ts (distill parsing); `distill-chunk.test.ts`.

---

## [2026.2.175] - 2026-02-17

### Added

- **`openclaw hybrid-mem upgrade`** — One-command upgrade to latest from npm. Removes current install, fetches latest, rebuilds native deps. Restart gateway afterward. Simplifies the upgrade flow (no more fighting the bull).

### Fixed

- **Stability:** Plugin now closes LanceDB (VectorDB) on stop to avoid resource leaks; VectorDB has a `close()` method and closed guard.
- **Stability:** WAL writes are durable: fsync is performed after each write, remove, and pruneStale compact so power loss does not corrupt the log.
- **Stability:** LanceDB failures no longer crash the plugin: search/count/hasDuplicate return empty/0/false and log; store/delete log and rethrow; CLI and tool paths wrap vector calls in try/catch with logging.
- **Performance:** `refreshAccessedFacts` now uses bulk UPDATE with `WHERE id IN (...)` in batches of 500 instead of N+1 per-id updates.
- **Performance:** `find-duplicates` uses LanceDB vector search (indexed) instead of an O(n²) pairwise loop.
- **Performance:** Superseded-facts cache TTL increased from 60s to 5 minutes to reduce full table scans.

### Changed

- **Reopen guard:** At start of `register()`, any existing DB instances (factsDb, vectorDb, credentialsDb, proposalsDb) are closed and cleared before creating new ones, avoiding duplicate or leaked instances if the host calls `register()` again before `stop()` (e.g. SIGUSR1 or rapid reload).
- **Module split:** Tag/dedupe → `utils/tags.ts`; dates → `utils/dates.ts`; decay → `utils/decay.ts`. **FactsDB** → `backends/facts-db.ts` (SQLite+FTS5, all migrations, store/search/lookup/links/checkpoint/decay; exports `MEMORY_LINK_TYPES`, `MemoryLinkType`). Index imports FactsDB and link types from backends/facts-db.
- **WAL:** Append-only NDJSON format: write/remove append one line and fsync; pruneStale compacts by rewriting only valid entries. Legacy single-JSON-array files are still read correctly.
- **Utils:** Added `truncateText`, `truncateForStorage` for consistent truncation; store truncation uses `truncateForStorage`. Added `safeEmbed(embeddings, text, logWarn)` for centralized embedding error handling (used in find-duplicates).
- **Code quality:** Named constants for reflection/credential limits; empty catch blocks in vector delete paths now log with `api.logger.warn`.
- **Prompts:** Reflection, consolidation, category-discovery, and category-classify prompts moved to `prompts/*.txt`; index uses `loadPrompt`/`fillPrompt` for all (memory-classify was already external).
- **Dead imports:** Removed unused imports from index: `WALEntry`, `TTL_DEFAULTS`, `IDENTITY_FILE_TYPES`, `TAG_PATTERNS`.
- **CLI extraction (first batch):** `cli/register.ts` registers hybrid-mem subcommands stats, prune, checkpoint, backfill-decay via `registerHybridMemCli(mem, context)`. Index passes `{ factsDb, vectorDb, versionInfo }`; remaining commands stay in index for now.
- **Performance (redundant embeddings):** `Embeddings` now uses an in-memory LRU cache (max 500 entries) so repeated embedding of the same text returns the cached vector instead of calling the API again.
- **CLI (second batch):** search and lookup moved to `cli/register.ts`; context extended with embeddings, mergeResults, parseSourceDate.
- **CLI (third batch):** categories and find-duplicates moved to `cli/register.ts`; context extended with getMemoryCategories, runFindDuplicates.
- **CLI (fourth batch):** consolidate, reflect, reflect-rules, reflect-meta moved to `cli/register.ts`; context extended with runConsolidate, runReflection, runReflectionRules, runReflectionMeta, reflectionConfig.
- **CLI (fifth batch):** classify moved to `cli/register.ts`; added `runClassifyForCli` in index, context extended with runClassify, autoClassifyConfig.
- **CLI (sixth batch):** store moved to `cli/register.ts`; added `runStoreForCli` in index, `StoreCliOpts`/`StoreCliResult` and runStore in context.
- **CLI (seventh batch):** install moved to `cli/register.ts`; added `runInstallForCli` in index, `InstallCliResult` and runInstall in context.
- **CLI (eighth batch):** verify moved to `cli/register.ts`; added `runVerifyForCli` with VerifyCliSink, runVerify in context.
- **CLI (ninth batch):** distill-window and record-distill moved to `cli/register.ts`; added `runDistillWindowForCli`, `runRecordDistillForCli`, DistillWindowResult, RecordDistillResult, runDistillWindow, runRecordDistill in context.
- **CLI (final batch):** extract-daily, credentials (migrate-to-vault), uninstall moved to `cli/register.ts`. All CLI commands now registered via `registerHybridMemCli`. No CLI command blocks remain in index.ts.
- **Blocking I/O:** Hot-path sync I/O (agent_end, before_agent_start, auditProposal, discoverCategoriesFromOther) converted to async `fs/promises` (mkdir, readFile, writeFile, unlink, access).
- **Naming consistency:** Renamed `openaiClient` → `openai` (module-level), `db` → `factsDb` in classify/discovery functions.
- **Magic numbers:** 15+ named constants extracted to `utils/constants.ts` (importance levels, temperatures, thresholds, max chars, timeouts, SECONDS_PER_DAY).
- **WAL helpers:** `walWrite` and `walRemove` helpers eliminate 8–12 lines of boilerplate per call site (5 sites: memory_store UPDATE/ADD, auto-capture UPDATE/ADD, WAL recovery).
- **Documentation split:** `hybrid-memory-manager-v3.md` (927 lines) split into 8 focused docs: QUICKSTART, ARCHITECTURE, CONFIGURATION, FEATURES, CLI-REFERENCE, TROUBLESHOOTING, MAINTENANCE, MEMORY-PROTOCOL. Original moved to `docs/archive/`.

### Added

- **Graph-based spreading activation (FR-007):** Typed relationships between facts enable zero-LLM recall via graph traversal. The `memory_links` table stores five link types (`SUPERSEDES`, `CAUSED_BY`, `PART_OF`, `RELATED_TO`, `DEPENDS_ON`) with configurable strength (0.0-1.0). New tools: `memory_link` (create typed links), `memory_graph` (explore connections). Enhanced `memory_recall` automatically traverses graph when `graph.useInRecall` is enabled (default true). Optional auto-linking in `memory_store` creates `RELATED_TO` links to similar facts when `graph.autoLink` is enabled. Configuration: `graph.enabled`, `graph.autoLink`, `graph.autoLinkMinScore` (default 0.7), `graph.autoLinkLimit` (default 3), `graph.maxTraversalDepth` (default 2), `graph.useInRecall` (default true). See [docs/GRAPH-MEMORY.md](docs/GRAPH-MEMORY.md) for architecture, usage, best practices, and competitive analysis (Zep/Graphiti, Mem0, MAGMA).
- **Write-Ahead Log (WAL) for crash resilience (FR-003):** Memory operations are now written to a durable WAL file before being committed to SQLite/LanceDB. If the agent crashes, times out, or is killed during generation, uncommitted operations are automatically recovered on startup. WAL is enabled by default. Configuration: `wal.enabled` (default true), `wal.walPath` (default `~/.openclaw/memory/memory.wal`), `wal.maxAge` (default 5 minutes). See [docs/WAL-CRASH-RESILIENCE.md](docs/WAL-CRASH-RESILIENCE.md) for architecture, recovery process, and troubleshooting.
- **Reflection Layer (FR-011)**: Analyze facts to extract behavioral patterns and meta-insights. New `pattern` and `rule` categories for storing synthesized patterns. CLI command `openclaw hybrid-mem reflect [--window N] [--dry-run] [--model MODEL]` and agent tool `memory_reflect` for on-demand pattern synthesis. Patterns are stored with high importance (0.9) and permanent decay class. Semantic deduplication at 85% similarity threshold. Config: `reflection.enabled`, `reflection.model` (default gpt-4o-mini), `reflection.defaultWindow` (default 14 days), `reflection.minObservations` (default 2). See [docs/REFLECTION.md](docs/REFLECTION.md) for full documentation. Inspired by Claude-Diary and Generative Agents paper.
- **Memory Operation Classification (FR-008)**: LLM-based pre-write classification of memory operations as `ADD`, `UPDATE`, `DELETE`, or `NOOP`. When enabled, the system analyzes new facts against existing memories to determine if they should be added as new facts, update/supersede existing facts, mark facts as deleted, or be skipped as duplicates. This prevents contradictory duplicates and maintains an audit trail of how facts evolve. **Similar-fact retrieval now uses embedding similarity** (top-N by vector search, then resolved via SQLite) as in Mem0-style pipelines; entity+key/FTS fallback is used when vector search returns no candidates. LanceDB stores the SQLite fact id when provided so classification can target the correct fact. New database fields `superseded_at` and `superseded_by` track supersession relationships. Deleted facts are soft-deleted (superseded with NULL) and excluded from recall. Config: `store.classifyBeforeWrite` (default false, opt-in), `store.classifyModel` (default gpt-4o-mini). Classification results are exposed in tool responses and nightly jobs. See [issue #8](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/8).
- **Progressive Disclosure for auto-recall (FR-009)**: Auto-recall can now inject a lightweight memory index instead of full memory texts, allowing the agent to decide what to fetch. When `autoRecall.injectionFormat` is set to `progressive`, the system injects a compact list showing available memories with their categories, titles, and token costs. The agent can then use `memory_recall` to fetch specific memories on demand. This reduces prompt bloat, prevents over-disclosure of marginal information, and gives agents more control over context usage. Access tracking (recall count and last accessed timestamp) is updated for all injected memories to support salience-based ranking.
- **Bi-temporal fact tracking (FR-010)**: Contradiction resolution and point-in-time queries. New columns: `valid_from`, `valid_until`, `supersedes_id`. When a fact is superseded (UPDATE/DELETE classification or manual `supersedes`), the old fact gets `valid_until = now` and the new fact gets `valid_from` and `supersedes_id`. Default recall returns only current facts (`superseded_at IS NULL`). Optional: `memory_recall(..., includeSuperseded: true)` or `asOf: "YYYY-MM-DD"` for point-in-time ("what did we know as of date X?"). `memory_store` accepts optional `supersedes` (fact id to replace). CLI: `hybrid-mem search "query" --as-of 2026-01-20`, `--include-superseded`. Session distillation (extract-daily) uses session/file date as `valid_from`. See [issue #10](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/10).

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
- **Full deployment reference**: See [docs/QUICKSTART.md](docs/QUICKSTART.md), [docs/CONFIGURATION.md](docs/CONFIGURATION.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and other focused docs under `docs/`.
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
