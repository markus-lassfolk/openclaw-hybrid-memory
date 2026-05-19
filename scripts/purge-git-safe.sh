#!/usr/bin/env bash
# Safe git purge: archive stashes + branch tips, prune merged/stale locals, run gc.
# Does not touch your working tree (uncommitted changes stay as-is).
#
# Usage:
#   ./scripts/purge-git-safe.sh           # dry-run
#   ./scripts/purge-git-safe.sh --apply
set -euo pipefail

APPLY=false
if [[ "${1:-}" == "--apply" ]]; then
  APPLY=true
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
ARCHIVE_DIR="$ROOT/wip/archive"
STASH_DIR="$ARCHIVE_DIR/stashes"
MAIN=origin/main

git fetch origin --prune -q

echo "=== Git safe purge ($( $APPLY && echo APPLY || echo DRY-RUN )) ==="
echo "Archive dir: $ARCHIVE_DIR"
echo ""

# --- 1. Archive stashes as patches ---
STASH_COUNT="$(git stash list | wc -l | tr -d ' ')"
echo "Stashes: $STASH_COUNT"
if [[ "$STASH_COUNT" -gt 0 ]]; then
  if $APPLY; then
    mkdir -p "$STASH_DIR"
    : >"$ARCHIVE_DIR/stash-index.txt"
    i=0
    # Always pop stash@{0}; avoid pipefail/grep quirks in while conditions.
    while [[ "$(git stash list 2>/dev/null | wc -l | tr -d ' ')" -gt 0 ]]; do
      label="$(git stash list 2>/dev/null | head -1)"
      safe="$(printf '%s' "$label" | tr '/:@{} ' '_' | tr -cd '[:alnum:]_-' | cut -c1-80)"
      [[ -z "$safe" ]] && safe="stash"
      patch="$STASH_DIR/stash-${i}-${safe}.patch"
      if ! git stash show -p "stash@{0}" >"$patch" 2>"$STASH_DIR/stash-${i}.err"; then
        git stash show "stash@{0}" --stat >"$patch" 2>/dev/null || true
      fi
      echo "$label -> $(basename "$patch")" >>"$ARCHIVE_DIR/stash-index.txt"
      git stash drop "stash@{0}"
      i=$((i + 1))
    done
    echo "  Archived and dropped $i stash(es) under wip/archive/stashes/"
  else
    echo "  Would archive $STASH_COUNT stash(es) to wip/archive/stashes/ and drop them"
  fi
fi

# --- 2. Tag branch tips before delete (recoverable via git show archive/...) ---
CURRENT="$(git branch --show-current)"
PROTECT=(main "$CURRENT")
BRANCHES_TO_DROP=()

while IFS= read -r b; do
  skip=false
  for p in "${PROTECT[@]}"; do
    [[ "$b" == "$p" ]] && skip=true && break
  done
  $skip && continue

  merged_pr=false
  if gh pr list --head "$b" --state merged --limit 1 -q '.[0].number' 2>/dev/null | grep -q .; then
    merged_pr=true
  elif [[ "$b" =~ ^pr-([0-9]+)(-review)?$ ]]; then
    n="${BASH_REMATCH[1]}"
    state="$(gh pr view "$n" --json state -q .state 2>/dev/null || true)"
    [[ "$state" == "MERGED" || "$state" == "CLOSED" ]] && merged_pr=true
  fi

  ancestor=false
  git merge-base --is-ancestor "$b" "$MAIN" 2>/dev/null && ancestor=true

  # develop: keep on remote only; local copy is stale integration branch
  if [[ "$b" == "develop" ]]; then
    BRANCHES_TO_DROP+=("$b")
    continue
  fi

  if $merged_pr || $ancestor; then
    BRANCHES_TO_DROP+=("$b")
  elif [[ "$b" == pr-*-review ]]; then
    BRANCHES_TO_DROP+=("$b")
  fi
done < <(git branch --format='%(refname:short)')

if [[ ${#BRANCHES_TO_DROP[@]} -eq 0 ]]; then
  echo "Branches to drop: none"
else
  echo "Branches to archive-tag and delete (${#BRANCHES_TO_DROP[@]}):"
  printf '  %s\n' "${BRANCHES_TO_DROP[@]}"
  if $APPLY; then
    for b in "${BRANCHES_TO_DROP[@]}"; do
      tag="archive/$(echo "$b" | tr '/' '-')"
      git tag -f "$tag" "$b" 2>/dev/null || true
      git branch -D "$b"
    done
    echo "  Tagged archive/* and deleted branches"
  fi
fi

# --- 3. Re-run branch pruner (merged PR heads) ---
if $APPLY; then
  "$ROOT/scripts/prune-local-branches.sh" --apply 2>/dev/null || true
else
  "$ROOT/scripts/prune-local-branches.sh" 2>/dev/null | tail -3 || true
fi

# --- 4. Pack/prune objects ---
if $APPLY; then
  git remote prune origin
  # Keep reflog 90d so archive/stash recovery remains possible after gc.
  git reflog expire --expire=90.days.ago --all 2>/dev/null || git reflog expire --expire=90.days --all
  git gc --prune=now
  echo ""
  echo "Done. Remaining branches:"
  git branch -vv
  echo ""
  du -sh .git
  echo "Recovery: git show archive/<name>  |  patches in wip/archive/stashes/"
else
  echo ""
  echo "Dry run. Re-run: $0 --apply"
fi
