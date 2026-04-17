/**
 * Restrict SQLite database file permissions (owner read/write only).
 * Issue #865: document OS-level protection; chmod best-effort after open.
 */

import { chmodSync, existsSync } from "node:fs";

const MODE_0600 = 0o600;

export function tryRestrictSqliteDbFileMode(dbPath: string): void {
	if (dbPath === ":memory:") return;
	const candidates = [
		dbPath,
		`${dbPath}-wal`,
		`${dbPath}-shm`,
		`${dbPath}-journal`,
	];
	for (const p of candidates) {
		try {
			if (existsSync(p)) {
				chmodSync(p, MODE_0600);
			}
		} catch {
			// Non-fatal: some environments restrict chmod (e.g. exotic mounts).
		}
	}
}
