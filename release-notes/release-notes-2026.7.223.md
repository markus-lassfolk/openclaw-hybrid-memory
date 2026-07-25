# Release v2026.7.223

## CI dependency-cache storage optimization

This release packages the completed CI-storage optimization from main commit `02574106fffdbab66ec23cfa3fc867706616294f`.

### What changed

- Replaces every explicit `actions/cache` archive of `node_modules` in CI and release publishing with `actions/setup-node@v7` built-in `cache: npm`.
- Uses `extensions/memory-hybrid/package-lock.json` as the cache dependency path for plugin jobs. The graph-app job includes both that lockfile and `extensions/memory-hybrid/graph-app/package-lock.json`, covering the two projects it installs.
- Keeps all installs explicit (`npm install`, `npm ci`, or the graph-app install command) and does not restore prebuilt `node_modules`; tests, builds, publish verification, install smoke, and browser smoke therefore execute against freshly installed dependencies.
- Retains the coverage artifact for 14 days. No other workflow cache, artifact-retention, or storage-follow-up is deferred within this release scope.

### Versioning

- `openclaw-hybrid-memory`: `2026.7.223`
- `openclaw-hybrid-memory-install`: `2026.7.223`
- `extensions/memory-hybrid/openclaw.plugin.json` is synchronized to the same version by the repository's version-sync script.

### Scope

This release addresses the CI dependency-cache storage change set only. It does not close unrelated product, runtime, or dependency issues.
