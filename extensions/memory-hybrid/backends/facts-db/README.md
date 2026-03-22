# FactsDB Module Boundaries

This folder holds extracted submodules from `backends/facts-db.ts`.

- `scan-cursors.ts`: incremental scan cursor storage/maintenance helpers.
- `links.ts`: low-level graph link CRUD and traversal primitives.
- `reinforcement.ts`: reinforcement event logging and confidence boost helpers.
- `types.ts`: shared link/reinforcement types used by FactsDB and submodules.

`FactsDB` remains the orchestration surface and API boundary for callers, while extracted modules isolate policy/maintenance seams for focused tests.
