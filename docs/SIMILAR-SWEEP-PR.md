# Similar-sweep PR process

During active feature work, **pause opening new similar-sweep PRs** until the current batch is merged or rebased onto `main`.

## Before opening

1. `git fetch origin main && git rebase origin/main` — do **not** `git merge main` (merge commits clutter the graph; use rebase when syncing with `main`).
2. Use the checklist in [`.github/pull_request_template/similar_sweep.md`](../.github/pull_request_template/similar_sweep.md)
3. Run overlap check: `node .github/scripts/check-pr-file-overlap.mjs`

## Merge order (when many PRs are open)

1. Mergeable sweep/fix PRs with green CI
2. Feature stack: #1454 → #1455 → #1458 → #1453
3. Rebase conflicting sweeps (port vector-db fixes to `vector-db-class.ts` only)
4. Paired PRs #1504 + #1505 together
5. Dependabot lockfile PRs last, alone

## File-split modules (collision reduction)

Large CLI/backend files are split into focused modules under `cli/commands/manage/` and `backends/facts-db/procedures/`. Prefer adding commands to the smallest matching `register-*.ts` file rather than the orchestrator.
