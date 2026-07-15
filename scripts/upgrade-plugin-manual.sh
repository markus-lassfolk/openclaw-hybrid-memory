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

# Always clean up this run's own staging/download dirs on exit, success or failure — a failure
# partway through (npm pack/install, or the swap below) previously left a `.staging-$$`/tmp dir
# behind forever, since each run's PID suffix never recurs (#2134 QA follow-up). No-op on the
# normal success path: STAGE_DIR has already been renamed into place by then, and TMP_DIR removed
# right after extraction. BACKUP_DIR is deliberately NOT cleaned up here — it is meant to survive a
# successful run so the operator can inspect/restore it.
trap 'rm -rf "$STAGE_DIR" "$TMP_DIR"' EXIT

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
rm -rf "$TMP_DIR"

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
if ! mv "$STAGE_DIR" "$PLUGIN_DIR"; then
  # The two-step swap is non-atomic — if this second rename fails after the first already moved
  # the previous version out of the way, PLUGIN_DIR would otherwise be left nonexistent and the
  # gateway stopped indefinitely, worse than the pre-#2130 race this script was written to fix.
  # Mirrors the rollback already used for the identical operation in
  # packages/openclaw-hybrid-memory-install/install.js (#2134 QA follow-up).
  echo "ERROR: failed to activate new version; rolling back to previous version ..." >&2
  if [ -d "$BACKUP_DIR" ] && [ ! -d "$PLUGIN_DIR" ]; then
    mv "$BACKUP_DIR" "$PLUGIN_DIR"
    echo "Rolled back: previous version restored at $PLUGIN_DIR." >&2
  fi
  echo "Restarting OpenClaw gateway ..." >&2
  openclaw gateway start || true
  exit 1
fi

echo "Starting OpenClaw gateway ..."
openclaw gateway start

if [ -d "$BACKUP_DIR" ]; then
  echo "Done. Previous version preserved at $BACKUP_DIR — remove it once you've confirmed the upgrade is healthy."
else
  echo "Done."
fi
