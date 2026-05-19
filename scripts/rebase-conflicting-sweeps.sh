#!/usr/bin/env bash
# Rebase conflicting similar-sweep PR branches onto origin/main.
# For vector-db conflicts: keep main's barrel vector-db.ts; port fixes to vector-db-class.ts only.
set -euo pipefail

CONFLICTING=(
  issue-1495-similar-sweep-vector-db-broad-swallowed-db-avail
  issue-1489-similar-sweep-vector-db-broad-vector-db-count-no
  issue-1467-similar-sweep-index-unhandled-promise-in-index
  issue-1466-similar-sweep-retrieval-orchestrator-unhandled-p
  issue-1479-pre-finalization-guard-1271-related-session-matc
  issue-1486-sessionrefmatches-agent-main-main-checkpoint-doe
  issue-1496-similar-sweep-register-corrections-and-pipeline-
  issue-1492-similar-sweep-cmd-verify-broad-console-log-befor
)

git fetch origin main

for branch in "${CONFLICTING[@]}"; do
  echo "=== Rebase origin/$branch ==="
  git checkout -B "rebase-$branch" "origin/$branch"
  if git rebase origin/main; then
    echo "OK: $branch"
    echo "  Push with: git push origin HEAD:${branch} --force-with-lease"
  else
    echo "CONFLICT: $branch — resolve, then: git rebase --continue"
    exit 1
  fi
done

echo "All rebased. Merge #1504 and #1505 back-to-back after push."
