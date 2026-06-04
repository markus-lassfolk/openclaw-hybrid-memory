#!/usr/bin/env bash
# Apply Maeve tier/alias fix (requires approval). Does NOT run automatically.
set -euo pipefail
MAEVE="${MAEVE_HOST:-markus@192.168.1.224}"
SNIPPET="$(dirname "$0")/maeve-tier-snippet.json"
echo "==> Would merge tier snippet from $SNIPPET into Maeve openclaw.json"
echo "    Host: $MAEVE"
echo "    Review snippet first, then run with APPLY=1"
if [[ "${APPLY:-}" != "1" ]]; then
  cat "$SNIPPET"
  exit 0
fi
ssh "$MAEVE" 'python3 - <<'"'"'PY'"'"'
import json, pathlib
snippet = json.loads(pathlib.Path("/dev/stdin").read_text())
# Operator merges snippet into ~/.openclaw/openclaw.json plugin config manually or via jq.
print(json.dumps(snippet, indent=2))
PY' < "$SNIPPET"
