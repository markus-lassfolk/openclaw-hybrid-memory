# Release v2026.7.215

This release closes a sweep of 22 issues (#2079–#2100) filed after a live storage-repair incident and an extensive memory smoke sweep against v2026.7.212. Most share root causes in the vector/storage/graph layers, so they're fixed together in one PR.

## Fixed

- **Vector backend & storage sync** — `VectorDB` now accepts slug-style (non-UUID) fact ids uniformly across read/delete/getAllIds/getVectorsByFactIds, closing the permanent-invisible-orphan-vector mechanism behind the reported repair loop (#2079). `optimize()` is now bounded with a clean nonzero exit instead of hanging indefinitely (#2081). `storage-repair-pipeline` and the tool-effectiveness monthly report now write vectors through the canonical cache-maintaining writer, so repair genuinely reduces vectorless counts (#2083, #2092). Storage-sync diagnostics compare real ID-set drift over the expected-vector population instead of raw incomparable counts, eliminating false-positive "corruption" for stores with structured key/value facts (#2080). Documented the embedding-cache contract and added post-swap cache backfill during model migration; fixed an ETA miscalculation in adaptive entity enrichment's dry-run mode (#2084, #2093).
- **Graph** — `facts.out_degree`/`in_degree` are now kept live on every link create/strengthen/prune instead of only refreshing once per dream cycle, which also revives the CTE hub-cap traversal guard's fast path that was silently dead code (#2085). Added a `graph health` discoverability alias next to `graph repair` (#2087). Confirmed #2086 (stale tool registrations after gateway restart) was already fixed by prior generation-delegation logic — no code change needed.
- **Dedupe** — the five store write-paths outside the `memory_store` exemplar now resolve vector dedupe candidates before writing, instead of silently degrading to lexical-only dedupe (#2091).
- **Maintenance** — real bounded retry-once for transient step failures, an earlier terminal ledger row that catches crashes during cron-harness setup, and `maintenance status` no longer false-positives on live runs (#2094). Maintenance coverage metrics classify per-metric as ok/warn/fail/not-configured with remediation text (#2097). `digest pending` gained a `--json` alias and per-queue age-bucket hygiene (#2098).
- **De-flaking** — hardened cron-harness test fixtures against silent `mkdir` failures, a source of test flakiness (#2096). The checkpoint-scan caching also planned for #2096 was not implemented in this release and remains open as a follow-up.

## Added

- `error-reports status|peek|flush` — inspect and drain the error-reporter's pending telemetry queue without running the much broader `verify`/`doctor` or restarting the gateway (#2082).
- `dream-cycle --dry-run [--json]` — safe, genuinely non-mutating preview of what the nightly cycle would prune/decay/consolidate/reflect, including the mutating follow-up pipeline (#2089).
- `link create|list|delete`, `issues create|update|list|search|show|link-fact`, `provenance <factId>`, `graph get <factId>`, `graph path <a> <b>` — CLI parity for capabilities that previously only existed as agent tools, so operators have a fallback when Tool Search wrappers are stale after a gateway restart (#2090).
- `OPENCLAW_HYBRID_MEM_QUIET=1` — suppresses bootstrap info/debug noise so status/read-only commands aren't buried under boilerplate (#2095).
- `credentials vault-status` now surfaces legacy-literal-file-key detection with remediation (#2099).
- `categories discovered [list|approve|reject]` — review workflow for discovered category labels instead of a raw-file bootstrap warning (#2100).
- `smoke e2e [--json]` — first-class end-to-end pipeline smoke test (store → embed → recall → link → episode → forget → verify) with disposable facts and mandatory cleanup, safe against a production local memory store (#2088).

## Notes

- No `schemaVersion` bump — every fix reuses existing columns/tables.
- No agent-tool schema changes — the new CLI commands wrap existing service-layer functions.
- Diagnostics counts may shift once slug-style vectors become visible under the #2079 fix — this is expected, not a regression.

## Validation before release bump

- Full local gate green: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run verify:gate`.
- Each phase landed as its own reviewable commit on `claude/open-issues-fix-plan-8st35k`, with dedicated regression tests for every fix (slug-id round-trips, degree-counter ground-truth checks, dry-run zero-write pinning, CLI parity coverage, smoke-e2e cleanup verification, among others).
