# Changelog

All notable changes to the OpenClaw Hybrid Memory project (memory-hybrid plugin, v3 deployment guide, and related tooling) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses a **date-based version** (YYYY.M.D for date; same-day revisions use a three-part **npm** version with patch = day×10 + revision, e.g. 2026.2.170, 2026.2.171, so npm accepts it as a normal release).

---

## [Unreleased]

---

## [2026.3.292] - 2026-03-29

### Release summary

CLI clarity release: **`hybrid-mem config`** and **`hybrid-mem stats`** now describe **effective (running) config** for Phase 1 core-only baseline features, so they no longer disagree with each other when `openclaw.json` still has `enabled: true` but the plugin forces options off (plugin ≥2026.3.140). Export **`PHASE1_CORE_ONLY_FORCE_DISABLED_KEYS`** from the config parser so the migration list stays a single source of truth.

### Fixed

- **Config view:** Phase 1–affected optional features show effective on/off; when the file still has `enabled: true`, a short Phase 1 baseline note is shown. Added missing toggles for workflow tracking, verification, retrieval aliases, reranking, and contextual variants. Query expansion (Advanced) gets the same file-vs-effective note when applicable.
- **Rich stats:** Proposals and credentials lines avoid implying a feature is “broken” when it is off in effective config or the vault is disabled.

### Packaging / install

- **Private testing:** Publish to npm with a non-`latest` dist-tag (for example `npm publish --tag private --otp=…`) so you can install `openclaw-hybrid-memory@private` or pin `2026.3.292` without moving the default `latest` pointer until you are ready.

---

## [2026.3.291] - 2026-03-29

### Release summary

Packaging-only release: the npm tarball includes `benchmark/` (shadow-eval / `hybrid-mem benchmark`). **Feature list unchanged** from [2026.3.290](#20263290---2026-03-29).

### Fixed

- **npm package:** `benchmark/` listed in `package.json` `files` so installs include `benchmark/shadow-eval` and feature benchmarks required by `cli/benchmark.ts`.

---

## [2026.3.290] - 2026-03-29

### Release summary

This release is a large step forward for **structured memory**, **Azure / APIM deployments**, and **operational hardening**. It adds episodic memory, human-gated edicts, procedure outcome tracking, and frequency-based auto-capture; ships Mission Control dashboards (memory graph, agent health, cross-agent audit); improves embedding setup with APIM-aware routing and a new `model-info` CLI; and closes multiple critical-through-low severity issues across FTS5, WAL, LanceDB, credentials, SQLite lifecycle, and recall.

### Added

- **Episodic memory (#781):** First-class `category: "episode"` with `event`, `outcome` (`success` \| `failure` \| `partial` \| `unknown`), `timestamp`, `duration`, `context`, `relatedFactIds`, `procedureId`, scope, IDs, importance, tags, and decay. SQLite `episodes` table with indexed `outcome` and `timestamp`; vectors in LanceDB alongside facts (`category="episode"`). Failures auto-boost to `importance ≥ 0.8`.
- **Episode tools:** `memory.record_episode()`, `memory.search_episodes()` (outcome, time range, `procedureId`, FTS over `event + context`).
- **Session-end episode auto-capture (#781):** Compaction scans JSONL for outcome phrases (e.g. merged / failed / fixed / partial / ERROR) and creates episode records.
- **FactsDB episode API:** `storeEpisode`, `getEpisode`, `deleteEpisode`, `searchEpisodes`, `episodesCount`; `episodes_fts` FTS5 table; `episodes.test.ts` coverage.
- **Edict memory type (#791):** `category: "edict"` for verified ground truth in SQLite `edicts` with TTL (`never` \| `event` \| seconds). Tools: `memory.add_edict`, `list_edicts`, `get_edicts`, `update_edict`, `remove_edict`, `edict_stats`. Injected before issue/narrative/hot blocks; **never trimmed** by token budget. Creation is **propose-only** (`[EDICT CANDIDATE]` on GitHub for human review).
- **Procedure feedback loop (#782):** `procedure_versions` and `procedure_failures` tables; `procedureFeedback()` on FactsDB; `memory.procedure_feedback()` tool; `memory_recall_procedures` enriched with `lastOutcome`, `successRate`, `avoidanceNotes`; CLI `memory procedure show` / `list`.
- **Frequency-based auto-save (#784):** `recent_mentions` table; auto-save entities after threshold; vault capture for credentials with hashed dedupe and `host+username+scope` supersession; `FrequencyCaptureConfig` (`mentionThreshold`, `lookbackSessions`, `ttlDays`, etc.).
- **Mission Control (#788–#790):** Memory graph visualization (#788), Agent Health Dashboard (#789), Cross-agent Audit Trail (#790).
- **Azure APIM for embeddings (#815):** Gateway auth, deployment override, endpoint auto-inheritance; plugin OpenAI client and `hybrid-mem --test-llm` probe updated (#822, #826).
- **`hybrid-mem model-info` CLI (#816):** Embedding dimension introspection for operators.
- **Shadow evaluation benchmark (#787).**
- **Repository automation:** `issue-verify-and-close` and `pr-merged-trigger` workflows for PR/issue verification.
- **Facts DB internals (#921):** Modular helpers — `cache-manager`, `db-connection`, `fact-queries`, `fts-text`; shared `utils/embed-call.ts` for embedding calls; expanded `credential-validation`; config schema additions in `openclaw.plugin.json` where applicable.

### Changed

- **`DEFAULT_MEMORY_CATEGORIES`:** Includes `"episode"` (and edict as a category where defined in types).
- **`EpisodeEntry` type** in `types/memory.ts` (discriminated `outcome`).
- **`ProcedureEntry`:** `version`, `lastOutcome`, `successRate`, `avoidanceNotes` from version tracking.
- **Token-budget trimming (#792):** Tiered trimming with `preserveUntil` / `preserveTags` for finer control over what survives under pressure.
- **Dependencies:** Audit and reduction (#777); `openclaw` peer/dev bumps (#780, #920); `path-to-regexp` bump (#809).
- **Imports:** Deprecated OpenClaw plugin-sdk barrel paths replaced with scoped subpaths (#779).
- **Lint / DX:** Biome rules tightened (off → warn), `organizeImports` disabled (#819); invalid `noUselessContinue` rule removed; retry/timeout constants centralized in `utils/constants.ts` (#910).

### Fixed

- **SQLite after gateway restart (#783):** Connection reopened correctly after `SIGUSR1` restart.
- **Migrations & data safety:** Duplicate `migrateEpisodesTable` removed (#801/#804); edict migration duplicate-check / data-loss risk (#808); stronger episodes migration (CHECK constraints, composite indexes, FTS trigger, #817).
- **Procedure feedback (#798):** `scopeTarget` null handling; double-counting in `procedureFeedback`.
- **Reliability wave (#909, #917, #918):** FTS5 hardening, WAL improvements, async/GitHub lease handling, safer tools, LanceDB and credential paths, task queue (incl. FD leak on lock, #813), embedding edge cases, security and SQLite hygiene, CLI verify behavior.
- **Priority-low sweep (#870–#902, #921):** Facts DB refactor and query paths; recall pipeline and memory/credential tools; WAL helpers; vector-db and FTS search; scope filtering; context engine and narratives; error reporter and verification store; Python bridge stdin; plugin API registration edge cases.
- **Register / task signals / Python stdin (#802, #810, #812, #823).**
- **CI:** Biome `--max-diagnostics=none` and unsafe write fixes (#805, #806).

---

## [2026.3.260] - 2026-03-26

### Release summary

A focused stability and usability release building on the large 2026.3.250 feature drop. Highlights: **Lineage Tracking** ("why" field on all memories and decisions), **flattened config schema** with backwards-compatible migration, **pinned-constraint auto-injection** before context compaction, and a comprehensive wave of LanceDB reliability fixes. All known LanceDB crash paths from 2026.3.250–251 are now resolved.

### Added

- **Lineage Tracking — "Why" field for files and decisions (#750, #752):** Every memory fact, file reference, and decision stored by the plugin now carries an optional `why` field capturing the reason it was created. The LanceDB schema and FTS5 index are both extended; `memory-tools` and CLI `vector store` commands support the new field. Enables provenance queries ("why was this fact stored?") and richer audit trails.
- **Auto-inject pinned constraints before context compaction (#758):** Constraints marked as `pinned` in the memory store are now automatically re-injected into the context window immediately before compaction runs. Previously, pinned constraints could be silently dropped during aggressive compaction; they are now guaranteed to survive.
- **Link timeline summaries to raw session logs (#766):** The session timeline UI now renders direct links from each summary entry to the underlying raw session log file, making it easy to jump from a high-level summary to the exact conversation that produced it.
- **preferredProviders in embedding schema (#743):** The `openclaw.plugin.json` embedding schema now accepts a `preferredProviders` array, letting operators declare a preferred embedding provider order per-deployment without touching code.

### Fixed

- **LanceDB re-index race condition and ENOTEMPTY on LanceDB 0.27.x (#771):** Concurrent re-index operations on LanceDB 0.27.x could leave a partial `_tmp` directory and throw `ENOTEMPTY`. The re-index path now uses atomic rename semantics and a lock guard to prevent interleaving.
- **LanceDB data file not found during vector-duplicate-check (#768, #774):** `hasDuplicate()` threw a file-not-found error on freshly initialised stores before the first write. The check now gracefully returns `false` when the underlying data file is absent.
- **Crystallization pipeline produces zero proposals (#742, #773):** A logic inversion in the candidate scoring step caused the crystallization pipeline to filter out all proposals instead of the weakest ones. Fixed; pipeline now consistently produces ranked proposals.
- **VectorDB schema error suppression tightened (#740, #753):** The `LANCE_NO_VECTOR_COL_MSG` error suppression was previously applied unconditionally, masking genuine schema errors. Guard now requires `!this.schemaValid` before suppressing, so real schema problems surface correctly.
- **Vector dimension mismatch in LanceDB fallback queries (#764):** When the active embedding model returns a different dimension than what the LanceDB table was created with, fallback queries no longer crash — they skip the vector leg and return FTS-only results.
- **SQLite FTS5 throws "unterminated string" on null bytes (#737, #738):** FTS5 queries containing null bytes (e.g. from binary clipboard content) caused an unhandled SQLite error. Input is now sanitized before FTS5 query construction.
- **LanceDB concurrent-close null guard (#771):** Concurrent close calls on the LanceDB connection could dereference a null handle. Added null guard in the close path.
- **`truncateForStorage` crashes on undefined/null input (#755, #756):** Two separate callers could pass `undefined` or `null` to `truncateForStorage`. Both paths now coerce to empty string before truncation.
- **selfCorrection and implicitFeedback JSON schema missing `enabled` field (#765, #767):** The `enabled` toggle was accepted at runtime but omitted from the JSON schema, causing validation warnings. Both schemas now declare `enabled` explicitly.
- **CLI config display: nightlyCycle enabled state always shown as false (#760):** The `hybrid-mem config` CLI output hardcoded `false` for the `nightlyCycle.enabled` field regardless of actual config. Now reads the live value correctly.
- **`stringEnum` removed — replaced with inline implementation (#762):** A utility that was removed in a dependency update was still being imported. Replaced with a minimal inline implementation to restore correct schema validation.
- **Suppress transient HTTP 500 errors from OpenAI to GlitchTip (#739, #759):** Transient 500 responses from OpenAI (server-side errors outside plugin control) are no longer reported as plugin errors in GlitchTip, reducing alert noise.
- **Distill description referenced removed GOOGLE_API_KEY (#776):** The distillation step description mentioned `GOOGLE_API_KEY` which was removed in favour of `llm.heavy` tier config. Updated to reflect current setup.
- **Google embedding model name (#743):** Default Google embedding updated from `text-embedding-005` (404) to `gemini-embedding-001` (current name).
- **Azure embedding label in verify output:** The verify `--test-llm` table now correctly labels the Azure embedding provider row.
- **CI: Biome format, lint error, and npm audit vulnerability (f240d914):** Three CI issues fixed on main: `vector-db.ts` Biome format (ternary line-length), `cmd-config.ts` unused `catch (e)` binding, `config-view-nightly-cycle.test.ts` missing `node:` import prefix, and `smol-toml` bumped to ≥1.6.1 (GHSA-v3rj-xjv7-4jmq, moderate DoS).

### Changed

- **Flattened config schema (#754, #776):** Three previously nested config keys are promoted to top-level:
  - `implicitFeedback.trajectoryLLMAnalysis` → `trajectoryLLMAnalysis`
  - `implicitFeedback.feedToSelfCorrection` → `feedToSelfCorrection`
  - `distill.extractReinforcement` → `extractReinforcement`

  Old nested keys continue to work during a migration period (deprecation warning logged when both are set). Top-level keys take precedence. Update your `openclaw.plugin.json` or agent config to use the new flat paths.

- **VectorDB error handler precision:** Schema-error suppression now conditioned on `!this.schemaValid`, making error handling more surgical and preventing silent masking of genuine issues.

### Dependencies

- `yaml` bumped from 2.8.2 → 2.8.3 in `extensions/memory-hybrid`
- `picomatch` bumped in both `extensions/memory-hybrid` and root workspace
- Root workspace dependencies updated to latest patch versions
- `smol-toml` bumped to ≥1.6.1 (security: GHSA-v3rj-xjv7-4jmq)

---

## [2026.3.250] - 2026-03-24

### Release summary

The largest feature release since the memory-manager 3.0 rewrite. This release ships **Production RAG principles**, **NarrativesDB** for temporal memory summaries, **identity reflection**, an **auto-generated memory mind-map**, a **task-queue watchdog**, and a comprehensive **database reliability overhaul** — alongside five crash-level bug fixes surfaced through real-world telemetry.

### Added

- **Production RAG principles (#656):** Full-featured Retrieval-Augmented Generation pipeline — reranking, semantic cache, document grading with configurable toggle, and best-match tiebreaking by `cachedAt` so higher-similarity results always win.
- **NarrativesDB — temporal + narrative summaries (#646):** New `NarrativesDB` backend stores per-session narrative snapshots synthesized from event-log events. Session summaries are generated at `agent_end` and surfaced during recall to give the agent temporal context ("what happened in the last session").
- **Identity reflection layer (#647):** A dedicated reflection pass builds and maintains a durable persona identity store from the agent's own outputs. Reflection outputs are promoted through a pipeline into `persona-state-store`, giving the agent long-term self-awareness across sessions.
- **Auto-generated memory mind-map / index (#645):** A background job synthesizes all stored facts into a human-readable memory index — a navigable mind-map of what the agent knows. Short entries now use their actual text as labels instead of generic category names.
- **Task-queue watchdog (#662):** A new watchdog service monitors the autonomous task queue for stale leases, clears expired entries, and emits alerts. Includes lease tracking with proper expiry management and Azure model documentation.
- **Retrieval modes — interactive vs. deep (#639):** First-class support for two distinct retrieval strategies: `interactive` (low-latency, FTS5-first) and `deep` (higher-recall, multi-strategy). Mode is selected per query based on context signals.
- **Hard FTS5 capability check (#727):** On startup the plugin verifies the SQLite FTS5 extension is available. If missing, it degrades gracefully with a clear alert rather than silent query failures.
- **Pre-consolidation flush & decay controls (#729):** New explicit controls for pre-consolidation memory flush and decay scheduling. Operators can now configure flush triggers and decay intervals directly rather than relying on implicit cron timing.
- **Provenance tagging to prevent cron contamination (#728):** Every fact written by a background cron job is tagged with its provenance source. Prevents cron-written facts from polluting feedback loops and corrupting the interactive memory signal.
- **Automated CI feedback loop (#664):** CI review comments are now automatically consumed and re-queued as follow-up tasks, closing the loop between review feedback and code changes without manual triage.
- **Architecture center (#637):** Formal definition of the core runtime boundary vs. adjacent subsystems. Enforced via lint rules to prevent coupling creep between plugin internals and external tooling layers.
- **`verify --test-llm`:** New `--test-llm` flag for `openclaw hybrid-mem verify` tests every configured LLM endpoint with a real API call, reporting which models are reachable and what dimensions/capabilities they expose.
- **ANTHROPIC_API_KEY env support in verify:** Verify now resolves the Anthropic key from `ANTHROPIC_API_KEY` env var (in addition to the existing config path), making it easier to run without a hardcoded key.
- **Agent + node tagging in error reports (#706):** GlitchTip / error reports now include which agent (Maeve, Doris, etc.) and which machine generated the error, enabling per-agent filtering in the telemetry dashboard.
- **Version-aware telemetry muting (#705):** Outdated plugin versions suppress telemetry noise by default. Configurable update nudges alert operators when a newer version is available.

### Fixed

- **EventLog closed after session dispose (#683, #712):** The `EventLog.liveDb` getter previously threw `"EventLog is closed"` permanently after `close()` was called. Changed from a permanent closed flag (better-sqlite3 pattern) to a reopen path using Node.js `DatabaseSync.open()`. Additionally added an `isOpen()` guard in `buildDailyNarrative` to skip narrative synthesis cleanly when the session is already torn down.
- **"database is not open" on hot-reload (#682, #711):** Defensive database connection initialization prevents `"database is not open"` errors during gateway hot-reload or SIGUSR1 restart cycles.
- **All embedding providers failed (#678, #680, #707, #710):** Fixed two separate causes: (1) incorrect provider chain fallback when the primary embedding provider is unreachable; (2) dimension mismatch when switching embedding models that caused the fallback chain to abort unnecessarily.
- **LanceDB "No vector column found" (#679, #708):** Query stream now handles the case where no vector column exists in the LanceDB table (e.g. on a freshly initialized or migrated store) without throwing.
- **Ollama connection failure noise (#681, #709):** Ollama `fetch failed` errors are no longer reported to the error tracker when Ollama is not configured; they are swallowed as expected unavailability.
- **Connection error circuit-breaker noise (#703, #713):** Generic "Connection error" and network errors are filtered from Sentry/GlitchTip SDK config to avoid alert fatigue when the network is temporarily unavailable.
- **Persona reflection — missing requirements (#647, #674, #675):** Fixed incomplete requirements resolution in the persona reflection pass that caused the pipeline to skip promotion steps silently.
- **Autonomous queue duplicate dispatch (#634):** Prevented the autonomous task queue from dispatching the same issue twice when a GitHub branch isn't yet visible during fast successive queue runs.
- **Gateway register parse failure (#661):** Isolated `hybridConfigSchema` to prevent the gateway registration parse from failing when the plugin config has extra top-level keys.
- **Upgrade missing @lancedb/lancedb (#636, #663):** Upgrade from 2026.3.181 no longer risks missing the native LanceDB bindings; postinstall script now checks for and rebuilds them when needed.
- **`fix(embedding)`: primary model/dimension alignment (#05b52d44):** Ensured the primary embedding model always resolves to consistent dimensions on backward-compatible stores to prevent re-indexing on restart.
- **Google embedding — gemini-embedding-001 (#8240914a):** Updated Google embedding to use `gemini-embedding-001` (the current model name after Google renamed `text-embedding-004`/`005`). Dimension chaining and verify output now reflect the corrected model.
- **CI actions failure on main branch (#733, #734):** Fixed concurrency and branch filter issues that caused CI to fail when running directly against `main`.

### Changed

- **FactsDB refactor (#638, #649):** `backends/facts-db.ts` split by responsibility boundary into focused sub-modules (retrieval, write, consolidation, decay), reducing module size and coupling.
- **Bootstrap slimmed (#640, #659):** Context-bag and service registration assembly streamlined — removed redundant tool registrations and tightened the wiring between plugin init and feature flags.
- **Google embedding — migrated to gemini-2.5-flash-lite (#e11c5ec1):** The Google embedding provider now defaults to the `gemini-2.5-flash-lite` model for classification/distill use cases (lower cost, same quality for short texts).
- **Error reporting filter (#704, #715):** Noisy network errors, auth failures, and circuit-breaker events are now filtered out of the Sentry SDK config. Only actionable plugin-internal errors reach the tracker.
- **Dependency updates:** `fast-xml-parser` bumped; minor/patch dependency group updated across `extensions/memory-hybrid`.

### Developer / Internal

- **Architecture lint rules (#637):** `lint-arch.sh` now enforces the boundary between the core runtime and adjacent subsystems. Violations fail CI.
- **PR template (#ae8d8fde):** Strict documentation requirements added to the pull request template — every PR must document user-facing impact and include test evidence.
- **Test improvements:** Fixed narrative-recall test timestamps (2025 → 2026), lease expiry bug in task-queue tests, and FTS5 degradation test coverage.

---

## [2026.3.181] - 2026-03-18

### Fixed

- **Release workflow:** Resolved concurrency deadlock when Release runs on tag push (caller and called CI workflow shared the same concurrency group). Release now uses a distinct group (`release-cd-${{ github.ref }}`) so the workflow completes and creates the GitHub Release and publishes to npm.

---

## [2026.3.180] - 2026-03-18

### Release summary (user-friendly)

This release includes a **security override** for the Hono node server dependency and documents **migration steps** for the retrieval pipeline API and Google embedding default change.

### Security

- **Override @hono/node-server to >=1.19.10 <2 (GHSA-wc8c-qw6v-h7f6):** Added npm `overrides` to force `@hono/node-server` to a patched version. The unbounded range is capped at `<2` to prevent accidental major-version upgrades.

### Migration notes

- **`runRetrievalPipeline` signature changed to options bag — breaking change (#501):** The function signature was refactored from many optional positional parameters to a single `RetrievalPipelineOptions` object. `runRetrievalPipeline` is re-exported from the package root (`extensions/memory-hybrid/index.ts`), so **any external consumer calling the old positional form must migrate**.

  Before:
  ```ts
  await runRetrievalPipeline(query, queryVector, db, vectorDb, factsDb, config, budgetTokens, tagFilter, ...);
  ```
  After:
  ```ts
  await runRetrievalPipeline(query, queryVector, db, vectorDb, factsDb, { config, budgetTokens, tagFilter, ... });
  ```
  The five required positional parameters (`query`, `queryVector`, `db`, `vectorDb`, `factsDb`) are unchanged; everything else moves into the `options` bag. Omitting any option preserves existing default behaviour.

- **Google embedding model default changed: `text-embedding-004` → `gemini-embedding-001` (#385):** If your deployment previously used `text-embedding-004` (explicitly or as the inferred default), switching to `gemini-embedding-001` produces different vector representations. **Existing LanceDB tables indexed with `text-embedding-004` will have degraded semantic retrieval quality until re-indexed.** Run `openclaw hybrid-mem re-index` after upgrading to rebuild the vector index with the new model. To keep using `text-embedding-004`, set `embedding.model: "text-embedding-004"` explicitly in your plugin config.

---

## [2026.3.152] - 2026-03-15

### Changed

- **config-set:** Simpler toggle syntax: use `openclaw hybrid-mem config-set <feature> enabled|disabled` (e.g. `config-set nightlyCycle enabled`) instead of `config-set nightlyCycle.enabled true`. Values validated; unknown values return a clear error. `costTracking` added to object toggles.
- **verify:** Clear summary and guidance after Embeddings/LLM tables. "Embeddings: OK" / "LLMs: OK" lines and a single "Summary: Ready" or "Summary: Fix the issue(s)…" so users know at a glance if setup is good. Source column no longer blank (shows "gateway" or "—" when key is not in plugin config). "In config" shows "No" instead of "—" for reference models. Legend explains Source and In config.

### Fixed

- **verify:** Empty Source column when API keys come from gateway/env; now shows "gateway" or "—". "In config" column now explicitly "No" when model is not in llm.nano/default/heavy.

---

## [2026.3.151] - 2026-03-15

### Fixed

- **Plugin config schema (OpenClaw validation):** `config.mode` enum in `openclaw.plugin.json` now includes `local`, `minimal`, `enhanced`, `complete` so configs using the new preset names pass OpenClaw validation. Legacy values (`essential`, `normal`, `expert`, `full`) remain accepted.

### Changed

- **Verify output:** Full embedding and LLM tables always visible (not suppressed in quiet). LLM table shows one row per model (from config + reference list), with Model, Provider, Auth, Source, In config, Enabled. Reference models (Opus, GPT-5.4, Codex, o3, etc.) always listed.

---

## [2026.3.150] - 2026-03-15

### Release summary (user-friendly)

This release adds **Phase 3 modularization** and **Phase 2.3 lifecycle staging**, plus **OAuth-first auth with smart failover** and clearer **configuration modes**.

- **OAuth preferred when both OAuth and API key exist** — The plugin now tries OAuth first when a provider has both. If OAuth fails (e.g. gateway down), it automatically falls back to your API key and uses **incremental backoff** (5 min → 30 min → 1 h → 2 h → 4 h) before retrying OAuth. You can clear backoff anytime with `openclaw hybrid-mem reset-auth-backoff`. See [LLM-AND-PROVIDERS.md](docs/LLM-AND-PROVIDERS.md).
- **Configuration mode names updated** — Modes are now `local` | `minimal` | `enhanced` | `complete`. **Default when omitted is `local`** (backward compatible with previous “full” behavior). Deprecated names (`essential`, `normal`, `expert`, `full`) are reset to **`local`** and a one-time warning is logged; set the new mode explicitly to enable LLM or other features. See [CONFIGURATION-MODES.md](docs/CONFIGURATION-MODES.md).
- **New CLI** — `openclaw hybrid-mem config` shows effective config and mode; `openclaw hybrid-mem reset-auth-backoff` clears OAuth failover state. `verify` gains `--test-llm` and richer Embeddings/LLM tables (credential source, OAuth vs API results, disabled providers).
- **Memory-to-skills removed** — The `skills-suggest` command, cron job, and related config/docs have been removed. Use workflow crystallization and tool proposals instead.
- **Stable internal API** — Optional modules can depend on `MemoryPluginAPI` (see `api/memory-plugin-api.ts`) for tool and lifecycle registration without circular dependencies.
- **Lifecycle pipeline** — Hooks are decomposed into staged pipeline (setup, recall, injection, capture, cleanup) with per-stage timeouts and toggles.

### Added

- **OAuth failover and backoff:** When OAuth fails for a provider that also has an API key, the plugin records the failure and uses the API key. Retries to OAuth use a configurable backoff schedule (default: 5 min, 30 min, 1 h, 2 h, 4 h). State is stored in `.auth-backoff.json` next to the SQLite DB. Config: `auth.preferOAuthWhenBoth` (default `true`), `auth.backoffScheduleMinutes`, `auth.resetBackoffAfterHours` (default 24). See [LLM-AND-PROVIDERS.md](docs/LLM-AND-PROVIDERS.md).
- **CLI `reset-auth-backoff`:** Clears OAuth failover state so the next LLM call tries OAuth again for providers with both OAuth and API key.
- **CLI `config`:** New subcommand to print effective plugin config and detected mode (or “Custom” when presets are overridden).
- **`verify --test-llm`:** Runs minimal completions per provider and reports OAuth vs API result separately; shows credential source (env, file, plugin, gateway, local) and honors `llm.disabledProviders`.
- **Stable `MemoryPluginAPI`:** Type in `api/memory-plugin-api.ts` consumed by `registerTools` and `registerLifecycleHooks` so optional modules can depend on a single API surface.
- **Config:** `llm.disabledProviders` (array of provider IDs to exclude from all LLM use), `procedures.maxInjectionTokens` (default 500), mode presets for `local` / `minimal` / `enhanced` / `complete`.

### Changed

- **Default mode:** When `mode` is omitted, the plugin uses **`local`** (cost-safety: no external LLM, FTS-only). Set `"mode": "minimal"`, `"enhanced"`, or `"complete"` to enable LLM and other features.
- **Deprecated mode mapping:** All deprecated names (`essential`, `normal`, `expert`, `full`) are **reset to `local`**. A one-time warning is logged; set the new mode explicitly to restore higher tiers.
- **Lifecycle:** Single `pluginContext` (typed as `MemoryPluginAPI`) is passed into `registerLifecycleHooks` and `registerTools`. Hooks are implemented as staged pipeline (setup, recall, injection, capture, cleanup) with config toggles and timeouts.
- **Local / FTS-only:** When mode is `local`, retrieval uses FTS-only (no embeddings or vector DB). Capture and recall skip embedding/vector work when semantic retrieval is disabled.
- **Procedure injection:** Capped by `procedures.maxInjectionTokens`; blocks are trimmed to stay within the cap.

### Removed

- **Memory-to-skills feature:** `skills-suggest` CLI command, cron job, `memory-to-skills` service, prompts, and related config/types/docs. Maintenance cron set reduced from 9 to 8 jobs.

### Fixed

- **Credential source fallback:** `credentialSource` now returns empty string for missing keys so verify’s fallback logic correctly shows the actual source (e.g. `llm.providers` with `env:`).
- **Google LLM base URL:** Removed `/v1` appending in `buildDirectClient` so Google’s `v1beta/openai/` endpoint is used correctly in `verify --test-llm`.
- **Stale references:** Removed `skills-suggest` from CLI help and command list after feature removal.

### Migration notes

- If you used **deprecated mode names** (`essential`, `normal`, `expert`, `full`), the plugin resets them to **`local`**. Set `"mode": "minimal"`, `"enhanced"`, or `"complete"` explicitly to enable LLM and other features.
- If you relied on **memory-to-skills** or **skills-suggest**, remove those from cron/config; use workflow crystallization and tool proposals instead.
- **OAuth + API key** users: no change required; OAuth is preferred by default and API key is used on failure with backoff. Use `openclaw hybrid-mem reset-auth-backoff` to clear backoff if needed.

---

## [2026.3.140] - 2026-03-14

### Changed

- **Version 2026.3.140:** Bump for Phase 1 remodeling release.
- **Upgrade migration (core-only baseline):** When running plugin version **2026.3.140 or later**, config parsing applies a **Phase 1 core-only migration**. The plugin **overrides** every listed option to the disabled value, **including values the user had set**, so all installations get the same baseline. Affected areas: `queryExpansion`, `frustrationDetection`, `nightlyCycle`, `passiveObserver`, `workflowTracking`, `selfExtension`, `crystallization`, `verification`, `provenance`, `aliases`, `crossAgentLearning`, `reranking`, `contextualVariants`, `documents`, `personaProposals`, and `graph.strengthenOnRecall`. To re-enable any feature, set it explicitly in your plugin config after upgrading (e.g. `queryExpansion: { enabled: true }`).

---

## [2026.3.110] - 2026-03-11

### Fixed

- **GlitchTip false-positive for UnconfiguredProviderError in mixed fallback chains (#328):** In `chatCompleteWithRetry`, when the final fallback model threw `UnconfiguredProviderError` but an earlier model in the chain had failed for a different reason (e.g. ECONNREFUSED, rate limit), the `else if (unconfiguredCount > 0)` branch was incorrectly reporting the error to GlitchTip. `UnconfiguredProviderError` is always a config issue, not a code bug — GlitchTip reporting is now suppressed whenever the final error is an unconfigured-provider error, regardless of what earlier models failed with.
- **Qwen3 thinking mode empty responses (#314):** Qwen3 models running via Ollama default to `enable_thinking=true`, which places the actual model output in `message.reasoning_content` (current standard) or the legacy `message.reasoning` field while leaving `message.content` empty. `chatComplete()` now falls back to these fields when `content` is empty, so cron agents routing to `ollama/qwen3:*` receive the full response instead of timing out on a blank reply. Non-Qwen models are unaffected.

---

## [2026.3.100] - 2026-03-10

Major stability release: LanceDB OOM fix, provider hardening, 4-model council review, 13 bug fixes, cron guard system.

### Added

- **LanceDB auto-compaction (#292):** `VectorDB.optimize()` method with race-condition guard (`promiseRef` pattern). Auto-compacts after every 100 `store()` calls. New CLI command `openclaw hybrid-mem optimize` for manual compaction. Weekly cron job integration.
- **Cron job re-run guards (#304, #305):** `buildGuardPrefix()` generates `MIN_INTERVAL_MS` checks using `/tmp/hybrid-mem-guard-<job>.txt` timestamp files. Three tiers: daily (20h), weekly (5d), monthly (25d). Prevents jobs re-firing on every gateway restart.
- **Per-URL Ollama circuit breaker (#298):** Module-level circuit breaker tracks failures per endpoint URL instead of globally. Prevents one bad Ollama endpoint from disabling all local models.
- **Transient error retry logic (#301, #302):** LLM request timeouts and 5xx errors are now retried with configurable limits. Connection errors trigger graceful fallback to next provider.
- **`Retry-After` header parsing (#296):** 429 rate-limit responses now respect the server's `Retry-After` header with exponential backoff.
- **Provider fallback chain (#294, #300):** `UnconfiguredProviderError` now resolves fallback keys for OpenRouter, Anthropic, and generic API configurations. Embedding provider chain exhaustion handled gracefully — stores facts without embeddings when all providers fail.
- **`is404Like` detection (#303):** LLM 404 responses (model not found) now skip retry loops and move to next model immediately.
- **Try/finally scan locks:** `extract-directives`, `extract-reinforcement`, and `self-correction-run` now release concurrency locks in `finally` blocks, preventing lock leaks on errors.
- **Gateway token leak fix (#init-databases):** Removed `OPENCLAW_GATEWAY_TOKEN` from the OpenAI provider fallback chain — was sending internal gateway tokens to external endpoints.
- **Scan cursor fix:** `getScanCursor()` now returns `last_run_at` (not `last_session_ts`), fixing the 23-hour guard to check actual run time.
- **`$HOME` expansion fix (#299):** `.last-post-upgrade-version` path now expands `$HOME` explicitly in `plugin-service.ts`.
- **401 fast-fail (#295):** Authentication errors skip retry loops and fall back to next provider immediately.
- **Config validation (#289):** Placeholder API key detection for `embedding.apiKey`. Nano-tier defaults for all background features.

### Changed

- **LLM tier defaults:** Background features (autoClassify, HyDE, query expansion, summarize) default to nano tier. Self-correction spawn model changed to Sonnet. Distill model tier defaults to Flash.
- **Incremental processing for all scans (#288):** Watermark-based scan cursors. Full re-index only on explicit `--full` flag.

### Fixed

- 13 bugs identified from GlitchTip error reports (#294–#303) plus cron re-trigger (#304)
- LanceDB OOM crashes: 9036 uncompacted fragments → 1 after optimize (freed 2.6 GB)
- Race condition in `VectorDB.optimize()`: circular promise reference fixed with intermediate `promiseRef` variable
- All 76 review threads from 4-model council review (GPT, Opus, Gemini, Sonnet) resolved

### Security

- Gateway token no longer leaked to external OpenAI-compatible endpoints
- 401 errors no longer trigger infinite retry loops exposing invalid keys

---

## [2026.3.92] - 2026-03-10

Incremental extraction, startup guards, nano-tier defaults, and schema fix (#288/#289).

### Added

- **Incremental extraction (#288):** `extract-procedures`, `extract-directives`, `extract-reinforcement`, `distill`, and `self-correction-run` now maintain a watermark (`scan_cursors` table in SQLite). On each run they process only sessions created after the last successful scan, making nightly jobs fast regardless of session history size. `--full` forces a full re-scan and bypasses the watermark; `--dry-run` never writes the cursor.

- **Startup guards — 23-hour rate-limit (#289):** Each scan type checks the cursor's `lastRunAt` timestamp before acquiring the concurrency lock. If less than 23 hours have passed the job is skipped with a log message (`skipped: true`). Prevents runaway double-execution when OpenClaw retries a failed job.

- **`scan_cursors` schema (#288):** New SQLite table (`scan_type TEXT PRIMARY KEY, last_session_ts INTEGER, last_run_at INTEGER, sessions_processed INTEGER`) created during DB init. Seeded with a migration guard so existing databases upgrade automatically.

### Changed

- **`extractionModelTier` default changed to `"nano"`:** `extract-reinforcement` now defaults to the nano-tier model (e.g. `gpt-4.1-nano`) when `distill.extractionModelTier` is unset. Previously it defaulted to `"heavy"`. Expert and Full presets set `extractionModelTier: "default"` to opt into the standard-tier model. This significantly reduces cost for most users.

- **`weekly-extract-procedures` job model:** The cron job is now scheduled with `modelTier: "nano"` so the agent that orchestrates the extraction steps uses a cheap model. The LLM step inside `extract-reinforcement` is still controlled by `distill.extractionModelTier`.

### Fixed

- **Schema init order:** `scan_cursors` table is now created before any index is built, fixing a startup error on fresh installs.

---

## [2026.3.91] - 2026-03-09

Memory Dashboard: Lovable web UI, shared REST API, and multi-dashboard layout (placeholders for GPT/Gemini/Claude).

### Added

- **Memory Dashboard (Lovable):** Web UI in `dashboard/lovable/` for hybrid-memory inspection: overview stats (total facts, categories, links, issues, cost), facts-by-category/tier/decay and recent facts; interactive memory graph (force-directed, filters, node detail); facts explorer (paginated table with category/tier/search filters); issue tracker; knowledge clusters; cost & usage (daily/model/feature charts); feature configuration (read-only toggles from plugin config); workflow patterns. Built with React 18, TypeScript, Vite, Tailwind, shadcn/ui, Recharts, react-force-graph-2d. Uses mock data when no API is configured; set `VITE_API_BASE` to use the dashboard API for live data. Base path `/plugins/memory-dashboard/lovable/` for production hosting.

- **Dashboard REST API:** Standalone HTTP server in `extensions/memory-hybrid/scripts/dashboard-api.ts`. Run with `npm run dashboard-api` from the extension directory (listens on port 18790; `PORT` env to override). Reads OpenClaw config from `OPENCLAW_HOME` or `~/.openclaw` and serves live data from FactsDB, IssueStore, CostTracker, and WorkflowStore. Endpoints: `GET /api/stats`, `/api/facts`, `/api/facts/:id`, `/api/graph`, `/api/issues`, `/api/clusters`, `/api/cost`, `/api/config`, `/api/workflows`. CORS enabled for local dashboard use. No new runtime dependencies; uses `tsx` (devDependency) to run the TypeScript script.

- **Multi-dashboard layout:** `dashboard/` contains `lovable/` (full app), plus placeholders `gpt/`, `gemini/`, `claude/` with READMEs so you can add dashboards generated from the same brief by different tools and compare results. All dashboards use the same API contract; see `dashboard/README.md` for shared API instructions and how to add new dashboards.

### Documentation

- **dashboard/README.md:** Describes layout (lovable vs gpt/gemini/claude), shared API (run from `extensions/memory-hybrid`), how to run each dashboard (mock vs real data), and how to add GPT/Gemini/Claude dashboards.
- **dashboard/lovable/README.md:** Lovable-specific quick start (dev with mock, dev with API, production build), API endpoints table, tech stack, project structure.
- **README.md (root):** Memory Dashboard section updated: one shared API, multiple dashboards (lovable, gpt, gemini, claude) for comparing briefs; link to `dashboard/README.md`.

---

## [2026.3.90] - 2026-03-09

Milestone A+B: future-date decay, episodic event log, local embeddings (Ollama/ONNX), multi-model RRF, contextual variants, query expansion, re-ranking, verification store, provenance tracing, document ingestion; real-time frustration detection and cross-agent learning (#263/#265); dependency bumps.

### Added

- **Future-date decay protection (#144):** Facts containing future dates have their `decay_freeze_until` timestamp set to prevent them from expiring before they are relevant. Enabled by default. Config: `futureDateProtection.enabled` (default: `true`), `futureDateProtection.maxFreezeDays` (default: `365`; `0` = no limit). See [CONFIGURATION.md](docs/CONFIGURATION.md#future-date-decay-protection-144).

- **Episodic event log — Layer 1 passive capture (#150):** New `event-log.db` database alongside `memory.db` provides a high-fidelity, append-only session journal of all events (facts learned, decisions made, actions taken, entities mentioned, preferences expressed, corrections). Raw episodic events are cheap to write and serve as raw material for the Dream Cycle consolidation pipeline. API: `append()`, `appendBatch()`, `getBySession()`, `getByTimeRange()`, `getUnconsolidated()`, `getByEntity()`, `markConsolidated()`, `archiveConsolidated()`, `getStats()`. Config: `eventLog.archivalDays` (default: 90), `eventLog.archivePath`. See [extensions/memory-hybrid/docs/event-log.md](extensions/memory-hybrid/docs/event-log.md).

- **Local embedding switch — Ollama/ONNX providers (#153):** The embedding system now supports `provider: "ollama"` and `provider: "onnx"` in addition to `"openai"` and `"google"`. Local providers require no API key. Ollama connects to a running Ollama server (default `http://localhost:11434`); ONNX runs inference in-process via `@xenova/transformers`. Known model dimensions are auto-detected; unknown models require explicit `dimensions`. Config: `embedding.provider`, `embedding.model` / `embedding.ollamaModel` / `embedding.onnxModelPath`, `embedding.endpoint`, `embedding.autoMigrate`. See [CONFIGURATION.md](docs/CONFIGURATION.md#local-embedding-providers-153).

- **Multi-model embedding registry + RRF merge (#158):** Each fact can be embedded by multiple models simultaneously. Configure `embedding.multiModels` as an array of `{ name, provider, dimensions, role }` entries. At recall time, each model contributes a ranked list and Reciprocal Rank Fusion (RRF) merges them into a single result ranked by cross-model agreement. Supports mixing `openai`, `ollama`, and `onnx` providers. See [CONFIGURATION.md](docs/CONFIGURATION.md#multi-model-embedding-registry-158).

- **Contextual variants at index time (#159):** When enabled, a cheap LLM generates alternative phrasings of each stored fact. These variants are embedded and stored as additional LanceDB vectors linked to the parent fact, improving recall for paraphrased queries without requiring query expansion at retrieval time. Config: `contextualVariants.enabled`, `contextualVariants.model`, `contextualVariants.maxVariantsPerFact` (default: 2, max: 5), `contextualVariants.maxPerMinute` (default: 30), `contextualVariants.categories`. See [CONFIGURATION.md](docs/CONFIGURATION.md#contextual-variants-at-index-time-159).

- **Query expansion via LLM (#160):** Before embedding a retrieval query, a cheap LLM expands it into multiple variants (hypothetical answer style or paraphrase). All variants are embedded and their vector results are merged before RRF. Three modes: `"always"`, `"conditional"` (run only when initial score is below threshold), `"off"`. Includes an LRU cache to avoid redundant expansion calls. Replaces the deprecated `search.hydeEnabled` / `search.hydeModel`. Config: `queryExpansion.enabled`, `queryExpansion.mode`, `queryExpansion.threshold`, `queryExpansion.model`, `queryExpansion.maxVariants` (default: 4), `queryExpansion.cacheSize` (default: 100), `queryExpansion.timeoutMs` (default: 5000). See [CONFIGURATION.md](docs/CONFIGURATION.md#query-expansion-queryexpansion).

- **LLM re-ranking in retrieval pipeline (#161):** After RRF fusion, the top-N candidates are presented to an LLM for semantic re-ordering. On timeout or LLM failure, the original RRF order is used as a fallback. Config: `reranking.enabled`, `reranking.model`, `reranking.candidateCount` (default: 50), `reranking.outputCount` (default: 20), `reranking.timeoutMs` (default: 10000). See [CONFIGURATION.md](docs/CONFIGURATION.md#llm-re-ranking-161).

- **Verification store — integrity checking + auto-classify (#162):** Critical facts can be enrolled into a verification store that persists them to an append-only `verified-facts.json` backup and tracks them for scheduled re-verification. `autoClassify: true` (default) auto-enrolls facts tagged as `critical`. New agent tools: `memory_verify` (enroll a fact), `memory_verified_list` (list all verified facts), `memory_verification_status` (check a specific fact). Config: `verification.enabled`, `verification.backupPath`, `verification.reverificationDays` (default: 30), `verification.autoClassify` (default: true), `verification.continuousVerification`, `verification.cycleDays` (default: 30), `verification.verificationModel`. See [CONFIGURATION.md](docs/CONFIGURATION.md#verification-store-162).

- **Provenance tracing — DERIVED_FROM edges + memory_provenance tool (#163):** When enabled, the plugin records the full origin chain of every fact: which session it came from, which episodic events it was derived from, and which facts it was consolidated from. Provenance data is stored in `provenance.db` using `DERIVED_FROM` and `CONSOLIDATED_FROM` edges. New agent tool: `memory_provenance(factId)` returns the full chain up to 10 hops deep. Config: `provenance.enabled` (default: false), `provenance.retentionDays` (default: 365). See [CONFIGURATION.md](docs/CONFIGURATION.md#provenance-tracing-163).

- **Document ingestion — folder ingestion, progress callbacks, hash dedup, vision (#206):** New tools `memory_ingest_document` and `memory_ingest_folder` convert documents (PDF, DOCX, PPTX, XLSX, HTML, Markdown, CSV, EPUB, images, and more) to Markdown via the MarkItDown Python bridge, chunk the result, and store each chunk as a fact. Features: SHA-256 hash deduplication (skip duplicate documents), structured progress callbacks (`{ stage, pct, message }`), LLM vision for image files, optional path allowlist for security, configurable chunk size and overlap. Config: `documents.enabled` (default: false — opt-in), `documents.pythonPath` (default: `python3`), `documents.chunkSize` (default: 2000), `documents.chunkOverlap` (default: 200), `documents.maxDocumentSize` (default: 50 MB), `documents.autoTag` (default: true), `documents.visionEnabled` (default: false), `documents.visionModel`, `documents.allowedPaths`. Requires `pip install markitdown`. See [CONFIGURATION.md](docs/CONFIGURATION.md#document-ingestion-206).

- **Real-time frustration detection, cross-agent learning, tool effectiveness (#263, #265):** Frustration signals from user messages are detected in real time; cross-agent learning and tool effectiveness scoring improve recall and tool recommendations.

### Documentation

- **CONFIGURATION.md:** New sections for all 10 Milestone A+B features: future-date decay protection (#144), local embedding providers — Ollama/ONNX (#153), multi-model embedding registry (#158), contextual variants (#159), LLM re-ranking (#161), verification store (#162), provenance tracing (#163), and document ingestion (#206). Query expansion (#160) section was already present and has been retained.
- **FEATURES.md:** Feature table extended with entries for all 10 issues (#144-#206) with links to the relevant CONFIGURATION.md anchors.
- **CLI-REFERENCE.md:** Commands-by-category table; run-all, generate-proposals, scope list/stats/prune/promote, active-tasks; full 9 maintenance cron jobs table (nightly-memory-sweep, self-correction-analysis, nightly-memory-to-skills, nightly-dream-cycle, weekly-reflection, weekly-extract-procedures, weekly-deep-maintenance, weekly-persona-proposals, monthly-consolidation); verify --fix description updated.
- **cron-jobs.ts:** Aligned with handlers.ts: all 9 jobs with shell-command form; comment that canonical source is MAINTENANCE_CRON_JOBS in handlers.ts.

### Changed

- **Dependencies:** Minor and patch dependency bumps (minor-and-patch group, #266).

---

## [2026.3.72] - 2026-03-07

### Fixed

- **Release workflow:** "Set package version" step no longer fails when package.json already matches the tag (avoids `npm error Version not changed` on publish).

---

## [2026.3.71] - 2026-03-07

Documentation and UX: benefits-first messaging, multilingual, and analyze-feedback-phrases improvements.

### Added

- **README "Why you'll want this":** Plain-English benefits section (short- and long-term), bullets for remembers you, recalls the right stuff, learns from reactions, gets more personal, multilingual. Technical comparison table under "Why use this? (under the hood)". Documentation table links to new section.
- **Multilingual callout:** README and benefits now state that the plugin works in your language and adapts (build-languages, feedback-phrase learning).
- **analyze-feedback-phrases sentiment pre-filter:** Messages already matching reinforcement/correction regexes are skipped. Remaining messages are labeled by a nano-tier model (positive_feedback / negative_feedback / neutral); only positive/negative go to the heavy-tier phrase extractor. If none remain, heavy call is skipped. Model-agnostic (nano + heavy from config).
- **analyze-feedback-phrases 30/3-day window:** When `--days` is omitted, first run (or no `.user-feedback-phrases.json`) uses 30 days; subsequent runs use 3 days. `UserFeedbackPhrases.initialRunDone` persisted on `--learn`.

### Changed

- **QUICKSTART, FEATURES, HOW-IT-WORKS, FAQ:** Benefits-first intros and links to README "Why you'll want this".
- **CLI-REFERENCE, SELF-CORRECTION-PIPELINE:** analyze-feedback-phrases documented with nano pre-filter, auto 30/3 days, model-agnostic.

---

## [2026.3.70] - 2026-03-07

Major release: Hybrid Memory redesign, CI/CD automation with NPM Trusted Publishing, search/config improvements, and quality fixes.

### Added

- **Complete Hybrid Memory Redesign (#198):** Memory-first architecture with 18 features: dynamic memory tiering (hot/warm/cold) with configurable `memoryTiering.hotMaxTokens`, `compactionOnSessionEnd`, `inactivePreferenceDays`, and `hotMaxFacts`; multi-agent scoping with `multiAgent.orchestratorId` and `defaultStoreScope` (global/agent/auto); runtime agent detection for auto-scoped facts; retrieval and storage integrated with tiering and scope filters; preset alignment (normal/expert/full) for tiering and ingest; workflow integration hooks for session start/end and compaction.
- **Memory-first auto-recall features (#221):** Enhanced auto-recall with retrieval directives (`autoRecall.retrievalDirectives`): entity-mentioned recall, keyword triggers, task-type triggers, optional session-start recall; configurable `limit`, `maxPerPrompt`; entity lookup and directive recall merged into injection pipeline; agent-scoped memory and scope filtering in recall so specialists see only relevant scoped facts.
- **Workflow crystallization and self-extension (#208, #209, #210):** (1) **Workflow store & tool-sequence tracking:** Session tool sequences recorded and grouped into patterns with success rates. Tool `memory_workflows`: query patterns by goal (keyword-matched), filter by `minSuccessRate`, optional `limit`. (2) **Crystallization tools:** `memory_crystallize` analyses workflow patterns and generates pending AgentSkill SKILL.md proposals (human approval required); `memory_crystallize_list` / `memory_crystallize_approve` / `memory_crystallize_reject` list and approve/reject; approved proposals write skills to disk. (3) **Self-extension tools:** `memory_propose_tool` runs gap analysis on workflow traces to detect recurring workarounds and generates tool proposals; `memory_tool_proposals` / `memory_tool_approve` / `memory_tool_reject`; requires `selfExtension.enabled: true`; config supports `minFrequency`, `minToolSavings`.
- **Scope promote CLI (#134):** Subcommand `openclaw hybrid-mem scope promote` promotes high-importance session-scoped facts to global scope. Options: `--dry-run`, `--threshold-days <n>` (default 7), `--min-importance <n>` (default 0.7). Uses `findSessionFactsForPromotion` then `promoteScope(id, "global", null)`. Integrated into weekly-deep-maintenance cron (Saturday 04:00): compact then scope promote.
- **CI/CD:** CI workflow (typecheck Node 22/24, lint, test, coverage); PR checks; release workflow (tag `v*` or manual dispatch → CI, GitHub Release, then NPM publish for `openclaw-hybrid-memory` and `openclaw-hybrid-memory-install`). Version from tag; main package runs `verify:publish` before publish. **NPM Trusted Publishing:** OIDC only (no `NPM_TOKEN`); `id-token: write` per publish job; configure Trusted Publisher on npmjs.com for workflow `release.yml` for both packages; MFA can stay enabled.
- **Security & quality:** CodeQL workflow; Dependabot config; branch protection recommendations; labeler workflow for PRs (`.github/labeler.yml`).

### Changed

- **Search / query expansion (#228, #160):** Deprecated `search.hydeEnabled` and `search.hydeModel` in favor of `queryExpansion.enabled` and `queryExpansion.model`. Migration: if `search.hydeEnabled` is true and `queryExpansion.enabled` not set, queryExpansion is auto-enabled and model defaults to `search.hydeModel` or nano tier; `queryExpansion.enabled: false` overrides. Parser logs deprecation; timeout 25s when migrating from HyDE, 5s for direct queryExpansion. Preset `full` sets `queryExpansion.enabled: true` directly.
- **Error reporting:** Opt-out defaults: when `errorReporting` omitted, `enabled` and `consent` default to `true`; community mode uses hardcoded DSN. Opt out with `errorReporting.enabled: false` or `consent: false`.
- **Dependencies:** Actions setup-node/cache/checkout → v6; upload-artifact → v7; codeql-action → v4; minor-and-patch group (#173).
- **Repo quality:** ESLint + Prettier; Yarbo standards (#175); TypeScript strict mode errors resolved (#174).

### Fixed

- **Promotion:** Inconsistent `superseded_at` filter in `findSessionFactsForPromotion` corrected.
- **Verify:** `agents.defaults.pruning` correctly flagged as invalid (#105, #138).
- **Config:** `"env"` added to safe-config-write allowlist (#136).
- **CI:** Coverage provider; CodeQL matrix; label creation; pagination for label listing and listComments; workflow security/code quality; size label flapping.
- **Query expansion / HyDE:** HyDE timeout consistency; queryExpansion migration edge cases; model fallback and tests (#228).

---

## [2026.02.271] - 2026-02-27

Memory-to-skills disabled by default and boilerplate filter fix.

### Changed

- **Memory-to-skills:** Pipeline is **disabled by default**. Set `memoryToSkills.enabled: true` in config to run clustering/synthesis. Nightly job and `skills-suggest` exit cleanly when disabled.
- **Memory-to-skills boilerplate filter:** Skip clusters whose task pattern is the injected memory preamble (e.g. `<relevant-memories>` or "The following memories may be relevant") so snippet-derived clusters no longer produce misleading skills.

### Fixed

- Clusters with task text like "<relevant-memories> The following memories may be relevant: …" are now skipped instead of generating skills tied to injected context.

---

## [2026.02.270] - 2026-02-27

Feature and fix release: LanceDB dimension-mismatch graceful fallback and auto-repair (#128, #129), VectorDB reference-counted lifecycle and reconnection fixes (#106, #107), security and CodeQL fixes (#118–#127), credentials get/list CLI and config-set fix, proposal apply and workspace resolution fixes (#90), verify activeTask, npm package files (#71), and docs.

### Added

- **VectorDB dimension mismatch:** Graceful fallback when LanceDB table dimension does not match configured embedding model: search/count/hasDuplicate return empty/0/false and log a clear warning instead of crashing. Optional `vector.autoRepair: true` drops and recreates the table with the correct dimension and triggers re-embedding from SQLite (issue #128, #129).
- **Credentials CLI:** `openclaw hybrid-mem credentials get` and `credentials list --service <filter>` for vault inspection.
- **Verify:** Active-task (ACTIVE-TASK.md) status shown in `openclaw hybrid-mem verify` output.
- **CI:** GitHub Actions labeler workflow for PRs; CodeQL suppressions where applicable.

### Fixed

- **VectorDB:** Reference-counted singleton prevents premature close when multiple sessions use the plugin (#106). Race condition in `VectorDB.open()` by deferring state cleanup to `ensureInitialized()`; clear `initPromise` in `open()` so reconnection is not blocked; try-catch in `_doClose()`; run `removeSession()` at end of `agent_end` (#107).
- **VectorDB auto-repair:** Re-embedding bugs fixed: track IDs instead of indices, check duplicates, handle delete errors; stale table handle on failed repair; incomplete re-embedding on hot reload; re-embedding loop leak on hot reload; skip auto-repair when dimension is unreadable.
- **Proposals:** ProposalsDB prune timer guard (#130). Restore `isGitRepo` guard for proposal apply to avoid applying outside a git repo (#90). Resolve proposal target files against workspace, not plugin data dir. Add `proposals show` subcommand to manage CLI.
- **Security (CodeQL/alert fixes):** Shell command built from env values (#119); password hash / scrypt handling (#120, #127); prototype-polluting deep merge (#121, #122, #118); ReDoS-safe regex in `resolveEnvVars` (js/polynomial-redos); HTML filtering regex (#125). Restore v1 KDF to scrypt to prevent data loss in existing vaults.
- **Config/CLI:** `config-set errorReporting true` now sets an object (enabled/consent) instead of a boolean. Claude provider support in cron model resolution; reset git staging on proposal commit rollback.
- **Credentials/stats:** Credential security and stats accuracy fixes.
- **Package:** Add missing `setup/`, `lifecycle/`, `tools/` to npm package files (#71).

### Changed

- **Docs:** Remove unsupported `agents.defaults.pruning` from setup and config (#105). Copilot review instructions. PR-133 merge analysis for memory-to-skills revert.
- **CI:** Labeler workflow uses `pull_request` (not `pull_request_target`); labeler action v5; fix label logic to use OR for glob patterns.
- **Version bump** — Release 2026.02.27 (npm `2026.02.270`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.02.240] - 2026-02-24

Feature and fix release: active-task working memory for multi-step tasks (#99, #104), VectorDB auto-reconnect after close (#103), credentials hardening and audit/prune/dedup CLI (#98), stats zero-hints clarification (#101), and related fixes.

### Added

- **Active-task working memory:** ACTIVE-TASK.md doc, heartbeat stale warnings, duration parser, `staleThreshold` config, stashCommit preservation, injection budget checks, file path resolved against workspace root, original task start time in subagent_start; legacy `staleHours` rejects fractional values (closes #99, #104).
- **Credentials:** Hardened auto-capture validation; audit, prune, and dedup CLI (#98); duplicate normalized service detection; `storeIfNew` for auto-capture; lowercase URLs and empty-string fallback; list optimization; `runCredentialsList` in CLI context.

### Fixed

- **VectorDB:** Auto-reconnect after `close()` so concurrent ops no longer see "VectorDB is closed"; guard against concurrent `doInitialize()` during close (#103).
- **Stats:** Clarify zero procedures/proposals with hints when persona-proposals (or procedures) are disabled (#101).
- **Credentials:** Validation (minimum length, hostnames/URLs); dedup/validation bugs; N+1 in audit fixed via `listAll()`; P2 regression test (sk-key, assertion).
- **Cleanup:** Remove unreachable post-parse credential validation; remove dead code (`shouldSkipCredentialStore`, `CredentialsDbLike`); add `runCredentialsList` to `HybridMemCliContext`; address Copilot review threads.

### Changed

- **Docs:** Improved RRF search documentation and inline comments.
- **Version bump** — Release 2026.02.24 (npm `2026.02.240`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.02.230] - 2026-02-23

Feature and fix release: multi-provider LLM proxy (nano/default/heavy tiers), embeddings direct to OpenAI, error-reporting bot identity, config/model fallbacks, stats and distill improvements, and PR #93 review fixes (fixes #91, #92, #94, #95).

### Added

- **Multi-provider LLM proxy:** Configurable `llm.nano`, `llm.default`, and `llm.heavy` with ordered model lists and per-provider API keys. Chat/completion uses the gateway or direct provider APIs by tier; nano for cheap ops (autoClassify, HyDE, classifyBeforeWrite), default for reflection/language-keywords, heavy for distillation and persona proposals.
- **Error reporting bot identity:** Optional `errorReporting.botId` and `errorReporting.botName` for GlitchTip/Sentry tags; config-set and docs (ERROR-REPORTING.md) updated.
- **Stats:** Real queries for reflection, self-correction, language-keywords, and tier counts (no placeholder zeros).
- **Distill:** Chunking for oversized sessions (overlapping windows) instead of truncation when exceeding `--max-session-tokens`.

### Fixed

- **Embeddings:** Requests go direct to OpenAI; gateway is no longer used for `/v1/embeddings` (fixes GlitchTip #11 405 errors, #91).
- **HyDE and cron fallbacks:** HyDE uses `llm.default`; all runtime model fallbacks use `getDefaultCronModel()` — no hardcoded gpt-4o/gpt-4o-mini (#92).
- **Config:** `getDefaultCronModel()` fallbacks for all model fields; valid OpenAI model IDs when only embedding is configured (#94).
- **Error reporting:** Schema accepts `botId`/`botName`; no hostname leak when `botId` not set (#95).
- **Crashes:** Missing `pendingLLMWarnings` causing crash; gateway baseURL routing for chat OpenAI client restored.
- **Model/config:** Encryption key validation, timeout cleanup, model tier costs, HyDE fallback; UnconfiguredProviderError detection; model tier for auto-classify; OpenAI client cache key; credentials encryption validation.
- **Proposals:** Stronger proposal-generation prompt (template awareness, identity scoping, additive-first); improved error logging.
- **Deploy snippet:** Removed hardcoded models.

### Changed

- **Docs:** LLM-AND-PROVIDERS.md and related docs aligned with multi-provider proxy and three-tier architecture; ERROR-REPORTING.md for bot identity and config-set; TROUBLESHOOTING expanded.
- **Version bump** — Release 2026.02.23 (npm `2026.02.230`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.223] - 2026-02-22

Patch: align CLI-context `fallbackModels` with `cfg.llm` so gateway-routed model config is respected (fixes inconsistent model selection between CLI reflection and other code paths).

### Fixed

- **CLI-context fallbackModels:** When `cfg.llm` is set, `runReflection`, `runReflectionRules`, and `runReflectionMeta` now use no legacy fallbacks, matching `handlers.ts` and `utility-tools.ts`. Previously they always fell back to `cfg.distill?.fallbackModels`.

### Changed

- **Version bump** — Release 2026.02.22 revision (npm `2026.2.223`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.222] - 2026-02-22

Dependencies and tooling: better-sqlite3 ^12, direct Gemini REST API (drops @google/genai), `hybrid-mem version` command, cron/maintenance and Gemini fixes (fixes #72, #73, #80).

### Added

- **CLI `version` command:** `openclaw hybrid-mem version` shows installed version and latest on GitHub/npm with update hint (#80).
- **Dynamic cron and spawn from config:** Cron job definitions and spawn model configurable; docs and CLI updated.
- **Cron on install/upgrade:** Install and upgrade ensure cron jobs are present; disabled jobs honored.
- **MAINTENANCE_CRON_JOBS:** Nightly includes prune and extract-daily; weekly includes extract-directives, reinforcement, generate-auto-skills, persona-proposals; deep-maintenance simplified.

### Fixed

- **better-sqlite3:** Upgraded to ^12; README note for ^12 and prebuild-install (#72).
- **Gemini:** Removed @google/genai; direct Gemini REST API (#73). Multi-part response truncation and version display fixed.
- **Cron:** Canonical key mapping for weekly-persona-proposals job.
- **Model tier selection:** Provider-aware selection, async audit, duplicate commands, diff display.
- **PR 85:** Rollback proposal on apply fail, dedupe show, Gemini retry; Copilot/BugBot/Codex review feedback.
- **Misc:** Git commit non-fatal; JSON bracket extraction.

### Changed

- **Docs:** Gemini path per-request, retries for resilience. Comprehensive tests for new functionality.
- **Version bump** — Release 2026.02.22 revision (npm `2026.2.222`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.221] - 2026-02-22

Patch release: tool_use/tool_result sanitizer for Claude API, reflect --verbose, verify UX, LLM retry/fallback, Sentry false-positive fix (PR #78, closes #74–#77, #79).

### Added

- **Tool-use sanitizer:** `sanitizeMessagesForClaude()` and `llm_input` hook so every `tool_use` has a `tool_result` immediately after; prevents "LLM request rejected" when history is trimmed. Exported; doc TOOL-USE-TOOL-RESULT-ERROR.md.
- **Reflect CLI:** `--verbose` for `reflect`, `reflect-rules`, `reflect-meta` (#74).
- **Verify UX:** Cron job status and timing (last/next run, error preview); output grouped by section (#75, #77).
- **LLM retry/fallback:** `withLLMRetry`, `chatCompleteWithRetry` for distill/ingest, reflection, classification, consolidation, language-keywords, embeddings, summarization; optional fallback models (#76).

### Fixed

- **Sentry:** No longer report ENOENT on optional `credentials-pending.json` (#79).

### Changed

- **Version bump** — Release 2026.02.22 revision (npm `2026.2.221`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.220] - 2026-02-22

Refactor release: split monolithic `index.ts` into focused modules, plus security hardening (PR70 review), credential and CLI bug fixes, and improved error handling.

### Added

- **Security (PR70 review):** `trustToolScopeParams` config flag to prevent scope injection via tool parameters; health status tracking for init verification; credential validation and atomic migration flag; credential type in vault pointers; WAL circuit breaker; proposal validation.
- **CLI:** Error reporting and catch blocks for config, verify, install, and status paths; CLI reference and new commands documentation.
- **Refactor:** Plugin entry split into setup modules (database init, plugin service, lifecycle hooks, tool registration), dedicated `tools/` and `setup/` directories, extracted services (reflection, consolidation, find-duplicates, vector-search, credential-migration), and separate proposals CLI module.

### Fixed

- **Critical:** `currentAgentId` pass-by-value bug fixed so agent scoping is correct in lifecycle hooks.
- **Credentials:** Detection and `--days 0` parsing; BugBot credential store (split try-catch, pointer format, tests); rollback for credential DB writes on fact pointer failure; error handling and loop propagation; standardize vault pointers; duplicate scope declaration (ParseError).
- **Distill/ingest:** `distill --model` respects config; unified `.deleted` session file filter; orphaned facts bug in `runIngestFilesForCli` and `runDistillForCli`.
- **Self-correction:** Defaults and shared constants deduplication; directive store count; `--no-apply-tools` flag (Commander.js property and autoRewriteTools path).
- **CLI/lifecycle:** Weekly-reflection legacy job matcher (case-insensitive); async error handling and indentation in handlers; JSONL parse error flooding and missing schema validation; deepMerge array defaults, credential count tracking, directive deduplication; logger-after-close and String(null) check; agent detection in lifecycle hooks.
- **Consolidation/reflection:** Cosine similarity in consolidation; null handling in reflection.

### Changed

- **Version bump** — Release 2026.02.22 (npm `2026.2.220`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.201] - 2026-02-20

Bug-fix release: credentials encryption key handling and config mode reporting for verify.

### Fixed

- **Credentials:** When `credentials.enabled: true` and the user sets an `encryptionKey` that is invalid or unresolved (e.g. `env:MY_VAR` with `MY_VAR` unset, or a raw key &lt; 16 characters), the plugin now throws at config load with a clear error instead of silently falling back to memory-only (which would have stored credentials in plain SQLite). Memory-only mode is only used when credentials are enabled and no `encryptionKey` is set. Error messages direct users to set the env var or use a key of at least 16 characters and mention `openclaw hybrid-mem verify --fix`.
- **Config mode:** When a user specifies a configuration mode (e.g. `"normal"`) but overrides one or more preset values, the resolved config’s `mode` field is now set to `"custom"` so that `openclaw hybrid-mem verify` correctly shows **Mode: Custom**, matching CONFIGURATION-MODES.md.

### Changed

- **Version bump** — Release 2026.02.20 revision (npm `2026.2.201`). Version numbers updated in package.json, openclaw.plugin.json, and package-lock.

---

## [2026.2.210] - 2026-02-21

Consolidated release: verify reports all six optional cron jobs, scope/cold-tier and multi-agent fixes, error-reporting cleanup, cron job definitions, credentials/error-reporter/memory-forget fixes, config-set and open issues #53–#56.

### Added

- **Verify:** Optional/suggested jobs list now includes all six jobs: `nightly-memory-sweep`, `weekly-reflection`, `weekly-extract-procedures`, `self-correction-analysis`, `weekly-deep-maintenance`, `monthly-consolidation` (previously only four were shown).
- **Cron job definitions:** New `cli/cron-jobs.ts` module; nightly-distill cron includes `record-distill` step; cron commands add `generate-auto-skills` and drop no-op scope command (PR #66, issues #53–#56).
- **Config-set help:** Fix help parsing for `openclaw hybrid-mem config-set --help`; full preset includes ingest paths (PR #63).
- **Export CLI:** `openclaw hybrid-mem export` for vanilla OpenClaw–compatible MEMORY.md and memory/ directory layout (PR #57).
- **Error reporting schema:** Community/self-hosted mode and config-set support; `mode` passed to `initErrorReporter` (PR #58, #59).
- **Credentials:** `credentials.autoCapture` in plugin config schema; deploy snippet and vault-without-encryption option (PR #63).
- **Proposals/corrections:** List proposals, approve/reject, list corrections, approve-all from report; `listCorrections` uses `parseReportProposedSections` for both sections (issues #53–#56).
- **.gitignore:** `.claude/settings.json` added to ignore list.

### Fixed

- **Scope and cold-tier (from dev):** Scope computed early for classify-before-write so UPDATE path gets correct scope/scopeTarget; CLI search filters out cold-tier facts when tiering is enabled (`tieringEnabled` in CLI context), matching memory_recall and auto-recall.
- **Multi-agent (from feature/multi-agent-memory-scoping):** Stale cached agent ID no longer silences detection failure warnings; `buildToolScopeFilter` helper deduplicates scope filter logic; warning logs always emitted when agent detection fails; fallback uses `currentAgentId || orchestratorId` when detection fails.
- **Error reporting:** Remove duplicate `COMMUNITY_DSN` from config.ts (kept only in error-reporter.ts); breadcrumbs, Windows paths, async stop handler; credential CRUD and memory_forget error capture; rate limiter pruning and maxBreadcrumbs init; `flushErrorReporter` wired into shutdown (PR #60).
- **memory-forget:** Prefix matching UX, input validation, distinguish errors from not-found, tests; remove FTS text search for ID prefix resolution; show full UUIDs, report actual deletion failures (PR #61).
- **Credentials:** Critical plaintext vault bugs from council review fixed (PR #63).
- **Self-correction / procedures:** Verify --fix adds procedural and self-correction jobs; directive-extract 'remember' for URI+directive edge case; store rejection reason, config writes, correction parsers; TTY detection, feature gates, regex matching, macOS compatibility, scope issues (PR #57).

### Changed

- **Version bump** — Release 2026.02.21 (npm `2026.2.210`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

## [2026.2.200] - 2026-02-20

Major feature release including procedural memory, directive extraction, reinforcement tracking, multi-agent scoping, auth-failure auto-recall, privacy-first error reporting, and credential auto-capture.

### Added

- **Directive extraction & reinforcement-as-metadata (PR #41, closes issues #39, #40):** Multi-language detection of user directives and reinforcement signals. Directive extraction detects directives in 10 categories (explicit memory requests, behavior changes, absolute rules, corrections, preferences, warnings, procedural, implicit corrections, emotional emphasis, conditional rules) with multi-language support and confidence scoring (0.5-1.0). Reinforcement-as-metadata annotates existing facts with `reinforced_count`, `last_reinforced_at`, `reinforced_quotes`. Reinforced facts rank higher in search results (configurable boost). 8 reinforcement signal categories with correlation logic. Procedure reinforcement: procedures table gets reinforcement columns with auto-promotion when procedures are reinforced ≥ threshold times (confidence boost to 0.8+). CLI: `openclaw hybrid-mem extract-directives`, `openclaw hybrid-mem extract-reinforcement`. Config: `distill.extractDirectives` (default: true), `distill.extractReinforcement` (default: true), `distill.reinforcementBoost` (default: 0.1), `distill.reinforcementProcedureBoost` (default: 0.1), `distill.reinforcementPromotionThreshold` (default: 2).

- **Code review security fixes (PR #42):** Critical security hardening from independent GPT and Gemini code reviews. Credential vault KDF replaced raw SHA-256 with scrypt (N=16384, r=8, p=1) + random salt; backward-compatible migration for existing vaults. VectorDB SQL injection hardening with tightened UUID validation and security boundary comments. God file extraction: moved CredentialsDB and ProposalsDB to dedicated backend files (~440 lines removed from index.ts). Fixed memory_recall limit default mismatch (schema said 5, code used 10). Expanded SENSITIVE_PATTERNS (AWS keys, private key headers, connection strings). Replaced non-null assertions with safe getTable() accessor in VectorDB. Hash-based embedding cache keys for memory efficiency.

- **Confidence-weighted procedural ranking (PR #44):** Multi-factor confidence-weighted ranking for procedure recommendations. New `searchProceduresRanked()` method with multi-factor scoring (confidence × recency × success_rate × penalties). Recency decay: linear decay over 30-day window with minimum 0.3 factor. Success rate boost: 50-100% weight based on successCount / (successCount + failureCount). Recent failure penalty: 0.5 multiplier for procedures that failed in last 7 days. Never-validated penalty: 30% reduction for procedures without lastValidated. Auto-recall injection now uses ranked results with relevance score filtering (>0.4 threshold). Emoji indicators: ✅ for high confidence (≥70%), ⚠️ for lower. Tool chain summaries: `tool1 → tool2 → tool3`.

- **Pre-release bug fixes (PR #45):** Four defensive improvements. Missing default for `reinforcementPromotionThreshold` (added `?? 2`). Race condition in `gatherBackfillFiles` recursive walk (wrapped in try-catch). Connection string regex improvement (exclude colon from username, require host segment). Test case for directive extraction URI+colon edge case (`mailto:user@... Remember:`).

- **Multi-agent memory scoping (PR #46, activates FR-006):** Enables specialist agents (Forge, Scholar, Hearth) to build domain expertise while maintaining shared global knowledge. Runtime agent detection: plugin detects current agent ID from `before_agent_start` event payload. New `multiAgent` config section with `orchestratorId` (default: "main") and `defaultStoreScope` (global/agent/auto). Smart auto-scoping: in `auto` mode, orchestrator stores globally, specialists store agent-scoped. Automatic scope filtering: specialists automatically filter to `global + agent-specific` memories; orchestrator sees all. Procedures scoping: added `scope` and `scope_target` columns to `procedures` table; all search methods now accept `scopeFilter`. Specialists see global knowledge + their own discoveries; orchestrator sees everything.

- **Auth-failure auto-recall (PR #48, closes issue #47):** Reactive memory trigger that auto-injects credentials when authentication failures are detected. Detection layer: SSH failures (Permission denied, Authentication failed), HTTP failures (401, 403), API failures (Invalid API key, token expired); target extraction (hostnames, IPs, URL domains, service names). Memory recall: searches both SQLite FTS5 and LanceDB vector backends; filters to technical/credential facts; respects FR-006 memory scoping (global + agent-specific); deduplication (max 1 recall per target per session, configurable). Context injection: formats credential hints for agent consumption via `prependContext` return from `before_agent_start` hook; non-intrusive (only triggers when auth failures detected). Security: no credential values logged (only target identifiers); scope-aware (respects FR-006); no auto-execution (only injects hints); `originalText` removed from errors to prevent credential leakage. Config: `autoRecall.authFailure.enabled` (default: true), `autoRecall.authFailure.patterns` (customizable regex patterns), `autoRecall.authFailure.maxRecallsPerTarget` (default: 1). Docs: [AUTH-FAILURE-AUTO-RECALL.md](../docs/AUTH-FAILURE-AUTO-RECALL.md) (348 lines) with configuration, security, troubleshooting.

- **Privacy-first error reporting (PR #49):** Optional, opt-in error reporting to GlitchTip (self-hosted Sentry alternative). Explicit consent required (default: disabled; requires both `enabled: true` and `consent: true` in config). Privacy guarantees: NO user prompts, memory text, API keys, or PII; all sensitive data scrubbed via strict allowlist-based sanitization; zero breadcrumbs, no default integrations. Optional dependency: works without @sentry/node installed. What's reported: exception type and sanitized message, sanitized stack trace (plugin paths only), plugin version and environment, operation context (subsystem, operation). What's NEVER reported: user prompts or memory text, API keys/tokens/passwords, home paths (replaced with $HOME), emails (replaced with [EMAIL]), IPs (replaced with [IP]), breadcrumbs, HTTP requests, console logs. Config: `errorReporting` section with `enabled`, `consent`, `dsn`, `environment`, `sampleRate`. Docs: [ERROR-REPORTING.md](../docs/ERROR-REPORTING.md) with setup guide, security audit checklist, FAQ.

- **Credential auto-capture from tool calls (PR #51):** Automatically stores credentials used in tool calls into encrypted vault. Detection patterns: 7 regex patterns covering `sshpass -p <pass> ssh`, `curl -H "Authorization: Bearer <token>"`, `curl -u user:pass`, connection strings (postgres://, mysql://, mongodb://, redis://, mssql://), `-H "X-API-Key: <key>"`, `export VAR_KEY/TOKEN/PASSWORD/SECRET=value`, `.env`-style `KEY=value` assignments. Extraction engine: `extractCredentialsFromToolCalls(text)` uses `matchAll()` to find all occurrences per pattern; handles multiple credentials in a single tool call; deduplicates by `(service, type)`. `agent_end` hook: scans `tool_calls[*].function.arguments` in assistant messages when `credentials.enabled && autoCapture.toolCalls`; stores via `credentialsDb.store()` (upsert) — never touches factsDB or vectorDB. Config: `credentials.autoCapture.toolCalls` (default: false, opt-in), `credentials.autoCapture.logCaptures` (default: true). Security: tool inputs only; vault-encrypted; no facts/vector DB exposure. Docs: [CREDENTIALS.md](../docs/CREDENTIALS.md) updated with "Auto-Capture from Tool Calls" section.

- **Self-correction analysis (issue #34, closes #34):** Nightly pipeline to detect user corrections in session logs and auto-remediate. Multi-language correction detection via `.language-keywords.json` (run `build-languages` first for non-English). CLI: `openclaw hybrid-mem self-correction-extract [--days N] [--output path]`, `openclaw hybrid-mem self-correction-run [--extract path] [--approve] [--no-apply-tools] [--model M]`. Phases: (1) extract incidents from session JSONL using correction signals, (2) LLM analyze (category, severity, remediation type), (3) remediate: MEMORY_STORE with semantic dedup, TOOLS.md rules under configurable section (default apply; opt-out with `applyToolsByDefault: false` or `--no-apply-tools`), AGENTS/SKILL as proposals. Optional: `autoRewriteTools: true` for LLM rewrite of TOOLS.md; `analyzeViaSpawn` for Phase 2 via `openclaw sessions spawn` (Gemini, large batches). Config: `selfCorrection.semanticDedup`, `semanticDedupThreshold`, `toolsSection`, `applyToolsByDefault`, `autoRewriteTools`, `analyzeViaSpawn`, `spawnThreshold`, `spawnModel`. Report: `memory/reports/self-correction-YYYY-MM-DD.md`. Docs: SELF-CORRECTION-PIPELINE.md, CONFIGURATION.md. Optional cron job `self-correction-analysis` in install script.

- **RRF and search improvements (issue #33, closes #33):** Reciprocal Rank Fusion (RRF): replaced naive score-based merge in `services/merge-results.ts` with RRF. BM25 (SQLite) and cosine (LanceDB) scores are on incompatible scales; RRF uses rank-based fusion `rrf_score = sum(1/(k+rank))` so items ranking well in both keyword and semantic search naturally float to the top. Default k=60. Optional `mergeResults(..., { k })`. `openclaw hybrid-mem ingest-files`: index workspace markdown (skills, TOOLS.md, AGENTS.md) as facts via LLM extraction. Config `ingest.paths`, `ingest.chunkSize`, `ingest.overlap`. Facts stored with `category: technical`, `decayClass: stable`, tags include `ingest`. HyDE query expansion: opt-in `search.hydeEnabled: true` generates a hypothetical answer before embedding for vector search (memory_recall + auto-recall). Config `search.hydeModel` (default gpt-4o-mini). Adds latency/API cost per search.

- **Procedural memory (issue #23, closes #23):** Auto-generated skills from learned patterns. Three layers: (1) Procedure tagging: during session processing, multi-step tool-call sequences are extracted from session JSONL; successful runs are stored as positive procedures, failures as negative procedures. New `procedures` table and optional columns on `facts` (`procedure_type`, `success_count`, `last_validated`, `source_sessions`). CLI: `openclaw hybrid-mem extract-procedures [--dir path] [--days N] [--dry-run]` to scan session logs and upsert procedures. Secrets are never stored in recipes (redacted in procedure-extractor). (2) Procedure-aware recall: `memory_recall_procedures(taskDescription)` tool returns "Last time this worked" steps and "⚠️ Known issue" warnings. Auto-recall injects a `<relevant-procedures>` block when the prompt matches stored procedures (positive and negative). Config: `procedures.enabled` (default true), `procedures.sessionsDir`, `procedures.minSteps`, etc. (3) Skill generation: when a procedure is validated N times (default 3), auto-generate `skills/auto/{slug}/SKILL.md` and `recipe.json`. CLI: `openclaw hybrid-mem generate-auto-skills [--dry-run]`. Skills are sandboxed under `procedures.skillsAutoPath` (default `skills/auto`). Stale procedures (past `skillTTLDays`) are available for revalidation. Config: `procedures.validationThreshold`, `procedures.skillTTLDays`, `procedures.requireApprovalForPromote`.

### Fixed

- **CLI:** Removed duplicate registration of `extract-procedures` and `generate-auto-skills` in `registerHybridMemCli` (copy-paste had registered each command two extra times).

### Changed

- **Version bump** — Release 2026.02.20 (npm `2026.2.200`). Version numbers updated across package.json, openclaw.plugin.json, docs, and install scripts.

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

[Unreleased]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.3.250...HEAD
[2026.3.250]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.3.181...v2026.3.250
[2026.3.181]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.181
[2026.3.180]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.180
[2026.3.152]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.152
[2026.3.151]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.151
[2026.3.150]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.150
[2026.3.140]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.140
[2026.3.110]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.110
[2026.3.100]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.100
[2026.3.92]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.92
[2026.3.91]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.91
[2026.3.90]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.3.90
[2026.02.271]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.02.271
[2026.02.270]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.02.270
[2026.02.240]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.02.240
[2026.02.230]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.02.230
[2026.2.223]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.223
[2026.2.222]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.222
[2026.2.221]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.221
[2026.2.220]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.220
[2026.2.210]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.210
[2026.2.201]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.201
[2026.2.200]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.200
[2026.2.181]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.181
[2026.2.172]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.172
[2026.2.17.1]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.17.1
[2026.2.17.0]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.17.0
[2026.2.16]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.16
[2026.2.15]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/releases/tag/v2026.2.15
