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

/** Canonical registry of SQLite TEXT columns that store ISO 8601 UTC timestamps. */
export type TextTimestampColumnSpec = { table: string; columns: string[] };

export const TEXT_TIMESTAMP_COLUMN_SPECS: TextTimestampColumnSpec[] = [
  { table: "fact_embeddings", columns: ["created_at"] },
  { table: "fact_variants", columns: ["created_at"] },
  { table: "verified_facts", columns: ["verified_at", "next_verification", "created_at"] },
  { table: "provenance_edges", columns: ["created_at"] },
  { table: "event_log", columns: ["timestamp", "created_at"] },
  {
    table: "crystallization_proposals",
    columns: ["created_at", "updated_at", "approved_at", "installed_at", "superseded_at"],
  },
  {
    table: "issues",
    columns: ["detected_at", "resolved_at", "verified_at", "created_at", "updated_at"],
  },
  { table: "tool_proposals", columns: ["created_at", "updated_at"] },
  { table: "workflow_traces", columns: ["created_at"] },
  { table: "learnings", columns: ["created_at", "updated_at"] },
  { table: "apitap_endpoints", columns: ["captured_at", "created_at", "updated_at"] },
  { table: "memory_events", columns: ["created_at", "processed_at"] },
];

function specsForTables(...tables: string[]): TextTimestampColumnSpec[] {
  return TEXT_TIMESTAMP_COLUMN_SPECS.filter((spec) => tables.includes(spec.table));
}

/** Facts DB tables with legacy TEXT timestamp columns. */
export function backfillFactsDbTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(
    db,
    specsForTables("fact_embeddings", "fact_variants", "verified_facts", "provenance_edges"),
  );
}

export function backfillEventLogTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, specsForTables("event_log"));
}

export function backfillCrystallizationTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, specsForTables("crystallization_proposals"));
}

export function backfillIssueTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, specsForTables("issues"));
}

export function backfillToolProposalTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, specsForTables("tool_proposals"));
}

export function backfillWorkflowTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, specsForTables("workflow_traces"));
}

export function backfillLearningsTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, specsForTables("learnings"));
}

export function backfillApitapTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, specsForTables("apitap_endpoints"));
}

export function backfillVerifiedFactsTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, specsForTables("verified_facts"));
}

export function backfillEventBusTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, specsForTables("memory_events"));
}

export function backfillProvenanceTextTimestamps(db: DatabaseSync): void {
  backfillTextTimestampColumns(db, specsForTables("provenance_edges"));
}
