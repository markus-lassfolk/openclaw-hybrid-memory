# Release notes — 2026.8.4

## Fixed

- Plugin re-register / hot reload now fails closed when the donor generation's teardown has not drained within the bounded wait: replacement SQLite/LanceDB handles are not opened while a delayed terminal close can still race maintenance, lifecycle sync, and Workboard. Deferred activation is marked failed and safe tool stubs are retained instead.
- Managed `goal_dispatch` no longer routes native work from a caller-supplied `session_key`. The broker generates a fresh target-agent child key (`agent:<agent_id>:subagent:<uuid>`), passes that key to the request-scoped runtime, and marks a reservation launched only after a non-empty accepted `runId` (otherwise releases as `launch_unaccepted`).
- `goal_update` now accepts and persists operational fields — dispatch policy, next action, last outcome, evidence, and linked tasks — with snake_case and camelCase aliases, conflict rejection when both forms disagree, terminal-goal protection, and remediation guidance when a legacy write policy is missing `canonical.repository`.

## Release metadata

- Bumps `openclaw-hybrid-memory` and the lockstep standalone installer to `2026.8.4`.
