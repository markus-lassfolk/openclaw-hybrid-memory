/**
 * Shared `schema_meta` helpers for SQLite stores (Issue #1430).
 *
 * Stores a single logical schema version under key `schema_version` so backends
 * can run incremental, idempotent migrations on open.
 */

import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION_KEY = "schema_version";

export function ensureSchemaMetaTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
}

/** Returns 0 when the table is missing the version row (legacy / fresh before first migration). */
export function readSchemaVersion(db: DatabaseSync): number {
  ensureSchemaMetaTable(db);
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(SCHEMA_VERSION_KEY) as
    | { value: string }
    | undefined;
  if (row === undefined) return 0;

  const raw = row.value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid schema_meta ${SCHEMA_VERSION_KEY} value: ${row.value}`);
  }

  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Invalid schema_meta ${SCHEMA_VERSION_KEY} value: ${row.value}`);
  }
  return n;
}

export function writeSchemaVersion(db: DatabaseSync, version: number): void {
  ensureSchemaMetaTable(db);
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SCHEMA_VERSION_KEY, String(version));
}

export function runVersionedSchemaMigration(db: DatabaseSync, version: number, migrate: () => void): void {
  db.exec("BEGIN");
  try {
    migrate();
    writeSchemaVersion(db, version);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
