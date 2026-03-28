#!/usr/bin/env bash
# Deploy plugin and config to local OpenClaw for testing.
#
# 1. Sync extensions/memory-hybrid to ~/.openclaw/extensions/openclaw-hybrid-memory (rsync + npm install)
# 2. Merge deploy/openclaw.memory-snippet.json and openclaw.model-tokens-snippet.json into ~/.openclaw/openclaw.json
# 3. Run openclaw hybrid-mem install to apply full recommended defaults (idempotent)
# 4. Run openclaw hybrid-mem verify --fix to register cron jobs
#
# Usage: ./scripts/deploy-local.sh [--no-install] [--no-verify]
#   --no-install  Skip 'openclaw hybrid-mem install' (only sync + merge snippets)
#   --no-verify   Skip 'openclaw hybrid-mem verify --fix'
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== 1. Syncing plugin to local OpenClaw extensions ==="
"$REPO_ROOT/scripts/deploy-rsync.sh"

echo ""
echo "=== 2. Merging config snippets into ~/.openclaw/openclaw.json ==="
node "$REPO_ROOT/scripts/merge-config-snippets.mjs"

SKIP_INSTALL=false
SKIP_VERIFY=false
for arg in "$@"; do
  case "$arg" in
    --no-install) SKIP_INSTALL=true ;;
    --no-verify)  SKIP_VERIFY=true ;;
  esac
done

if [ "$SKIP_INSTALL" = false ]; then
  echo ""
  echo "=== 3. Applying full recommended config (openclaw hybrid-mem install) ==="
  openclaw hybrid-mem install || { echo "Warning: openclaw hybrid-mem install failed (openclaw in PATH?). Continue anyway."; }
else
  echo ""
  echo "=== 3. Skipped install (--no-install) ==="
fi

if [ "$SKIP_VERIFY" = false ]; then
  echo ""
  echo "=== 4. Registering cron jobs (openclaw hybrid-mem verify --fix) ==="
  openclaw hybrid-mem verify --fix || { echo "Warning: verify --fix failed. Run manually when OpenClaw is ready."; }
else
  echo ""
  echo "=== 4. Skipped verify (--no-verify) ==="
fi

echo ""
echo "Deploy complete. Next steps:"
echo "  1. Set embedding.apiKey in ~/.openclaw/openclaw.json (plugins.entries.openclaw-hybrid-memory.config.embedding.apiKey)"
echo "     Or use env:OPENAI_API_KEY in config. Replace YOUR_OPENAI_API_KEY if present."
echo "  2. Restart gateway: openclaw gateway stop && openclaw gateway start"
echo "  3. Run: openclaw hybrid-mem verify [--test-llm]"
