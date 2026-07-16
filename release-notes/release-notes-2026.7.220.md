# Release v2026.7.220

Closes all five open production issues surfaced by live Maeve/Doris hosts (#2135–#2139). Each is fixed at the root cause with regression tests.

## Fixed — Memory graph & supersession tooling

- **`memory_store` rejected an array of `supersedes` ids; `memory_link` threw a raw SQLite bind error** (#2139) — the OpenClaw plugin runtime does not enforce TypeBox parameter schemas, so real callers hit two crashes:
  - `memory_store` with `supersedes: [id1, id2]` reached `supersedes.trim()` → `supersedes?.trim is not a function`.
  - `memory_link` with `from`/`to`/`type` (instead of `sourceFact`/`targetFact`/`linkType`) reached `factsDb.getById(undefined)` → `Provided value cannot be bound to SQLite parameter 1.`

  `memory_store.supersedes` now accepts a single id **or an array of ids** (each in-scope target is superseded independently) and returns a structured `invalid_supersedes` error for any other shape. `memory_link` resolves the common aliases, upper-cases the link type, validates every field **before** touching the DB, and returns a structured, parameter-named `invalid_input` error — never an opaque SQLite exception.

## Fixed — Credential vault false-positives

- **`memory_store` diverted ordinary infrastructure facts into bogus credential entries** (#2138) — the bare SSH connection-string pattern (`ssh <host> <user>`) matched ordinary prose ("connect via ssh …"), and because the matched span was returned as a "secret" with `hasPatternMatch=true`, the natural-language/path guards were skipped and an infra note (host/IP/gateway/MAC + stored service names, no secret) was written to the vault as a fake `ssh` credential requiring manual cleanup. A bare SSH connection string carries no secret, so the pattern is now **detection-only**: it can still prompt the user, but it never routes into the vault — the fact is stored as a fact. Real SSH secrets (private-key blocks, `sshpass -p <pw>` passwords, connection strings with an embedded password) are unchanged.

## Fixed — Nightly maintenance analyzer recursion

- **`maintenance-log-analyzer` still failed nightly on its own artifacts after #2131/#2132** (#2137) — two self-reference escape routes remained:
  - **(A)** Synthetic `orchestration-*` steps derived from the analyzer's *own* empty/stale/missing exit ledger classified as the strict `orchestration-bug` class and were never in the self-referential step set, forcing `exit=2` → `validate-cron-exit exit=1` → `maintenance_failed` → new stale artifacts → loop.
  - **(B)** The analyzer's own `analyze-maintenance-logs exit=2` (strict-fail) and `validate-cron-exit` rows re-classified as a strict class because their shared `logContent` is the analyzer's own re-read digest, full of *other* jobs' failure phrases.

  Self-suppression now recognizes the analyzer job's own `orchestration-*` synthetic steps and its strict-fail `exit=2` / validation rows **regardless of the (contaminated) classification**, while still reporting a genuine analyzer crash (`analyze exit=1` with a real classified stack) and every other job's failures once, with stable fingerprinting.

## Fixed — Reuse-databases teardown observability

- **`reuse-databases` full teardowns were unexplained** (#2136) — the reuse eligibility gate collapsed ~20 distinct decline reasons into a bare boolean with only a generic `debug` line, so `fullTeardowns > 0` under `reuse-databases` could not be attributed. Now `evaluateReregisterReuse` returns a stable reason code (`bootstrap_not_settled`, `donor_handle_closed`, `sqlite_path_changed`, `config_drift:<field>`, `teardown_soft_timeout`, …); `recordReregisterFullTeardown(reason)` tallies a new `fullTeardownReasons` breakdown; the fallback is a `warn` naming the reason; and the `plugin_reregister_full_teardown_despite_reuse_policy` leak hint reports the per-reason counts instead of the old "check bootstrapSettledRef or config drift" nudge. A regression test pins that repeated re-registers under `reuse-databases` keep `fullTeardowns`/`teardownTimeoutRecoveries` at 0.

## Fixed — Staging plugin-load hardening

- **Gateway SIGBUS'd while loading the plugin from a hot-upgrade staging path** (#2135) — a native abort inside the LanceDB binding or an mmapped data file cannot be caught by a JS `try/catch` once execution enters native code. The register flow now runs a filesystem-only preflight before the first native store init: a structurally incomplete staging copy (missing / zero-byte / corrupt `openclaw.plugin.json` or `package.json` — the interrupted-copy state that precedes a native abort) is rejected as a recoverable `PluginLoadPreflightError` instead of proceeding into the native path. Plugin-load and DB-init errors now carry a load-diagnostics context (package version, resolved extension path, staging flag, last-successful extension path, reload/teardown-drain state) so any residual crash is attributable, and the last-known-good extension path is recorded after each successful registration. Scoped to the fresh-open path; the reuse path inherits already-open handles and performs no native connect.

## Hardened — QA follow-up

A full adversarial code review of this release's own diff, before merge, found and closed several residual edge cases (all with regression tests): a partial multi-id supersede silently dropping blocked targets (now surfaced as `supersedeBlocked`); a misleading `dedupe-merge` reason when a supersede target was actually blocked (now `targets_blocked_or_not_found`); a phantom `supersedes_id` lineage pointer written before the scope check (targets are now scope-validated before the write); a blank canonical `memory_link` key shadowing a populated alias; and a diagnostics snapshot aliasing the live `fullTeardownReasons` map (now deep-copied). The `#2135` preflight was also extended to validate the compiled `dist/index.js` entry when a build is present.

## Notes

- No `schemaVersion` bump — no storage-schema changes.
- No agent-tool contract changes; `memory_store` and `memory_link` accept a superset of their prior inputs.
- Native RSS growth under `reuse-databases` (#2136) is addressed here as observability/attribution; the underlying native allocator retention in LanceDB/Rust is a separate upstream concern.
- The `#2135` preflight is a necessary-but-not-sufficient guard: it rejects an incomplete staging copy before the native path, but cannot detect a present-but-internally-corrupt native binding (which would require child-process isolation).
