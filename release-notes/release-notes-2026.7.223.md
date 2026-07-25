# Release v2026.7.223

## CI dependency-cache storage optimization

This release packages the completed CI-storage optimization from main commit `02574106fffdbab66ec23cfa3fc867706616294f`.

### What changed

- Replaces every explicit `actions/cache` archive of `node_modules` in CI and release publishing with `actions/setup-node@v7` built-in `cache: npm`.
- Uses `extensions/memory-hybrid/package-lock.json` as the cache dependency path for plugin jobs. The graph-app job includes both that lockfile and `extensions/memory-hybrid/graph-app/package-lock.json`, covering the two projects it installs.
- Keeps all installs explicit (`npm install`, `npm ci`, or the graph-app install command) and does not restore prebuilt `node_modules`; tests, builds, publish verification, install smoke, and browser smoke therefore execute against freshly installed dependencies.
- Retains the coverage artifact for 14 days. No other workflow cache, artifact-retention, or storage-follow-up is deferred within this release scope.

## Autonomous Dreaming outcome-signal completion (PR #2182 / #2173)

PR #2182 explicitly documented that its automated post-promotion outcome controller still relied on blended/feedback-proxy signals rather than full task-success attribution. This release closes that concrete follow-up:

- The outcome collector now reads the existing transcript-derived `feedback_trajectories` table, scoped to the Dream run's selected session IDs.
- Successful, partial, and failed tasks contribute 1, 0.5, and 0 respectively to the task-success rate; retry rate is derived from partial/failed outcomes.
- The controller labels these snapshots `task_outcomes`. Legacy installations without trajectories retain only the documented `feedback_proxy` fallback, and automatic rollback fails closed if the baseline and observation sources differ.
- Tests cover session scoping, partial-task weighting, unrelated-session exclusion, fallback behavior, and cross-source rollback protection.

This closes the only concrete, directly evidenced #2182 follow-up implemented in this release. The CI cache-storage release change is included because it was already the release's direct-main change set; it is unrelated to the Dream issue closure.

### Versioning

- `openclaw-hybrid-memory`: `2026.7.223`
- `openclaw-hybrid-memory-install`: `2026.7.223`
- `extensions/memory-hybrid/openclaw.plugin.json` is synchronized to the same version by the repository's version-sync script.

### Scope

This release addresses the CI dependency-cache storage change set only. It does not close unrelated product, runtime, or dependency issues.
