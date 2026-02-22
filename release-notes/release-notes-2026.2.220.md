## 2026.2.220 (2026-02-22)

Refactor release: split monolithic `index.ts` into focused modules, plus security hardening (PR70 review), credential and CLI bug fixes, and improved error handling.

---

### Added

- **Security (PR70 review):** `trustToolScopeParams` config flag to prevent scope injection via tool parameters. Health status tracking for init verification. Credential validation and atomic migration flag. Credential type in vault pointers. WAL circuit breaker. Proposal validation.
- **CLI:** Error reporting and catch blocks for config, verify, install, and status paths. CLI reference and new commands documentation.
- **Refactor:** Plugin entry split into setup modules (database init, plugin service, lifecycle hooks, tool registration), dedicated `tools/` and `setup/` directories, extracted services (reflection, consolidation, find-duplicates, vector-search, credential-migration), and separate proposals CLI module.

### Fixed

- **Critical:** `currentAgentId` pass-by-value bug fixed so agent scoping is correct in lifecycle hooks.
- **Credentials:** Detection and `--days 0` parsing. BugBot credential store (split try-catch, pointer format, tests). Rollback for credential DB writes on fact pointer failure. Error handling and loop propagation. Standardize vault pointers. Duplicate scope declaration (ParseError).
- **Distill/ingest:** `distill --model` respects config. Unified `.deleted` session file filter. Orphaned facts bug in `runIngestFilesForCli` and `runDistillForCli`.
- **Self-correction:** Defaults and shared constants deduplication. Directive store count. `--no-apply-tools` flag (Commander.js property and autoRewriteTools path).
- **CLI/lifecycle:** Weekly-reflection legacy job matcher (case-insensitive). Async error handling and indentation in handlers. JSONL parse error flooding and missing schema validation. deepMerge array defaults, credential count tracking, directive deduplication. Logger-after-close and String(null) check. Agent detection in lifecycle hooks.
- **Consolidation/reflection:** Cosine similarity in consolidation. Null handling in reflection.

### Changed

- **Version bump** — Release 2026.02.22 (npm `2026.2.220`). Version numbers updated in package.json, openclaw.plugin.json, package-lock, and install package.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.2.220
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.2.220
```

Restart the gateway after upgrading.
