## 2026.2.16 (2026-02-16)

### Added

- **Session distillation pipeline (Phase 1)**: Batch fact-extraction pipeline for retrospective analysis of historical OpenClaw conversation transcripts. Located in `scripts/distill-sessions/` with components: `batch-sessions.sh`, `extract-text.sh`, `store-facts.sh`, `gemini-prompt.md`, `run-stats.md`. Two-phase approach: bulk historical distillation (one-time; typical yield ~20–30 net new facts per full sweep) + nightly incremental sweep (automated, 2–5 new facts per run). All facts tagged with original session date `[YYYY-MM-DD]`. Documentation: [docs/SESSION-DISTILLATION.md](docs/SESSION-DISTILLATION.md), example run report: [docs/run-reports/example-distillation-report.md](docs/run-reports/example-distillation-report.md).
- **Nightly memory sweep**: Automated session distillation job (e.g. cron at 02:00) processing last 3 days of sessions using isolated session + Gemini. Expected yield: 2–5 new facts per run. Logs to `scripts/distill-sessions/nightly-logs/`. Setup via OpenClaw jobs config with `isolated: true` and `model: gemini`.
- **Auto-recall token cap (1.1)**: Configurable limit on tokens injected when auto-recall runs. New config: `autoRecall` can be an object with `enabled`, `maxTokens` (default 800), and `maxPerMemoryChars` (default 0). Legacy `autoRecall: true` remains valid.
- **Honor captureMaxChars (1.3)**: `captureMaxChars` in config and schema (default 5000). Auto-capture rejects messages longer than the cap; stored text is truncated with " [truncated]" when over cap.
- **Shorter injection format (1.2)**: `autoRecall.injectionFormat`: `full` (default), `short`, or `minimal` to save tokens.
- **Configurable recall limit and minScore (2.1)**: `autoRecall.limit` (default 5), `autoRecall.minScore` (default 0.3).
- **Decay-class–aware auto-recall (3.1)**: When `autoRecall.preferLongTerm` is true, scores boosted for `permanent` (×1.2) and `stable` (×1.1). Default false.
- **Importance and recency in composite score (3.3)**: When `autoRecall.useImportanceRecency` is true, relevance combined with importance and recency. Default false.
- **Entity-centric recall (4.1)**: When `autoRecall.entityLookup.enabled` is true and `entities` is set, prompt-mentioned entities get `factsDb.lookup(entity)` results merged into auto-recall candidates. Default `maxFactsPerEntity` 2.
- **Chunked long facts / summary (4.3)**: Facts longer than `summaryThreshold` (default 300 chars) get a short summary. At auto-recall, when `useSummaryInInjection` is true (default), summary is injected instead of full text to save tokens. New `summary` column in SQLite (migration added).
- **Consolidation job (2.4)**: `openclaw hybrid-mem consolidate [--threshold 0.92] [--include-structured] [--dry-run] [--limit 300] [--model gpt-4o-mini]` finds clusters of similar facts, merges with LLM, stores merged fact, deletes cluster. By default skips identifier-like facts; use `--include-structured` to include them.
- **Summarize when over budget (1.4)**: When `autoRecall.summarizeWhenOverBudget` is true and the token cap forces dropping memories, plugin summarizes all candidates with a cheap LLM and injects that block. Default model gpt-4o-mini.
- **Find-duplicates CLI (2.2)**: `openclaw hybrid-mem find-duplicates [--threshold 0.92] [--include-structured] [--limit 300]` reports pairs of facts with embedding similarity ≥ threshold. Report-only.
- **Fuzzy text deduplication in SQLite (2.3)**: When `store.fuzzyDedupe` is true, facts are normalized, hashed, and duplicate is detected by normalized hash before insert. Migration adds column and backfills. Default false.
- **Verify and uninstall CLI**: `openclaw hybrid-mem verify [--fix] [--log-file <path>]` checks config, SQLite, LanceDB, embedding API, and jobs; `--fix` prints missing config suggestions. `openclaw hybrid-mem uninstall` restores default memory manager in `openclaw.json`; `--leave-config` skips config change; `--clean-all` / `--force-cleanup` removes data (irreversible).

### Changed

- **First-install experience**: `openclaw hybrid-mem install` applies full defaults (config, compaction prompts, nightly-memory-sweep job); `verify --fix` applies safe fixes. Standalone `scripts/install-hybrid-config.mjs` for config before first gateway start. Credentials auto-enable when a valid encryption key is set.
- **Verify**: Optional/suggested jobs (nightly-memory-sweep, credentials vault, session-distillation, record-distill). Prerequisite checks at plugin init.
- **npm install path**: Package name set to `openclaw-hybrid-memory` for `openclaw plugins install openclaw-hybrid-memory` (maintainer publish steps in internal docs).
