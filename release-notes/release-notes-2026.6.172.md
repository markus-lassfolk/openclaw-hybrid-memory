# Release notes — OpenClaw Hybrid Memory **2026.6.172**

**Release date:** 2026-06-24  
**Since:** [2026.6.171](CHANGELOG.md#20266171---2026-06-21)  
**Full changelog:** [CHANGELOG.md](../CHANGELOG.md) — section **[2026.6.172]**

## Highlights

Fixes [#1934](https://github.com/markus-lassfolk/openclaw-hybrid-memory/issues/1934): the maintenance orchestrator could not persist per-step guard timestamps because `cron-guard.ts` called `writeFileSync` without importing it from `node:fs`. On hosts running **2026.6.170** / **2026.6.171**, successful maintenance steps failed at the guard-write path with `ReferenceError: writeFileSync is not defined`, which made nightly maintenance report broad step failures (including `vectordb-optimize` and `repair-vectors`) even when the step body succeeded.

### What changed

- Added the missing `writeFileSync` import in `extensions/memory-hybrid/services/cron-guard.ts`.
- Added regression tests for `writeStepGuardTimestampMs`, orchestrator guard round-trip, and second-run `skipped_guard` behavior.
- Added a CI **Maintenance Gate** job (`tsc --noEmit` on the scoped gate config + guard/orchestrator tests).

### After upgrading

**Rerun maintenance once after upgrading** so vector and storage steps can complete and write fresh guard timestamps:

```bash
openclaw hybrid-mem maintenance run --force --tiers nightly,cycle
```

Or wait for the next scheduled `maintenance-nightly` cron once the patched plugin is installed and the gateway has restarted.

If your last nightly run logged many `writeFileSync is not defined` failures, treat that run as incomplete — guards were not updated and steps may rerun sooner than usual until a successful pass completes.
