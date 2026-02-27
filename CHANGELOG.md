# Changelog

All notable changes to the OpenClaw Hybrid Memory project (memory-hybrid plugin, v3 deployment guide, and related tooling) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses a **date-based version** (YYYY.M.D for date; same-day revisions use a three-part **npm** version with patch = day×10 + revision, e.g. 2026.2.170, 2026.2.171, so npm accepts it as a normal release).

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

[Unreleased]: https://github.com/markus-lassfolk/openclaw-hybrid-memory/compare/v2026.02.270...HEAD
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
