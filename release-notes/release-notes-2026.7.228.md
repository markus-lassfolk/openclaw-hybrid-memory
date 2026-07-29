# Release notes — 2026.7.228

## Fixed

- Database bootstrap no longer crashes with `TypeError: The "path" argument must be of type string. Received undefined` when the plugin host's `resolvePath()` returns something other than a non-empty string during a deferred/hot-reload activation. Two earlier fixes (2026.7.226, 2026.7.227) guarded every known caller's *input* to `resolvePath()`; this guards its *output* too, falling back to the unresolved path (with a warning) instead of crashing.

## Changed

- The GlitchTip issue-sync automation now resolves issues with a release-scoped status instead of a bare "resolved," so GlitchTip's own regression detection can tell a genuine regression on the current release apart from a stale client still running an older, already-fixed version.

## Release metadata

- Bumps `openclaw-hybrid-memory` and the lockstep standalone installer to `2026.7.228`.
