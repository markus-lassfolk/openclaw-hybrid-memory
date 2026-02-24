## 2026.02.240 (2026-02-24)

Feature and fix release: active-task working memory for multi-step tasks (#99, #104), VectorDB auto-reconnect after close (#103), credentials hardening and audit/prune/dedup CLI (#98), stats zero-hints clarification (#101), and related fixes.

---

### Added

- **Active-task working memory** — Working memory for multi-step tasks: ACTIVE-TASK.md doc, heartbeat stale warnings, duration parser, `staleThreshold` config, stashCommit preservation, injection budget checks, active-task file path resolved against workspace root, original task start time preserved in subagent_start handler; legacy `staleHours` validated to reject fractional values (closes #99, #104).
- **Credentials** — Hardened auto-capture validation; new audit, prune, and dedup CLI commands (#98). Duplicate normalized service detection; `storeIfNew` for auto-capture; lowercase URLs and empty-string fallback; list command optimization; `runCredentialsList` in CLI context.

### Fixed

- **VectorDB** — Auto-reconnect after `close()` so concurrent ops no longer see "VectorDB is closed"; guard against concurrent `doInitialize()` during close (#103).
- **Stats** — Clarify zero procedures/proposals with hints when persona-proposals (or procedures) are disabled (#101).
- **Credentials** — Validation bugs: enforce minimum length universally, preserve hostnames/URLs; deduplication and validation fixes; N+1 in credentials audit fixed by using `listAll()`; P2 regression test (sk-key length and assertion).
- **Cleanup** — Remove unreachable post-parse credential validation; remove dead code: `shouldSkipCredentialStore` and `CredentialsDbLike` type; add missing `runCredentialsList` to `HybridMemCliContext`; address Copilot review threads.

### Changed

- **Docs** — Improved RRF search documentation and inline comments.

---

### Upgrade

```bash
openclaw hybrid-mem upgrade 2026.02.240
```

Or from a clean install:

```bash
npx -y openclaw-hybrid-memory-install 2026.02.240
```

Restart the gateway after upgrading.
