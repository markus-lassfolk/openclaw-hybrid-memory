## 2026.2.172 (2026-02-17)

### Added

**Category discovery (LLM-suggested categories).** The auto-classify job can now suggest new categories from "other" facts:

- When `autoClassify.suggestCategories` is true (default), the job first asks the LLM to assign each "other" fact a short topic label (e.g. food, travel, technical). No fixed category list is given for this step.
- Any label that appears on at least `minFactsForNewCategory` facts (default 10) becomes a real category and those facts are reclassified. The threshold is **not** told to the LLM.
- New categories are persisted to `~/.openclaw/memory/.discovered-categories.json` and loaded on next startup.
- Config: `autoClassify.suggestCategories` (default true), `autoClassify.minFactsForNewCategory` (default 10). Set `suggestCategories: false` to disable.

**Nightly job by default.** Upgrade and snippet-only users now get the session-distillation job without running the full install:

- **Deploy snippet** ([deploy/openclaw.memory-snippet.json](../deploy/openclaw.memory-snippet.json)) includes the `nightly-memory-sweep` job.
- **`openclaw hybrid-mem verify --fix`** adds the nightly job to `openclaw.json` when it is missing.

### Changed

- **Session distillation:** Docs and suggested nightly job message now state that extracted credentials are routed like real time (vault + pointer when vault is enabled, else memory).
- **Verify --fix:** Now adds the nightly-memory-sweep job when missing, in addition to embedding block and memory directory.
