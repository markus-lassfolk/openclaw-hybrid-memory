#!/usr/bin/env bash
# Standalone installer for openclaw-hybrid-memory.
# Works when OpenClaw config validation fails (e.g. "plugin not found").
# Run: curl -sSL https://raw.githubusercontent.com/markus-lassfolk/openclaw-hybrid-memory/main/scripts/install.sh | bash
# Or: curl -sSL ... | bash -s -- 2026.2.176  (install specific version)
set -e

VERSION="${1:-latest}"
EXT_DIR="${OPENCLAW_EXTENSIONS_DIR:-$HOME/.openclaw/extensions}"
PLUGIN_DIR="$EXT_DIR/openclaw-hybrid-memory"
TMP_DIR="${TMPDIR:-/tmp}/openclaw-plugin-install-$$"

echo "Installing openclaw-hybrid-memory@$VERSION to $PLUGIN_DIR"
echo ""

echo "Removing existing plugin..."
rm -rf "$PLUGIN_DIR"

echo "Fetching openclaw-hybrid-memory@$VERSION via npm pack..."
mkdir -p "$TMP_DIR"
cd "$TMP_DIR"
npm pack "openclaw-hybrid-memory@$VERSION"

echo "Extracting..."
mkdir -p "$PLUGIN_DIR"
tar -xzf openclaw-hybrid-memory-*.tgz -C "$PLUGIN_DIR" --strip-components=1

echo "Installing deps and rebuilding native modules..."
(cd "$PLUGIN_DIR" && npm install --omit=dev 2>/dev/null || npm install)

echo "Cleaning up..."
rm -rf "$TMP_DIR"

echo ""
echo "Done. Restart the gateway: openclaw gateway stop && openclaw gateway start"
