# Release notes — 2026.8.1

## Fixed

- Goal-dispatch authorization now fails closed: direct managed dispatch is denied unless the requester has an explicit, matching authorization policy. The core dispatch bridge and broker apply that policy consistently and provide audit-safe denial context.

## Release metadata

- Bumps `openclaw-hybrid-memory` and the lockstep standalone installer to `2026.8.1`.
