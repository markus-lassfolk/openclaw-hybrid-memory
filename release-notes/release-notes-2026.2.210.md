## 2026.2.210 (2026-02-21)

Consolidated release: verify reports all six optional cron jobs, scope/cold-tier and multi-agent fixes, error-reporting cleanup, cron job definitions, and fixes from PRs #57–#66.

---

### Added

- **Verify:** The optional/suggested jobs list now includes all six jobs: `nightly-memory-sweep`, `weekly-reflection`, `weekly-extract-procedures`, `self-correction-analysis`, `weekly-deep-maintenance`, `monthly-consolidation` (previously only four were shown).
- **Cron job definitions:** New `cli/cron-jobs.ts` module. Nightly-distill cron includes the `record-distill` step. Cron commands add `generate-auto-skills` and drop the no-op scope command (PR #66, issues #53–#56).
- **Config-set help:** Fixed help parsing for `openclaw hybrid-mem config-set --help`; full preset includes ingest paths (PR #63).
- **Export CLI:** `openclaw hybrid-mem export` for vanilla OpenClaw–compatible MEMORY.md and memory/ directory layout (PR #57).
- **Error reporting schema:** Community/self-hosted mode and config-set support; `mode` passed to `initErrorReporter` (PR #58, #59).
- **Credentials:** `credentials.autoCapture` in plugin config schema; deploy snippet and vault-without-encryption option (PR #63).
- **Proposals/corrections:** List proposals, approve/reject, list corrections, approve-all from report; `listCorrections` uses `parseReportProposedSections` for both sections (issues #53–#56).
- **.gitignore:** `.claude/settings.json` added to ignore list.

### Fixed

- **Scope and cold-tier (from dev):** Scope is computed early for classify-before-write so the UPDATE path gets correct scope/scopeTarget. CLI search filters out cold-tier facts when tiering is enabled (`tieringEnabled` in CLI context), matching memory_recall and auto-recall behavior.
- **Multi-agent:** Stale cached agent ID no longer silences detection failure warnings. New `buildToolScopeFilter` helper deduplicates scope filter logic. Warning logs are always emitted when agent detection fails. Fallback uses `currentAgentId || orchestratorId` when detection fails.
- **Error reporting:** Removed duplicate `COMMUNITY_DSN` from config.ts (kept only in error-reporter.ts). Fixes for breadcrumbs, Windows paths, async stop handler; credential CRUD and memory_forget error capture; rate limiter pruning and maxBreadcrumbs init; `flushErrorReporter` wired into shutdown (PR #60).
- **memory-forget:** Improved prefix matching UX, input validation, clearer errors vs not-found, tests. Removed FTS text search for ID prefix resolution. Shows full UUIDs and reports actual deletion failures (PR #61).
- **Credentials:** Critical plaintext vault bugs from council review fixed (PR #63).
- **Self-correction / procedures:** Verify --fix adds procedural and self-correction jobs. Directive-extract 'remember' for URI+directive edge case. Store rejection reason, config writes, correction parsers. TTY detection, feature gates, regex matching, macOS compatibility, scope issues (PR #57).

### Changed

- **Version bump** — Release 2026.02.21 (npm `2026.2.210`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.2.210
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.2.210
```

Restart the gateway after upgrading.
