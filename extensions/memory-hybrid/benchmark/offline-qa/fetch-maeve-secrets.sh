#!/usr/bin/env bash
# Pull Maeve APIM subscription key for Azure Foundry embeddings (gitignored secrets.env).
set -euo pipefail

MAEVE="${MAEVE_SSH:-markus@192.168.1.224}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SECRETS="$ROOT/.offline-qa/secrets.env"

mkdir -p "$(dirname "$SECRETS")"

key="$(ssh -o BatchMode=yes "$MAEVE" 'python3 - <<'"'"'PY'"'"'
import json, os
home = os.path.expanduser("~")
cfg = json.load(open(os.path.join(home, ".openclaw", "openclaw.json")))
ms = ((cfg.get("agents") or {}).get("defaults") or {}).get("memorySearch") or {}
remote = ms.get("remote") or {}
headers = remote.get("headers") or {}
key = headers.get("Ocp-Apim-Subscription-Key") or headers.get("api-key") or remote.get("apiKey")
if not key:
    af = (cfg.get("models") or {}).get("providers", {}).get("azure-foundry") or {}
    h = af.get("headers") or {}
    key = h.get("Ocp-Apim-Subscription-Key") or h.get("api-key") or af.get("apiKey")
if isinstance(key, str) and key.startswith("env:"):
    key = os.environ.get(key[4:], "")
print(key or "", end="")
PY')"

if [ -z "$key" ]; then
  echo "Failed to read APIM key from Maeve ($MAEVE)." >&2
  exit 1
fi

base_url="$(ssh -o BatchMode=yes "$MAEVE" 'python3 - <<'"'"'PY'"'"'
import json, os
cfg = json.load(open(os.path.expanduser("~/.openclaw/openclaw.json")))
ms = ((cfg.get("agents") or {}).get("defaults") or {}).get("memorySearch") or {}
remote = ms.get("remote") or {}
print((remote.get("baseUrl") or remote.get("baseURL") or "").strip(), end="")
PY')"

{
  echo "# Auto-fetched from Maeve — do not commit (parent .offline-qa/ is gitignored)"
  echo "# Refresh: bash benchmark/offline-qa/fetch-maeve-secrets.sh"
  echo "AZURE_OPENAI_API_KEY=$key"
  if [ -n "$base_url" ]; then
    echo "AZURE_FOUNDRY_BASE_URL=$base_url"
  fi
} > "$SECRETS"
chmod 600 "$SECRETS"

echo "==> Wrote $SECRETS (AZURE_OPENAI_API_KEY len=${#key}${base_url:+, base URL set})"
