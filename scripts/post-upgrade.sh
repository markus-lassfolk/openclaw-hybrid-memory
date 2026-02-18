#!/usr/bin/env bash
# Reinstall the active memory extension's deps (@lancedb/lancedb, and for memory-hybrid: better-sqlite3) and restart the gateway.
# Run this after every OpenClaw upgrade (e.g. npm update -g openclaw).
# Copy to ~/.openclaw/scripts/post-upgrade.sh and chmod +x.
#
# Parameterise by extension name (default: memory-hybrid). For memory-lancedb:
#   export OPENCLAW_MEMORY_EXTENSION=memory-lancedb
# Or set a full path override:
#   export OPENCLAW_MEMORY_EXTENSION_DIR=/path/to/openclaw/extensions/memory-lancedb

set -e

EXTENSION_NAME="${OPENCLAW_MEMORY_EXTENSION:-memory-hybrid}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"

# Resolve extension directory: prefer NPM-installed copy in ~/.openclaw/extensions
if [ -n "$OPENCLAW_MEMORY_EXTENSION_DIR" ]; then
  PLUGIN_DIR="$OPENCLAW_MEMORY_EXTENSION_DIR"
elif [ -d "$OPENCLAW_HOME/extensions/openclaw-hybrid-memory" ]; then
  PLUGIN_DIR="$OPENCLAW_HOME/extensions/openclaw-hybrid-memory"
elif [ -d "$(npm root -g 2>/dev/null)/openclaw/extensions/$EXTENSION_NAME" ]; then
  PLUGIN_DIR="$(npm root -g)/openclaw/extensions/$EXTENSION_NAME"
else
  echo "Could not find OpenClaw extension: $EXTENSION_NAME" >&2
  echo "Set OPENCLAW_MEMORY_EXTENSION to the extension name (e.g. memory-hybrid or memory-lancedb), or OPENCLAW_MEMORY_EXTENSION_DIR to the full path." >&2
  exit 1
fi

echo "Reinstalling deps in $PLUGIN_DIR ..."
(cd "$PLUGIN_DIR" && npm install)

echo "Restarting OpenClaw gateway ..."
openclaw gateway stop 2>/dev/null || true
openclaw gateway start

echo "Post-upgrade done. Check logs for your memory plugin (e.g. 'memory-hybrid: initialized' or 'memory-lancedb: initialized')."
