#!/usr/bin/env bash
# Apply Maeve tier + crystallization-prep snippet (requires approval). Does NOT run automatically.
#
# Merges benchmark/ab-maintenance/maeve-tier-snippet.json into Maeve's hybrid-memory plugin config.
# Enables workflowTracking + toolEffectiveness logging; keeps crystallization.enabled=false.
#
# Usage:
#   bash benchmark/ab-maintenance/apply-maeve-tiers.sh          # preview
#   APPLY=1 bash benchmark/ab-maintenance/apply-maeve-tiers.sh  # merge on Maeve
set -euo pipefail
MAEVE="${MAEVE_HOST:-markus@192.168.1.224}"
SNIPPET="$(cd "$(dirname "$0")" && pwd)/maeve-tier-snippet.json"
echo "==> Maeve config snippet: $SNIPPET"
echo "    Host: $MAEVE"
echo "    crystallization.enabled stays false; workflowTracking enabled for data collection."
if [[ "${APPLY:-}" != "1" ]]; then
  echo ""
  echo "Preview (set APPLY=1 to merge on Maeve):"
  cat "$SNIPPET"
  exit 0
fi

REMOTE_SNIPPET="/tmp/openclaw-hybrid-memory-maeve-snippet.json"
scp -o BatchMode=yes "$SNIPPET" "$MAEVE:$REMOTE_SNIPPET"

ssh -o BatchMode=yes "$MAEVE" "python3 - <<'PY'
import json, os, shutil
from datetime import datetime, timezone

snippet_path = os.path.expanduser('$REMOTE_SNIPPET')
snippet = json.load(open(snippet_path))
snippet.pop('_comment', None)
oc_path = os.path.expanduser('~/.openclaw/openclaw.json')
cfg = json.load(open(oc_path))
plugins = cfg.setdefault('plugins', {})
entries = plugins.setdefault('entries', {})
mem_key = next(
    (k for k in entries if isinstance(k, str) and 'hybrid' in k.lower() and 'memory' in k.lower()),
    'openclaw-hybrid-memory',
)
entry = entries.setdefault(mem_key, {'enabled': True, 'config': {}})
if not isinstance(entry, dict):
    raise SystemExit(f'Unexpected entry shape for {mem_key}')
mem_cfg = entry.setdefault('config', {})
if not isinstance(mem_cfg, dict):
    raise SystemExit(f'Unexpected config shape for {mem_key}')

def deep_merge(base, patch):
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            deep_merge(base[k], v)
        else:
            base[k] = v

deep_merge(mem_cfg, snippet)
backup = oc_path + '.bak-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
shutil.copy2(oc_path, backup)
json.dump(cfg, open(oc_path, 'w'), indent=2)
os.remove(snippet_path)
print(f'Merged snippet into plugins.entries[{mem_key!r}].config')
print(f'Backup: {backup}')
print('workflowTracking.enabled:', mem_cfg.get('workflowTracking', {}).get('enabled'))
print('crystallization.enabled:', mem_cfg.get('crystallization', {}).get('enabled'))
PY"

echo "==> Done. Restart OpenClaw gateway on Maeve to pick up config."
