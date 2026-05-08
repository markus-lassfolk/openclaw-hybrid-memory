/**
 * SQLite FTS5 capability probe used at FactsDB construction.
 * Extracted from facts-db.ts for maintainability (#870).
 */

import type { DatabaseSync } from "node:sqlite";
import { capturePluginError } from "../../services/error-reporter.js";

/**
 * Hard-startup guard: fail fast if FTS5 is unavailable (hybrid search would degrade silently).
 */
export function verifyFts5Support(db: DatabaseSync): void {
  let fts5CompileOption = false;
  try {
    const row = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') as fts5").get() as { fts5: number };
    fts5CompileOption = row.fts5 === 1;
  } catch {
    // Best-effort only
  }

  const probeTable = "temp.memory_hybrid_fts5_probe";
  try {
    db.exec(`DROP TABLE IF EXISTS ${probeTable}`);
    db.exec(`CREATE VIRTUAL TABLE ${probeTable} USING fts5(content)`);
    db.exec(`DROP TABLE ${probeTable}`);
  } catch (err) {
    try {
      db.exec(`DROP TABLE IF EXISTS ${probeTable}`);
    } catch {
      // Best-effort cleanup only.
    }
    const reason = err instanceof Error ? err.message : String(err);
    const finalError = new Error(
      `memory-hybrid: SQLite FTS5 capability check failed during startup. Hybrid search would silently degrade to vector-only, so plugin initialization is aborted. Use a Node.js/SQLite runtime with FTS5 enabled. Original error: ${reason}`,
    );

    capturePluginError(finalError, {
      operation: "startup-fts5-probe",
      severity: "error",
      subsystem: "facts",
      context: {
        fts5_compileoption: String(fts5CompileOption),
        fts5_available: "false",
      },
    });

    throw finalError;
  }
}
