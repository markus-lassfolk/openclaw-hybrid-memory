# Release v2026.7.217

This release closes three reload/teardown-lifecycle regressions reported from production logs on the `2026.7.215` line: #2111, #2112, and #2113. Each fix ships with dedicated regression tests.

## Fixed

- **Plugin re-registration no longer fails on a slow teardown** (#2111) — the reload gate threw `memory-hybrid: reload teardown did not drain before opening new databases` on the full-teardown path (no donor handles to inherit) whenever the prior teardown had not finished draining within the wait budget. That failed plugin `register()` outright and repeated on every reload attempt (reproduced on two hosts, Maeve and Doris). Because the donor's databases are being permanently closed on a *separate* teardown chain, the new registration can safely open its own fresh handles — so the gate now recovers to a fresh open (with a warning + a `teardownTimeoutRecoveries` metric) instead of throwing. The reuse and soft-timeout fallback paths are unchanged.
- **`onSubagentEnded` is generation-safe after teardown** (#2112) — a subagent that started under a prior plugin generation could end after a reload had permanently closed the hybrid-memory `FactsDB`, producing repeated `onSubagentEnded failed (non-fatal): Error: The database connection is not open` log noise. Both `onSubagentEnded` and `prepareSubagentSpawn` now no-op cleanly when the captured DB handle has been torn down, using a new `BaseSqliteStore.isPermanentlyClosed()` predicate, and treat a late "connection is not open" error mid-callback as the same benign case.
- **Error-reporter drain/flush no longer looks like a local failure when the endpoint is just offline** (#2113) — startup drain and shutdown flush emitted `Startup drain incomplete` / `flush incomplete` warnings even when the sole cause was an unreachable GlitchTip endpoint, and a permanently-offline endpoint kept the identical pending reports queued forever, re-warning on every restart. Delivery failures are now classified as `network` (transient connectivity), `http` (endpoint rejected the event), or `other`; a transient network failure logs at info level with wording that makes clear the backlog is retained for retry, while genuine local-queue problems keep the louder warn wording. Pending reports older than a 14-day retention window are aged out on load, so the queue makes forward progress even when delivery never succeeds.

## Implementation notes

- `decideReloadTeardownGate()` (in `setup/hybrid-memory-reload-coordinator.ts`) is a new pure helper that captures the gate's four outcomes (`reuse` / `fresh` / `fresh-soft-timeout` / `fresh-hard-timeout`), unit-tested across every input combination so the "never throw on the full-teardown path" invariant is locked in.
- `BaseSqliteStore.isPermanentlyClosed()` returns true only after `permanentClose()` (or terminal shutdown) — distinct from `isOpen()`, which also returns false for a deferred-close store whose native handle was merely closed by background maintenance and can still lazily reopen.
- The error-reporter retention window is `maxPendingReportAgeMs` (default 14 days), configurable via `ErrorReporterConfig`. Failure classification is exposed as `getLastErrorReportSendFailureKind()`, and the shared log-message builder is `describePendingTelemetryDrain()`.

## Notes

- No `schemaVersion` bump — no storage-schema changes.
- No agent-tool contract changes.

## Validation before release bump

- Full local gate green: `npx tsc --noEmit`, `npm run verify:gate`, `npm test` (742 files / 9711 tests passed, 24 skipped, 0 failures).
- Dedicated regression tests added for all three fixes: `decideReloadTeardownGate` coverage in `tests/register-plugin-reload-teardown-drain.test.ts`; torn-down `onSubagentEnded`/`prepareSubagentSpawn` cases in `tests/context-engine.test.ts`; failure-kind classification, age-out, and `describePendingTelemetryDrain` messaging in `tests/error-reporter-persistence.test.ts`.
