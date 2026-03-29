/**
 * Restrict SQLite database file permissions (owner read/write only).
 * Issue #865: document OS-level protection; chmod best-effort after open.
 */

import { chmodSync, existsSync } from "node:fs";

const MODE_0600 = 0o600;

export function tryRestrictSqliteDbFileMode(dbPath: string): void {
  if (dbPath === ":memory:") return;
  try {
    if (existsSync(dbPath)) {
      chmodSync(dbPath, MODE_0600);
    }
  } catch {
    // Non-fatal: some environments restrict chmod (e.g. exotic mounts).
  }
}
