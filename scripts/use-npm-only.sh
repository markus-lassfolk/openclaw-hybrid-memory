#!/usr/bin/env bash
# Remove the global/bundled memory-hybrid extension so OpenClaw only loads the
# NPM-installed copy from ~/.openclaw/extensions. Run this once if you see
# "duplicate plugin id detected" and want to use only:
#   openclaw plugins install openclaw-hybrid-memory
# for installs and upgrades.
set -e

GLOBAL_EXT="$(npm root -g 2>/dev/null)/openclaw/extensions/memory-hybrid"
if [ ! -d "$GLOBAL_EXT" ]; then
  echo "No global memory-hybrid found at $GLOBAL_EXT — nothing to remove."
  exit 0
fi

echo "Removing global copy: $GLOBAL_EXT"
rm -rf "$GLOBAL_EXT"
echo "Done. OpenClaw will now use only the plugin from ~/.openclaw/extensions."
echo "Upgrade with: openclaw plugins install openclaw-hybrid-memory"
echo "Then: openclaw gateway stop && openclaw gateway start"
