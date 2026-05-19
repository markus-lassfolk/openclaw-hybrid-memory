#!/usr/bin/env bash
# Remove local branches whose work is already on origin/main (squash-merged PRs or true merges).
# Keeps: main, develop, and the current branch.
#
# Usage:
#   ./scripts/prune-local-branches.sh           # dry-run (list only)
#   ./scripts/prune-local-branches.sh --apply   # delete branches
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

git fetch origin main --prune -q
MAIN=origin/main
CURRENT="$(git branch --show-current)"
PROTECT=(main develop "$CURRENT")

is_protected() {
  local b="$1"
  for p in "${PROTECT[@]}"; do
    [[ -n "$p" && "$b" == "$p" ]] && return 0
  done
  return 1
}

branch_is_on_main() {
  local b="$1"
  git merge-base --is-ancestor "$b" "$MAIN" 2>/dev/null
}

branch_has_merged_pr() {
  local b="$1"
  if gh pr list --head "$b" --state merged --limit 1 --json number -q '.[0].number' 2>/dev/null | grep -q .; then
    return 0
  fi
  if [[ "$b" =~ ^pr-([0-9]+)$ ]]; then
    local n="${BASH_REMATCH[1]}"
    gh pr view "$n" --json state -q .state 2>/dev/null | grep -q MERGED
    return $?
  fi
  return 1
}

TO_DELETE=()
while IFS= read -r b; do
  is_protected "$b" && continue
  if branch_is_on_main "$b" || branch_has_merged_pr "$b"; then
    TO_DELETE+=("$b")
  fi
done < <(git branch --format='%(refname:short)')

if [[ ${#TO_DELETE[@]} -eq 0 ]]; then
  echo "No local branches to prune."
  exit 0
fi

echo "Branches to remove (${#TO_DELETE[@]}):"
printf '  %s\n' "${TO_DELETE[@]}"

if ! $APPLY; then
  echo ""
  echo "Dry run only. Re-run with: $0 --apply"
  exit 0
fi

for b in "${TO_DELETE[@]}"; do
  git branch -D "$b"
done

echo "Deleted ${#TO_DELETE[@]} branch(es). Remaining: $(git branch | wc -l)"
