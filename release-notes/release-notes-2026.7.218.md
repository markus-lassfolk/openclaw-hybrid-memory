# Release v2026.7.218

This release fixes three packaging/install issues surfaced during the Maeve/Doris upgrade to `2026.7.217` (#2115, #2116, #2117), each at the root cause, and adds CI/packaging gates so they cannot recur. It also adds a version-consistency CI test and a generic packaging best-practices check.

## Fixed

- **Published version metadata no longer drifts** (#2115) — `openclaw.plugin.json.version` (read by the OpenClaw host for `plugins inspect`) and the standalone installer package version were separate, hand-maintained literals that release automation never wrote, so they silently drifted from `package.json.version` and produced contradictory operator output (`plugins inspect` disagreeing with `hybrid-mem version`). `package.json.version` is now the single source of truth. A new `scripts/sync-plugin-version.cjs` derives the other two from it (run in `prepack` and via `npm run sync:version`), so published tarballs are always internally consistent.
- **Fresh installs no longer fail on a missing `apache-arrow`** (#2116) — `@lancedb/lancedb@0.31` moved `apache-arrow` to a peer dependency. The plugin imports Arrow only transitively (it duck-types the vector column to avoid a direct import), so it declared `apache-arrow` nowhere and npm never installed it — a fresh managed install then failed to load with `Cannot find module 'apache-arrow'`. `apache-arrow@18.1.0` (within lancedb's `>=15 <=18.1` peer range) is now a direct dependency, so it ships in the generated `npm-shrinkwrap.json` and installs cleanly.
- **Migration no longer leaves two discoverable plugin copies** (#2117) — migrating to OpenClaw's managed npm plugin path left the stale legacy `~/.openclaw/extensions/<id>` copy on disk beside the managed `~/.openclaw/npm/projects/<id>/node_modules/<id>` copy, so the gateway logged `duplicate plugin id detected` and could read stale metadata from the losing copy. The upgrade/verify flows now quarantine the stale copy (moving it to `~/.openclaw/.cache/<id>.removed-duplicate-<ts>`, matching the manual remediation) whenever the managed copy is strictly newer, and `openclaw hybrid-mem doctor` reports the condition with both paths, both versions, and the winning canonical source.

## Added — version & packaging gates

- **Version consistency CI test** (`tests/version-consistency.test.ts`) asserts `package.json.version` equals `openclaw.plugin.json.version`, the installer package version, and `versionInfo.pluginVersion`. `verify-publish.cjs` and the release workflow enforce the same parity before publish (working tree and packed tarball). The SDK and bundled graph-app remain intentionally versioned independently and are not checked.
- **Generic packaging best-practices check** — `verify-publish.cjs` now fails on **any** unmet required peer dependency of an installed dependency (not a hard-coded list), verifies the declared `apache-arrow` satisfies lancedb's actual peer range, and confirms the release-version literals are in sync. The `install-smoke` CI job additionally loads `@lancedb/lancedb` and `apache-arrow` from inside the installed tarball — the runtime path the previous shallow `dist/index.js` import missed.

## Implementation notes

- `scripts/sync-plugin-version.cjs` has a `--check` mode (used by `verify-publish.cjs`/CI, no writes) and a default write mode (used by `prepack`/`npm run sync:version`); it rewrites only the top-level `version` field, preserving each file's indentation and trailing newline.
- `removeRedundantExtensionsTreeWhenNpmProjectCanonical` mirrors the existing `removeRedundantNpmProjectTreeWhenExtensionsCanonical`; the two are disjoint by version (the new one fires only when the npm-project copy is *strictly newer*), so `upgrade`/`verify --fix`/`doctor --fix` can safely attempt both and at most one acts. It preserves the stale copy (move, not delete) with a cross-filesystem copy-then-remove fallback.
- The new duplicate-install `doctor` check and quarantine reuse the existing reconcile guards (loadable-manifest + readable-version + version comparison), so a half-installed or unreadable copy is never treated as canonical.

## Notes

- No `schemaVersion` bump — no storage-schema changes.
- No agent-tool contract changes.
