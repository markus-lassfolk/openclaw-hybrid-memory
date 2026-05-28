import type { DatabaseSync } from "node:sqlite";

/** Create procedure_versions table for version-level outcome tracking (#782). */
function migrateProcedureVersionsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS procedure_versions (
      id TEXT PRIMARY KEY,
      procedure_id TEXT NOT NULL,
      version_number INTEGER NOT NULL DEFAULT 1,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      avoidance_notes TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(procedure_id, version_number)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_proc_ver_procedure ON procedure_versions(procedure_id)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_proc_ver_num ON procedure_versions(procedure_id, version_number) WHERE version_number IS NOT NULL",
  );
}

/** Create procedure_failures table for individual failure event logging (#782). */
function migrateProcedureFailuresTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS procedure_failures (
      id TEXT PRIMARY KEY,
      procedure_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      context TEXT,
      failed_at_step INTEGER
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_proc_fail_procedure ON procedure_failures(procedure_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_proc_fail_version ON procedure_failures(procedure_id, version_number)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_proc_fail_ts ON procedure_failures(timestamp DESC)");
}

export function runProcedureMigrations(db: DatabaseSync): void {
  migrateProcedureVersionsTable(db);
  migrateProcedureFailuresTable(db);
}
