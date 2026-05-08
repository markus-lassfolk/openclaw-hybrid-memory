#!/usr/bin/env bash
# Run occasional maintenance on the hybrid-memory facts database (Issue #1049).
# This script does not stop the gateway or verify that the DB is unused.
# Avoid running it while the gateway holds the DB open for writes; maintenance may block or fail if the DB is locked.
#
# Usage:
#   ./scripts/vacuum-facts-db.sh /path/to/facts.db
#
# Effects: WAL checkpoint (truncate), optimize, VACUUM — reduces fragmentation and FTS index bloat.

set -euo pipefail
DB="${1:?Usage: $0 /path/to/facts.db}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 not found; install SQLite CLI." >&2
  exit 1
fi

if [[ ! -f "$DB" ]]; then
  echo "File not found: $DB" >&2
  exit 1
fi

echo "Maintaining: $DB"
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize; VACUUM;"
echo "Done."
