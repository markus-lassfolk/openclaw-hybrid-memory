#!/usr/bin/env bash
# Manual plugin upgrade when gateway isn't working or hybrid-mem upgrade isn't available.
# Uses npm directly so OpenClaw config validation (which fails when plugin is missing) is bypassed.
# Run: ./scripts/upgrade-plugin-manual.sh
set -e

VERSION="${1:-2026.2.175}"
EXT_DIR="${OPENCLAW_EXTENSIONS_DIR:-$HOME/.openclaw/extensions}"
PLUGIN_DIR="$EXT_DIR/openclaw-hybrid-memory"
STAGE_DIR="${PLUGIN_DIR}.staging-$$"
BACKUP_DIR="${PLUGIN_DIR}.pre-upgrade-$$"
TMP_DIR="${TMPDIR:-/tmp}/openclaw-plugin-install-$$"

# Build the new version entirely in a staging dir first (#2130) — the live plugin dir stays
# untouched and importable by a running gateway right up until the atomic swap below, instead of
# being `rm -rf`'d/rebuilt in place while the gateway may still be lazily importing from it.
echo "Fetching openclaw-hybrid-memory@$VERSION via npm pack ..."
mkdir -p "$TMP_DIR"
(cd "$TMP_DIR" && npm pack "openclaw-hybrid-memory@$VERSION")

echo "Extracting to staging dir $STAGE_DIR ..."
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
tar -xzf "$TMP_DIR"/openclaw-hybrid-memory-*.tgz -C "$STAGE_DIR" --strip-components=1

echo "Installing deps and rebuilding native modules (postinstall) in staging dir ..."
(cd "$STAGE_DIR" && npm install)

echo "Stopping OpenClaw gateway before swapping the plugin directory ..."
openclaw gateway stop 2>/dev/null || true

if [ -d "$PLUGIN_DIR" ]; then
  echo "Backing up existing plugin to $BACKUP_DIR ..."
  rm -rf "$BACKUP_DIR"
  mv "$PLUGIN_DIR" "$BACKUP_DIR"
fi

echo "Activating new version at $PLUGIN_DIR ..."
mv "$STAGE_DIR" "$PLUGIN_DIR"

echo "Cleaning up ..."
rm -rf "$TMP_DIR"

echo "Starting OpenClaw gateway ..."
openclaw gateway start

if [ -d "$BACKUP_DIR" ]; then
  echo "Done. Previous version preserved at $BACKUP_DIR — remove it once you've confirmed the upgrade is healthy."
else
  echo "Done."
fi
