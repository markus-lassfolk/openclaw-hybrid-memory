#!/usr/bin/env bash
# Release smoke checks for 2026.5.190 — run on a machine with OpenClaw + hybrid-mem installed.
# Exits non-zero on first failure. JSON output must be stdout-only (no stray log lines).

set -euo pipefail

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw CLI not found — install OpenClaw on this host before running smoke checks." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for release smoke checks (install jq or use a host that has it)." >&2
  exit 1
fi

echo "== hybrid-mem verify --json (stdout must be valid JSON) =="
json="$(openclaw hybrid-mem verify --json 2>/dev/null)" || {
  echo "verify --json failed (is hybrid-mem plugin installed and configured?)" >&2
  exit 1
}
echo "$json" | jq -e '.ok == true' >/dev/null
echo "verify --json: ok"

echo "== hybrid-mem skills rescan (dry validation of installed skills) =="
openclaw hybrid-mem skills rescan
echo "skills rescan: ok"

echo "== hybrid-mem sensor-sweep --dry-run (no HA writes) =="
openclaw hybrid-mem sensor-sweep --dry-run
echo "sensor-sweep --dry-run: ok"

echo "All release smoke checks passed."
