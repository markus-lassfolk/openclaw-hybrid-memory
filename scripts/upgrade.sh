#!/usr/bin/env bash
# Update OpenClaw globally, then run post-upgrade (reinstall memory-hybrid deps + restart gateway).
# Copy to ~/.openclaw/scripts/upgrade.sh and chmod +x.
# Alias: alias openclaw-upgrade='~/.openclaw/scripts/upgrade.sh'

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Updating OpenClaw (npm update -g openclaw) ..."
npm update -g openclaw

echo "Running post-upgrade (reinstall extension deps + restart gateway) ..."
"$SCRIPT_DIR/post-upgrade.sh"
