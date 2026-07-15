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

# Stop the gateway BEFORE mutating node_modules in place (#2130). A live gateway process can
# lazily `import()` plugin modules (e.g. on first use of a given code path) at any time; if
# `npm install` is still rewriting dist/node_modules underneath it, that import can transiently
# fail with ERR_MODULE_NOT_FOUND even though the final on-disk state is healthy.
echo "Stopping OpenClaw gateway before reinstalling deps ..."
openclaw gateway stop 2>/dev/null || true

echo "Reinstalling deps in $PLUGIN_DIR ..."
(cd "$PLUGIN_DIR" && npm install)

echo "Starting OpenClaw gateway ..."
openclaw gateway start

echo "Post-upgrade done. Check logs for your memory plugin (e.g. 'memory-hybrid: initialized' or 'memory-lancedb: initialized')."
