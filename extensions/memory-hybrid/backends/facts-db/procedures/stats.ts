import type { DatabaseSync } from "node:sqlite";

import { capturePluginError } from "../../../services/error-reporter.js";

export function getProceduresForAudit(
  db: DatabaseSync,
  limit = 5,
): Array<{
  taskPattern: string;
  recipeJson: string;
  procedureType: "positive" | "negative";
  confidence: number;
}> {
  try {
    const rows = db
      .prepare(
        `SELECT task_pattern, recipe_json, procedure_type, confidence
           FROM procedures
           ORDER BY confidence DESC, COALESCE(last_validated, created_at) DESC
           LIMIT ?`,
      )
      .all(limit) as Array<{
      task_pattern: string;
      recipe_json: string;
      procedure_type: "positive" | "negative";
      confidence: number;
    }>;
    return rows.map((r) => ({
      taskPattern: r.task_pattern,
      recipeJson: r.recipe_json,
      procedureType: r.procedure_type,
      confidence: r.confidence,
    }));
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "procedures-audit",
      severity: "info",
      subsystem: "facts",
    });
    return [];
  }
}

export function proceduresCount(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM procedures").get() as { cnt: number };
    return row?.cnt ?? 0;
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "count-procedures",
      severity: "info",
      subsystem: "facts",
    });
    return 0;
  }
}

export function proceduresValidatedCount(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM procedures WHERE last_validated IS NOT NULL").get() as {
      cnt: number;
    };
    return row?.cnt ?? 0;
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "count-procedures-validated",
      severity: "info",
      subsystem: "facts",
    });
    return 0;
  }
}

/** Count procedures whose `last_validated` timestamp is >= sinceSec. */
export function proceduresValidatedSince(db: DatabaseSync, sinceSec: number): number {
  try {
    const row = db
      .prepare("SELECT COUNT(*) as cnt FROM procedures WHERE last_validated IS NOT NULL AND last_validated >= ?")
      .get(sinceSec) as { cnt: number };
    return row?.cnt ?? 0;
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "count-procedures-validated-since",
      severity: "info",
      subsystem: "facts",
    });
    return 0;
  }
}

export function proceduresPromotedCount(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM procedures WHERE promoted_to_skill = 1").get() as {
      cnt: number;
    };
    return row?.cnt ?? 0;
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "count-procedures-promoted",
      severity: "info",
      subsystem: "facts",
    });
    return 0;
  }
}
