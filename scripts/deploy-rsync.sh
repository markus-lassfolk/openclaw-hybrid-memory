#!/usr/bin/env bash
# Deploy current memory-hybrid extension to OpenClaw test instance via rsync.
#
# Default: sync to local ~/.openclaw/extensions/openclaw-hybrid-memory and run npm install.
#
# Usage:
#   ./scripts/deploy-rsync.sh                    # local default
#   ./scripts/deploy-rsync.sh user@host:/path    # remote
#   OPENCLAW_TEST_INSTANCE=user@host:/path $0    # remote via env
#
# Override local path: OPENCLAW_EXTENSIONS_DIR=/custom/extensions $0
set -e

EXT_DIR="${OPENCLAW_EXTENSIONS_DIR:-$HOME/.openclaw/extensions}"
DEFAULT_DEST="$EXT_DIR/openclaw-hybrid-memory"
DEST="${1:-${OPENCLAW_TEST_INSTANCE:-$DEFAULT_DEST}}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/extensions/memory-hybrid"
cd "$REPO_ROOT"

echo "Deploying extensions/memory-hybrid to $DEST"
rsync -avz --delete \
  --exclude='node_modules/' \
  --exclude='coverage/' \
  --exclude='*.db' \
  --exclude='*.db-wal' \
  --exclude='*.db-shm' \
  --exclude='*.sqlite' \
  --exclude='lancedb/' \
  --exclude='.DS_Store' \
  --exclude='Thumbs.db' \
  "$SRC/" "$DEST/"

# Local dest: rebuild native modules
if [[ "$DEST" != *":"* ]]; then
  echo "Running npm install in $DEST..."
  (cd "$DEST" && npm install --omit=dev)
fi

echo "Deploy done. Restart gateway: openclaw gateway stop && openclaw gateway start"
