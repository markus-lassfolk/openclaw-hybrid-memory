## Implement open issues #53, #54, #55, #56 (branch: feature/implement-open-issues)

Implements all four open GitHub issues: rich stats, CLI observability (progress bars), maintenance cron job creation with feature-gating, and CLI for viewing/managing/approving proposals, rules, patterns, and corrections.

---

### Added

**Rich stats (issues #55, #54).**

- **`hybrid-mem stats`** now shows a **rich output** by default:
  - **Storage:** SQLite/LanceDB fact and vector counts with optional file sizes (MB), WAL pending writes.
  - **Knowledge:** Facts total, distinct entities, categories (configured vs active).
  - **Learned behavior:** Procedures (total, validated, promoted), directives, rules, patterns, meta-patterns.
  - **Graph:** Link count (memory_links).
  - **Operational:** Credentials captured, pending proposals, last distill/reflect/compact timestamps (when `.distill_last_run`, `.reflect_last_run`, `.compact_last_run` exist).
  - **Decay distribution:** Same as before (active, stable, permanent, session, cold).
- **`--brief`** restores the legacy style (storage + decay only). **`--efficiency`** still adds tier/source breakdown and token estimates.
- New FactsDB methods: `statsBreakdownByCategory()`, `proceduresCount()`, `proceduresValidatedCount()`, `proceduresPromotedCount()`, `linksCount()`, `directivesCount()`, `metaPatternsCount()`, `entityCount()`.
- CLI context extended with optional `richStatsExtras` (credentials count, proposals pending, WAL pending, last-run timestamps, storage sizes).

**CLI observability — progress bars (issue #54).**

- **Distill:** When run in a TTY, shows a progress bar (e.g. `Distilling sessions: 45% [=========>...] 12/27`).
- **Backfill:** Progress bar over candidate facts (e.g. `Backfilling: 30% [=====>...] 150/500`).
- **Classify:** Progress bar over batches (e.g. `Classifying: 50% [=========>...] 5/10`).
- Non-TTY runs unchanged (log lines only).

**Maintenance cron jobs (issue #53).**

- **Install:** After writing config, **creates all four maintenance cron jobs** in `~/.openclaw/cron/jobs.json` and in `openclaw.json` (if `jobs` array exists). Jobs use stable **pluginJobId** (`hybrid-mem:nightly-distill`, `hybrid-mem:weekly-reflection`, `hybrid-mem:weekly-extract-procedures`, `hybrid-mem:self-correction-analysis`).
- **Verify --fix:** Adds any missing jobs and **re-enables** previously disabled plugin jobs (so “fix” restores intended behavior). Existing jobs are matched by `pluginJobId` or legacy name; no duplicates.
- **Feature-gating:** When a feature is disabled in config, the corresponding CLI command exits successfully (code 0) without doing work:
  - `extract-procedures` → skip if `procedures.enabled` is false.
  - `reflect` / `reflect-rules` / `reflect-meta` → already guarded by `reflection.enabled` (and `--force` to override).
  - `self-correction-run` → skip if `selfCorrection` is not configured.
  - `consolidate` → skip if embedding API key is missing or placeholder.
- Cron jobs can remain defined; they no-op when the feature is off, so users don’t need to remove jobs when turning a feature off.

---

### Documentation

- **CLI-REFERENCE.md:** Updated `stats`, `install`, `verify`, `distill`, `backfill`, `classify` descriptions; added **List, show, and review (issue #56)** section (list by type, show, proposals, corrections, review); added **Maintenance cron jobs** section with table of jobs, install vs verify --fix behavior, and feature-gating note. Issue #56 adds: `list <type>`, `show <id>`, `proposals list/approve/reject`, `corrections list/approve --all`, `review`.

---

### Tests

- **facts-db.test.ts:** New describe blocks for `statsBreakdownByCategory`, `proceduresCount` / `proceduresValidatedCount` / `proceduresPromotedCount`, `linksCount`, `directivesCount`, `metaPatternsCount`, `entityCount`, `listFactsByCategory`, `listDirectives`, `listProcedures`.

---

### Upgrade

Merge branch `feature/implement-open-issues` and run:

```bash
openclaw hybrid-mem verify --fix   # optional: ensure cron jobs exist and re-enable any disabled
openclaw hybrid-mem stats          # try rich stats
```

Restart the gateway after upgrading.
