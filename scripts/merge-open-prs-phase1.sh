#!/usr/bin/env bash
# Merge/rebase helper for similar-sweep batch (see docs/SIMILAR-SWEEP-PR.md).
set -euo pipefail

echo "=== Phase 1a: mergeable sweep/fix PRs (CI must be green) ==="
QUICK_MERGES=(1519 1521 1527 1510 1512 1522 1469 1530 1515)
for pr in "${QUICK_MERGES[@]}"; do
  if gh pr view "$pr" --json state -q .state 2>/dev/null | grep -q OPEN; then
    echo "Merging #$pr ..."
    gh pr merge "$pr" --squash --auto || gh pr merge "$pr" --squash || true
  fi
done

echo "=== Phase 1b: feature stack (update branch first) ==="
for pr in 1454 1455 1458 1453; do
  if gh pr view "$pr" --json state -q .state 2>/dev/null | grep -q OPEN; then
    echo "Updating #$pr ..."
    gh pr update-branch "$pr" --rebase || true
    gh pr merge "$pr" --squash --auto || true
  fi
done

echo "Done. Verify: gh pr list --state open --json number,mergeable"
