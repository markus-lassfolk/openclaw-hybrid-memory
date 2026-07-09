# Release v2026.7.172

This release consolidates the hybrid-memory reload stability fixes needed before resuming the voice-call validation path.

## Fixed

- Drain reload teardown before database handle reuse so hot reloads do not leave stale close/reuse races behind.
- Re-register cleanly after closed database handles are observed during plugin reload cycles.

## Validation before release bump

- PR #2061 merged with typecheck, lint, test, publish-manifest, and CodeQL checks green.
- PR #2059 was refreshed onto main, title-gate fixed, all current-head checks passed, and then squash-merged before this version bump.
