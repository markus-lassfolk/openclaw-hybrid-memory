# Release notes — 2026.8.2

## Fixed

- Goal dispatch now rejects terminal (completed/abandoned) goals at every dispatch boundary — request parsing, the broker reservation lock, and immediately before launch — closing a race where a stale cron wake or a concurrent `goal_complete`/`goal_abandon` could still dispatch work against an already-terminated goal. The broker reservation now accepts a lock-time dispatchability predicate so the terminal-state check is re-validated while the reservation is committed, not only when the request was first parsed.

## Release metadata

- Bumps `openclaw-hybrid-memory` and the lockstep standalone installer to `2026.8.2`.
