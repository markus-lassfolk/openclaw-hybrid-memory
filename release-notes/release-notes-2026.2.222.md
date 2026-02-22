## 2026.2.222 (2026-02-22)

Dependencies and tooling release: better-sqlite3 ^12, direct Gemini REST API (drops @google/genai), new `hybrid-mem version` command, cron/maintenance and Gemini fixes (fixes #72, #73, #80).

---

### Added

- **CLI `version` command:** `openclaw hybrid-mem version` shows installed plugin version and latest available on GitHub and npm, with update hint (fixes #80).
- **Dynamic cron and spawn from config:** Cron job definitions and spawn model are configurable; docs and CLI updated accordingly.
- **Cron on install/upgrade:** Install and upgrade flows ensure cron jobs are present; disabled jobs are honored.
- **MAINTENANCE_CRON_JOBS:** Nightly jobs now include prune and extract-daily; weekly jobs include extract-directives, reinforcement, generate-auto-skills, and persona-proposals; deep-maintenance simplified and commented.

### Fixed

- **better-sqlite3:** Upgraded to ^12; README documents ^12 and prebuild-install note (fixes #72).
- **Gemini:** Removed `@google/genai` dependency; plugin uses direct Gemini REST API (fixes #73). Fixes Gemini multi-part response truncation and version display inconsistency.
- **Cron:** Missing canonical key mapping for `weekly-persona-proposals` job fixed.
- **Model tier selection:** Provider-aware model selection bugs fixed; async audit, duplicate commands, and diff display corrected.
- **PR 85 (proposals):** Rollback proposal on apply fail; dedupe show; Gemini retry improvements.
- **PR 85 review:** Addressed Copilot, BugBot, and Codex review feedback.
- **Misc:** Git commit made non-fatal in relevant paths; JSON bracket extraction fixed.

### Changed

- **Docs:** Chat/Gemini path clarified as per-request with retries for resilience.
- **Tests:** Comprehensive tests added for new functionality in this PR.
- **Version bump** — Release 2026.02.22 revision (npm `2026.2.222`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.2.222
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.2.222
```

Restart the gateway after upgrading.
