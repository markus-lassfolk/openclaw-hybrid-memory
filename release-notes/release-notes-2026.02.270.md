## 2026.02.270 (2026-02-27)

Feature and fix release: LanceDB dimension-mismatch graceful fallback and auto-repair (#128, #129), VectorDB reference-counted lifecycle and reconnection fixes (#106, #107), security and CodeQL fixes (#118–#127), credentials get/list CLI and config-set fix, proposal apply and workspace resolution fixes (#90), verify activeTask, npm package files (#71), and docs.

---

### Added

- **VectorDB dimension mismatch** — When the LanceDB table dimension does not match the configured embedding model, the plugin no longer crashes: search/count/hasDuplicate return empty/0/false and log a clear warning. Set `vector.autoRepair: true` in config to drop and recreate the table with the correct dimension and trigger re-embedding from SQLite (issue #128, #129).
- **Credentials CLI** — `openclaw hybrid-mem credentials get` and `credentials list --service <filter>` for vault inspection.
- **Verify** — Active-task (ACTIVE-TASK.md) status is shown in `openclaw hybrid-mem verify` output.
- **CI** — GitHub Actions labeler workflow for PRs; CodeQL suppressions where applicable.

### Fixed

- **VectorDB** — Reference-counted singleton prevents premature close when multiple sessions use the plugin (#106). Race condition in `open()`, reconnection blocking, and lifecycle ordering fixes (#107). Re-embedding bugs when using auto-repair (IDs vs indices, duplicates, delete errors, hot reload).
- **Proposals** — ProposalsDB prune timer guard (#130). Restore `isGitRepo` guard for proposal apply (#90). Proposal target files resolved against workspace; `proposals show` subcommand added.
- **Security** — CodeQL/alert fixes: shell env, password hash/scrypt, prototype-polluting deep merge, ReDoS-safe regex, HTML filtering. Restore v1 KDF to scrypt to prevent data loss in existing vaults.
- **Config/CLI** — `config-set errorReporting true` now sets an object (enabled/consent). Claude provider in cron model resolution; git staging reset on proposal rollback.
- **Package** — Missing `setup/`, `lifecycle/`, `tools/` added to npm package files (#71).

### Changed

- **Docs** — Remove unsupported `agents.defaults.pruning` (#105). Copilot review instructions. PR-133 merge analysis.
- **CI** — Labeler uses `pull_request`; labeler action v5; label logic OR for glob patterns.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.02.270
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.02.270
```

Restart the gateway after upgrading.
