import type { DatabaseSync } from "node:sqlite";

interface ScanCursor {
  lastSessionTs: number;
  lastRunAt: number;
  sessionsProcessed: number;
  lastSessionFile?: string;
}

export function migrateScanCursorsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_cursors (
      scan_type TEXT PRIMARY KEY,
      last_session_ts INTEGER NOT NULL DEFAULT 0,
      last_session_file TEXT,
      last_run_at INTEGER NOT NULL DEFAULT 0,
      sessions_processed INTEGER NOT NULL DEFAULT 0
    )
  `);
  const columns = db.prepare("PRAGMA table_info(scan_cursors)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "last_session_file")) {
    db.exec("ALTER TABLE scan_cursors ADD COLUMN last_session_file TEXT");
  }
}

export function getScanCursor(db: DatabaseSync, scanType: string): ScanCursor | null {
  migrateScanCursorsTable(db);
  const row = db
    .prepare(
      "SELECT last_session_ts, last_session_file, last_run_at, sessions_processed FROM scan_cursors WHERE scan_type = ?",
    )
    .get(scanType) as
    | { last_session_ts: number; last_session_file: string | null; last_run_at: number; sessions_processed: number }
    | undefined;
  if (!row) return null;
  return {
    lastSessionTs: row.last_session_ts,
    ...(row.last_session_file ? { lastSessionFile: row.last_session_file } : {}),
    lastRunAt: row.last_run_at,
    sessionsProcessed: row.sessions_processed,
  };
}

export function updateScanCursor(
  db: DatabaseSync,
  scanType: string,
  lastSessionTs: number,
  sessionsProcessed: number,
  lastSessionFileOrNowMs?: string | number,
  nowMs: number = Date.now(),
): void {
  migrateScanCursorsTable(db);
  const lastSessionFile = typeof lastSessionFileOrNowMs === "string" ? lastSessionFileOrNowMs : undefined;
  const runAt = typeof lastSessionFileOrNowMs === "number" ? lastSessionFileOrNowMs : nowMs;
  db.prepare(
    `INSERT INTO scan_cursors (scan_type, last_session_ts, last_session_file, last_run_at, sessions_processed)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scan_type) DO UPDATE SET
       last_session_ts = CASE
         WHEN excluded.sessions_processed > 0 THEN excluded.last_session_ts
         ELSE scan_cursors.last_session_ts
       END,
       last_session_file = CASE
         WHEN excluded.sessions_processed > 0 THEN excluded.last_session_file
         ELSE scan_cursors.last_session_file
       END,
       last_run_at = excluded.last_run_at,
       sessions_processed = scan_cursors.sessions_processed + excluded.sessions_processed`,
  ).run(scanType, lastSessionTs, lastSessionFile ?? null, runAt, sessionsProcessed);
}
