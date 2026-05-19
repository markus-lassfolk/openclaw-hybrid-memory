---
layout: default
title: Contributor onboarding
nav_order: 83
---

# Contributor onboarding

## First contribution path

1. Pick a `good first issue` label.
2. Reproduce the issue or run the relevant command flow.
3. Add a focused fix with tests.
4. Run:
   - `cd extensions/memory-hybrid && npm run lint`
   - `cd extensions/memory-hybrid && npm run build`
   - `cd extensions/memory-hybrid && npm run test`
5. Open a PR using the template checklist.

## High-impact areas

- session observability and explainability
- retrieval precision and ranking behavior
- onboarding and doctor flows
- operator safety and trust surfaces

## Code layout (where to edit)

Avoid growing monolithic orchestrators. Prefer the smallest matching module:

- **CLI:** `extensions/memory-hybrid/cli/commands/manage/register-*.ts` (not a single giant `manage.ts`)
- **Procedures DB:** `extensions/memory-hybrid/backends/facts-db/procedures/`
- **Dashboard:** `extensions/memory-hybrid/routes/dashboard/` (`dashboard-server.ts` is a barrel only)
- **Vector DB:** `extensions/memory-hybrid/backends/vector-db/vector-db-class.ts`

During active similarity-sweep batches, read [SIMILAR-SWEEP-PR.md](SIMILAR-SWEEP-PR.md) before opening another sweep PR.

## Contribution quality bar

- strict TypeScript compatibility
- parameterized SQL only
- no silent DB failures
- docs updated for user-visible behavior changes
