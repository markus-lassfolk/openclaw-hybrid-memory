import type { DatabaseSync } from "node:sqlite";

export interface ScanCursor {
  lastSessionTs: number;
  lastRunAt: number;
  sessionsProcessed: number;
}

export function migrateScanCursorsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_cursors (
      scan_type TEXT PRIMARY KEY,
      last_session_ts INTEGER NOT NULL DEFAULT 0,
      last_run_at INTEGER NOT NULL DEFAULT 0,
      sessions_processed INTEGER NOT NULL DEFAULT 0
    )
  `);
}

export function getScanCursor(db: DatabaseSync, scanType: string): ScanCursor | null {
  const row = db
    .prepare("SELECT last_session_ts, last_run_at, sessions_processed FROM scan_cursors WHERE scan_type = ?")
    .get(scanType) as { last_session_ts: number; last_run_at: number; sessions_processed: number } | undefined;
  if (!row) return null;
  return {
    lastSessionTs: row.last_session_ts,
    lastRunAt: row.last_run_at,
    sessionsProcessed: row.sessions_processed,
  };
}

export function updateScanCursor(
  db: DatabaseSync,
  scanType: string,
  lastSessionTs: number,
  sessionsProcessed: number,
  nowMs: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO scan_cursors (scan_type, last_session_ts, last_run_at, sessions_processed)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scan_type) DO UPDATE SET
       last_session_ts = CASE
         WHEN excluded.sessions_processed > 0 THEN excluded.last_session_ts
         ELSE scan_cursors.last_session_ts
       END,
       last_run_at = excluded.last_run_at,
       sessions_processed = scan_cursors.sessions_processed + excluded.sessions_processed`,
  ).run(scanType, lastSessionTs, nowMs, sessionsProcessed);
}
