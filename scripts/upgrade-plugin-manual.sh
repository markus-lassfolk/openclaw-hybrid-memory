#!/usr/bin/env bash
# Manual plugin upgrade when gateway isn't working or hybrid-mem upgrade isn't available.
# Uses npm directly so OpenClaw config validation (which fails when plugin is missing) is bypassed.
# Run: ./scripts/upgrade-plugin-manual.sh
set -e

VERSION="${1:-2026.2.175}"
EXT_DIR="${OPENCLAW_EXTENSIONS_DIR:-$HOME/.openclaw/extensions}"
PLUGIN_DIR="$EXT_DIR/openclaw-hybrid-memory"
TMP_DIR="${TMPDIR:-/tmp}/openclaw-plugin-install-$$"

echo "Removing existing plugin at $PLUGIN_DIR ..."
rm -rf "$PLUGIN_DIR"

echo "Fetching openclaw-hybrid-memory@$VERSION via npm pack ..."
mkdir -p "$TMP_DIR"
cd "$TMP_DIR"
npm pack "openclaw-hybrid-memory@$VERSION"

echo "Extracting to $PLUGIN_DIR ..."
mkdir -p "$PLUGIN_DIR"
tar -xzf openclaw-hybrid-memory-*.tgz -C "$PLUGIN_DIR" --strip-components=1

echo "Installing deps and rebuilding native modules (postinstall) ..."
(cd "$PLUGIN_DIR" && npm install)

echo "Cleaning up ..."
rm -rf "$TMP_DIR"

echo "Done. Restart the gateway when ready: openclaw gateway stop && openclaw gateway start"
