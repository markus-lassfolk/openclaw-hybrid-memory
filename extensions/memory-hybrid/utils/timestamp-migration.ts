/**
 * Idempotent backfill: legacy SQLite TEXT timestamps → ISO 8601 UTC (…Z).
 */

import type { DatabaseSync } from "node:sqlite";
import { formatTimestampUtc, isLegacyTextTimestamp, parseTimestamp } from "./dates.js";

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { ok: number }
    | undefined;
  if (!row) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function hasLegacyTimestampRows(db: DatabaseSync, table: string, column: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM ${table}
       WHERE ${column} IS NOT NULL
         AND (
           ${column} GLOB '????-??-?? ??:??:??'
           OR ${column} NOT GLOB '*T*'
           OR (${column} GLOB '*T*' AND ${column} NOT GLOB '*Z' AND ${column} NOT GLOB '*z')
         )
       LIMIT 1`,
    )
    .get() as { ok: number } | undefined;
  return row != null;
}

/**
 * Convert one TEXT column from SQLite `datetime('now')` space format, numeric
 * epoch strings, or timezone-less ISO to strict ISO UTC.
 */
export function backfillTextTimestampColumn(db: DatabaseSync, table: string, column: string): void {
  if (!tableHasColumn(db, table, column)) return;
  if (!hasLegacyTimestampRows(db, table, column)) return;

  db.prepare(
    `UPDATE ${table}
     SET ${column} = strftime('%Y-%m-%dT%H:%M:%SZ', ${column})
     WHERE ${column} IS NOT NULL AND ${column} GLOB '????-??-?? ??:??:??'`,
  ).run();

  const rows = db
    .prepare(
      `SELECT rowid, ${column} AS val FROM ${table}
       WHERE ${column} IS NOT NULL
         AND (
           ${column} NOT GLOB '*T*'
           OR (${column} GLOB '*T*' AND ${column} NOT GLOB '*Z' AND ${column} NOT GLOB '*z')
         )`,
    )
    .all() as Array<{ rowid: number; val: string }>;

  if (rows.length === 0) return;

  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
  for (const row of rows) {
    if (!isLegacyTextTimestamp(row.val)) continue;
    const sec = parseTimestamp(row.val);
    if (sec != null) {
      update.run(formatTimestampUtc(sec), row.rowid);
    }
  }
}

export function backfillTextTimestampColumns(
  db: DatabaseSync,
  specs: Array<{ table: string; columns: string[] }>,
): void {
  for (const { table, columns } of specs) {
    for (const column of columns) {
      backfillTextTimestampColumn(db, table, column);
    }
  }
}

/** Facts DB tables with legacy TEXT timestamp columns. */
export function backfillFactsDbTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, [
    { table: "fact_embeddings", columns: ["created_at"] },
    { table: "fact_variants", columns: ["created_at"] },
    {
      table: "verified_facts",
      columns: ["verified_at", "next_verification", "created_at"],
    },
    { table: "provenance_edges", columns: ["created_at"] },
  ]);
}

export function backfillEventLogTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, [{ table: "event_log", columns: ["timestamp", "created_at"] }]);
}

export function backfillCrystallizationTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, [
    {
      table: "crystallization_proposals",
      columns: ["created_at", "updated_at", "approved_at", "installed_at", "superseded_at"],
    },
  ]);
}

export function backfillIssueTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, [
    {
      table: "issues",
      columns: ["detected_at", "resolved_at", "verified_at", "created_at", "updated_at"],
    },
  ]);
}

export function backfillToolProposalTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, [{ table: "tool_proposals", columns: ["created_at", "updated_at"] }]);
}

export function backfillWorkflowTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, [{ table: "workflow_traces", columns: ["created_at"] }]);
}

export function backfillLearningsTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, [{ table: "learnings", columns: ["created_at", "updated_at"] }]);
}

export function backfillApitapTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, [
    { table: "apitap_endpoints", columns: ["captured_at", "created_at", "updated_at"] },
  ]);
}

export function backfillVerifiedFactsTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, [
    {
      table: "verified_facts",
      columns: ["verified_at", "next_verification", "created_at"],
    },
  ]);
}

export function backfillEventBusTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, [
    { table: "memory_events", columns: ["created_at", "processed_at"] },
  ]);
}

export function backfillProvenanceTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, [{ table: "provenance_edges", columns: ["created_at"] }]);
}
