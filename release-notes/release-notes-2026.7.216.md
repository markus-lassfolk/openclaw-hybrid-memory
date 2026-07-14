# Release v2026.7.216

This release closes 11 issues: the tail of the #2079–#2100 sweep (#2088, #2091, #2093, #2095, #2098, #2099) plus four filed after it shipped (#2104–#2108).

## Fixed

- **Storage & dedupe** — added a by-category vectorless breakdown alongside the existing by-source one, surfaced in `storage stats`/`storage reembed` (#2093). `services/consolidation.ts`'s merged-fact store call now computes its embedding before storing and passes real LanceDB neighbour candidates into write-time dedupe instead of always degrading to lexical-only (#2091).
- **Credentials** — the legacy-literal-`file:`-key vault warning no longer fires on every CLI invocation, only on `credentials`/`doctor`/`verify` or `--verbose`; `rekey-vault --dry-run` gained a non-mutating preflight check (#2099).
- **`verify --fix --reconcile`** — `--verbose` was silently dropped before reaching the reconcile section, and the vector-orphan delete and SQLite-orphan rebuild loops logged nothing mid-operation, making a genuinely long repair look hung for minutes. `--verbose` now threads through, both loops emit a 20s-cadence progress heartbeat, and the rebuild loop respects the orchestrator-wide maintenance run deadline (#2105).
- **`doctor`** — "Maintenance health" compared every job against one flat 48-hour cutoff regardless of its real cadence, false-flagging longer-cadence steps (up to 5 days) as stale and contradicting `maintenance status`. Now compares each job against its own guard interval (#2108).

## Added

- **Credential vault revision history** (#2104) — overwriting an existing credential preserves the replaced value as a historical revision (30-day retention by default, extended on access, pinnable, purgeable) instead of discarding it immediately. New `credential_revision_list/get/restore/purge/pin` agent tools and matching `credentials revisions ...` CLI commands; revisions are encrypted the same as current values and covered by vault rekey/encrypt. Scoped to the issue's "Must have" section.
- `smoke e2e --no-cleanup` and a `graph-autolink` verification step that checks the auto-link pipeline actually creates a `RELATED_TO` edge (#2088).
- `--quiet`/`-q` flag (and `OPENCLAW_HYBRID_MEM_QUIET=1`) to suppress bootstrap-time log noise (#2095).
- `digest batch-reject` — bulk-reject stale/low-confidence pending-review candidates across the persona/tools/crystallization queues, with duplicate detection and a dry-run preview (#2098).
- [`docs/CLI-OBSERVABILITY-CONTRACT.md`](../docs/CLI-OBSERVABILITY-CONTRACT.md) — documents the heartbeat/phase/summary/interruption conventions for long-running mutating commands, with a compliance audit across command families (#2106).

## Investigated, documented (no code fix)

- (#2107) The gateway's "no loaded plugin registered a memory embedding provider" warning comes from the gateway's own, separate built-in `memory-core` embedding registry — hybrid-memory intentionally replaces that subsystem rather than plugging into its provider contract. Documented in [`docs/LLM-AND-PROVIDERS.md`](../docs/LLM-AND-PROVIDERS.md) which diagnostics actually reflect hybrid-memory's health; a real adapter registration is a considered, deferred follow-up rather than an implementation this environment could verify against a live gateway.

## Notes

- No `schemaVersion` bump — the new revision-history tables are additive and created idempotently on vault open, matching the precedent of prior credential-schema additions.
- No agent-tool contract removals — 5 new tool names added, registered in both `contracts/agent-tool-names.ts` and `openclaw.plugin.json`.
- ~15 `storeWithResult()` call sites that still don't pass `vectorCandidates` (#2091's broader scope) were investigated individually and found to have structural reasons not to wire trivially (existing exact-hash dedup, synchronous transaction closures, inherently-unique timestamped content) — left as a documented follow-up.
- `storage repair`'s pipeline and the credential vault migration/rekey/encrypt commands' fully-silent per-row loops are flagged in the new observability contract doc as the next heartbeat follow-up targets.

## Validation before release bump

- Full local gate green: `npx tsc --noEmit`, `npm run lint`, `npm test` (742 files / 9694 tests, 0 failures), `npm run verify:gate`.
- CI green on both Node 22 and Node 24 for the merged PR.
- Dedicated regression tests for every fix (consolidation vector-candidate wiring, credentials revision DB layer + agent tools + CLI, smoke e2e auto-link/no-cleanup, digest batch-reject, credentials legacy-key scoping/preflight, verify --fix --reconcile heartbeat/deadline behavior, doctor per-step cadence staleness).
