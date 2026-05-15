/**
 * Shared `schema_meta` helpers for SQLite stores (Issue #1430).
 *
 * Stores a single logical schema version under key `schema_version` so backends
 * can run incremental, idempotent migrations on open.
 */

import type { DatabaseSync } from "node:sqlite";

export function ensureSchemaMetaTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
}

/** Returns 0 when the table is missing the version row (legacy / fresh before first migration). */
export function readSchemaVersion(db: DatabaseSync, namespace: string): number {
  ensureSchemaMetaTable(db);
  const key = `${namespace}_schema_version`;
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as { value: string } | undefined;
  if (row === undefined) return 0;

  const raw = row.value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid schema_meta ${key} value: ${row.value}`);
  }

  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Invalid schema_meta ${key} value: ${row.value}`);
  }
  return n;
}

export function writeSchemaVersion(db: DatabaseSync, namespace: string, version: number): void {
  ensureSchemaMetaTable(db);
  const key = `${namespace}_schema_version`;
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(version));
}

export function runVersionedSchemaMigration(
  db: DatabaseSync,
  namespace: string,
  version: number,
  migrate: () => void,
): void {
  db.exec("BEGIN");
  try {
    migrate();
    writeSchemaVersion(db, namespace, version);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
