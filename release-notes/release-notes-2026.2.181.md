## 2026.2.181 (2026-02-18)

Release from `main` after merging dev_skills (PR #26).

### Added

**Self-correction analysis (issue #34).** Automated detection of user corrections in session logs and remediation:

- **CLI:** `openclaw hybrid-mem self-correction-extract [--days N] [--output path]` — extract incidents from session JSONL using multi-language correction signals (from `.language-keywords.json`; run `build-languages` first for non-English). `openclaw hybrid-mem self-correction-run` — analyze, remediate (memory store + TOOLS rules), and write report to `memory/reports/self-correction-YYYY-MM-DD.md`.
- **Default behavior:** Suggested TOOLS rules are **applied by default** (inserted under a configurable section, e.g. "Self-correction rules"). Opt out with config `selfCorrection.applyToolsByDefault: false` or CLI `--no-apply-tools`. Use `--approve` to force apply when opted out.
- **Semantic dedup:** Before storing facts from self-correction, the plugin skips near-duplicates by embedding similarity (config `selfCorrection.semanticDedup`, `semanticDedupThreshold`).
- **TOOLS sectioning:** Rules are inserted under a named section in TOOLS.md (no blind append). Optional `autoRewriteTools: true` uses an LLM to rewrite TOOLS.md and integrate new rules without duplicates or contradictions.
- **Phase 2 via spawn:** Optional `analyzeViaSpawn: true` and `spawnThreshold` run the analysis step via `openclaw sessions spawn` (e.g. Gemini) for large incident batches.
- **Config:** `selfCorrection` (semanticDedup, semanticDedupThreshold, toolsSection, applyToolsByDefault, autoRewriteTools, analyzeViaSpawn, spawnThreshold, spawnModel). See [CONFIGURATION.md](../docs/CONFIGURATION.md) and [SELF-CORRECTION-PIPELINE.md](../docs/SELF-CORRECTION-PIPELINE.md).
- **Optional cron:** Install script adds job `self-correction-analysis`; use it or point your scheduler at `openclaw hybrid-mem self-correction-run`.

### Fixed

- **CLI:** Duplicate registration of `extract-procedures` and `generate-auto-skills` in `registerHybridMemCli` removed (each command had been registered three times).
