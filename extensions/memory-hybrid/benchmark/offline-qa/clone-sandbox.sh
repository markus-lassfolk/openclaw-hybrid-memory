#!/usr/bin/env bash
# Clone the pristine sandbox template to a mutable work copy for test runs.
# Re-run anytime to reset work state without re-fetching from Maeve.
#
# Usage:
#   bash benchmark/offline-qa/clone-sandbox.sh              # → .offline-qa/sandbox-work
#   bash benchmark/offline-qa/clone-sandbox.sh /path/to/x
#   OFFLINE_QA_CLONE_DEST=... bash benchmark/offline-qa/clone-sandbox.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
QA_ROOT="$ROOT/.offline-qa"
SOURCE="${OFFLINE_QA_SANDBOX_SOURCE:-$QA_ROOT/sandbox}"
DEST="${1:-${OFFLINE_QA_CLONE_DEST:-$QA_ROOT/sandbox-work}}"

if [ ! -f "$SOURCE/.openclaw/memory/facts.db" ]; then
  echo "Source sandbox missing at $SOURCE — run setup-sandbox.sh first." >&2
  exit 1
fi

echo "==> Cloning offline QA sandbox (template → work copy)"
echo "    from: $SOURCE"
echo "    to:   $DEST"

rm -rf "$DEST"
mkdir -p "$DEST"
rsync -a "$SOURCE/" "$DEST/"

session_count=$(find "$DEST/.openclaw/agents" -name '*.jsonl' 2>/dev/null | wc -l)
facts_bytes=$(stat -c%s "$DEST/.openclaw/memory/facts.db" 2>/dev/null || stat -f%z "$DEST/.openclaw/memory/facts.db")
echo "==> Work copy ready (original sandbox unchanged)."
echo "    HOME=$DEST"
echo "    Sessions: $session_count"
echo "    Facts:    $DEST/.openclaw/memory/facts.db ($(numfmt --to=iec "$facts_bytes" 2>/dev/null || echo "${facts_bytes}B"))"
echo ""
echo "Run tests against the copy:"
echo "  export HOME=\"$DEST\""
echo "  openclaw hybrid-mem run-all --dry-run -v"
echo ""
echo "Reset after a test run:"
echo "  npm run offline-qa:reset"
