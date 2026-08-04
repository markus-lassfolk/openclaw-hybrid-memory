# Release notes — 2026.8.3

## Fixed

- Goal stewardship now durably reconciles a failed/stalled worker into an authorized same-PR diagnosis/repair or verification decision instead of leaving a `blocked` goal stranded outside normal continuation attention. Continuation decisions are restart-safe and fingerprint-deduped so a duplicate heartbeat pulse cannot repeat or lose the repair instruction, and the directive always preserves the goal's canonical repository/PR/branch/write scope (`creates_pr=false`, `creates_branch=false`).
- `goal_dispatch` now enforces a preflight/HITL gate for implementation work: a goal missing an authorized dispatch policy, verification target, or measurable acceptance criteria is created in a `blocked`/`hitl` state and write dispatches are refused until a human resolves the prerequisite, while bounded read-only/advisory dispatches remain permitted. A per-goal iteration budget (`max_iterations`, default 20, bounded 1-100) is atomically claimed at dispatch time and escalates to HITL once exhausted, so duplicate pulses or restarts cannot silently run past the bound.
- Added a governed, auditable `openclaw hybrid-mem stewardship-set` operator command for the two allowlisted `goalStewardship.globalLimits` fields, gated behind explicit `--approve`/`--actor`/`--reason`, with a request-id idempotency key, `--dry-run`, file locking, and a JSONL audit trail — replacing direct edits to protected Gateway configuration.

## Release metadata

- Bumps `openclaw-hybrid-memory` and the lockstep standalone installer to `2026.8.3`.
