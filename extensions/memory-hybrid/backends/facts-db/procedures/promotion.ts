import type { DatabaseSync } from "node:sqlite";

import type { ProcedureEntry } from "../../../types/memory.js";

import type { ProcedureTriageReport } from "./types.js";
import { procedureBlockReason, slugForProcedure, summarizeProcedureTriage } from "./internal.js";
import { getProcedureById, POSITIVE_PROCEDURE_TYPE_SQL, procedureRowToEntry } from "./crud.js";

export function recordProcedureSuccess(db: DatabaseSync, id: string, recipeJson?: string, sessionId?: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const proc = getProcedureById(db, id);
  if (!proc) return false;

  // Read raw DB values to avoid inflating implied-success values back into the database
  const rawRow = db.prepare("SELECT success_count, failure_count FROM procedures WHERE id = ?").get(id) as
    | { success_count: number; failure_count: number }
    | undefined;
  if (!rawRow) return false;

  // Check if this session has already been counted
  if (sessionId) {
    const sourceSessions = proc.sourceSessions ? proc.sourceSessions.split(",") : [];
    if (sourceSessions.includes(sessionId)) {
      return false;
    }
    sourceSessions.push(sessionId);
    const newSourceSessions = sourceSessions.join(",");

    const successCount = rawRow.success_count + 1;
    const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (successCount - rawRow.failure_count)));
    if (recipeJson !== undefined) {
      db.prepare(
        `UPDATE procedures SET success_count = ?, last_validated = ?, confidence = ?, procedure_type = 'positive', recipe_json = ?, source_sessions = ?, updated_at = ? WHERE id = ?`,
      ).run(successCount, now, confidence, recipeJson, newSourceSessions, now, id);
    } else {
      db.prepare(
        `UPDATE procedures SET success_count = ?, last_validated = ?, confidence = ?, procedure_type = 'positive', source_sessions = ?, updated_at = ? WHERE id = ?`,
      ).run(successCount, now, confidence, newSourceSessions, now, id);
    }
  } else {
    const successCount = rawRow.success_count + 1;
    const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (successCount - rawRow.failure_count)));
    if (recipeJson !== undefined) {
      db.prepare(
        `UPDATE procedures SET success_count = ?, last_validated = ?, confidence = ?, procedure_type = 'positive', recipe_json = ?, updated_at = ? WHERE id = ?`,
      ).run(successCount, now, confidence, recipeJson, now, id);
    } else {
      db.prepare(
        `UPDATE procedures SET success_count = ?, last_validated = ?, confidence = ?, procedure_type = 'positive', updated_at = ? WHERE id = ?`,
      ).run(successCount, now, confidence, now, id);
    }
  }
  return true;
}

/** Record a failed use (bump failure_count, last_failed). */
export function recordProcedureFailure(db: DatabaseSync, id: string, recipeJson?: string, sessionId?: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const proc = getProcedureById(db, id);
  if (!proc) return false;

  // Read raw DB values to avoid inflating implied-success values back into the database
  const rawRow = db.prepare("SELECT success_count, failure_count FROM procedures WHERE id = ?").get(id) as
    | { success_count: number; failure_count: number }
    | undefined;
  if (!rawRow) return false;

  // Check if this session has already been counted
  if (sessionId) {
    const sourceSessions = proc.sourceSessions ? proc.sourceSessions.split(",") : [];
    if (sourceSessions.includes(sessionId)) {
      return false;
    }
    sourceSessions.push(sessionId);
    const newSourceSessions = sourceSessions.join(",");

    const failureCount = rawRow.failure_count + 1;
    const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (rawRow.success_count - failureCount)));
    if (recipeJson !== undefined) {
      db.prepare(
        `UPDATE procedures SET failure_count = ?, last_failed = ?, confidence = ?, procedure_type = 'negative', recipe_json = ?, source_sessions = ?, updated_at = ? WHERE id = ?`,
      ).run(failureCount, now, confidence, recipeJson, newSourceSessions, now, id);
    } else {
      db.prepare(
        `UPDATE procedures SET failure_count = ?, last_failed = ?, confidence = ?, procedure_type = 'negative', source_sessions = ?, updated_at = ? WHERE id = ?`,
      ).run(failureCount, now, confidence, newSourceSessions, now, id);
    }
  } else {
    const failureCount = rawRow.failure_count + 1;
    const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (rawRow.success_count - failureCount)));
    if (recipeJson !== undefined) {
      db.prepare(
        `UPDATE procedures SET failure_count = ?, last_failed = ?, confidence = ?, procedure_type = 'negative', recipe_json = ?, updated_at = ? WHERE id = ?`,
      ).run(failureCount, now, confidence, recipeJson, now, id);
    } else {
      db.prepare(
        `UPDATE procedures SET failure_count = ?, last_failed = ?, confidence = ?, procedure_type = 'negative', updated_at = ? WHERE id = ?`,
      ).run(failureCount, now, confidence, now, id);
    }
  }
  return true;
}

/** Procedures with success_count >= threshold and not yet promoted (for auto skill generation). */
export function getProceduresReadyForSkill(
  db: DatabaseSync,
  validationThreshold: number,
  limit = 50,
  skillTTLDays?: number,
): ProcedureEntry[] {
  const now = Math.floor(Date.now() / 1000);
  const useTtl = skillTTLDays != null ? 1 : 0;
  const cutoff = skillTTLDays != null ? now - Math.max(1, Math.floor(skillTTLDays)) * 24 * 60 * 60 : 0;
  const rows = db
    .prepare(
      `SELECT * FROM procedures
        WHERE ${POSITIVE_PROCEDURE_TYPE_SQL}
          AND success_count >= ?
          AND promoted_to_skill = 0
          AND (? = 0 OR COALESCE(last_validated, updated_at, created_at) >= ?)
        ORDER BY success_count DESC, COALESCE(last_validated, updated_at, created_at) DESC, rowid ASC
        LIMIT ?`,
    )
    .all(validationThreshold, useTtl, cutoff, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => procedureRowToEntry(db, r));
}

/** Mark procedure as promoted to skill (skill_path set). Idempotent for already-promoted rows. */
export function markProcedurePromoted(db: DatabaseSync, id: string, skillPath: string): boolean {
  const existing = getProcedureById(db, id);
  if (!existing) return false;
  const finalPath = existing.skillPath && existing.skillPath.trim() !== "" ? existing.skillPath : skillPath;
  const nowSec = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `UPDATE procedures
          SET promoted_to_skill = 1,
              skill_path = ?,
              updated_at = ?,
              skill_state = CASE
                WHEN skill_state IS NULL OR skill_state = '' OR skill_state = 'draft' THEN 'experimental'
                WHEN skill_state NOT IN ('draft', 'experimental', 'stable', 'retired') THEN 'experimental'
                ELSE skill_state
              END,
              skill_generated_at = COALESCE(skill_generated_at, ?, promoted_at, created_at),
              skill_version = COALESCE(skill_version, 1)
        WHERE id = ?`,
    )
    .run(finalPath, nowSec, nowSec, id);
  return result.changes > 0;
}

export function triageProcedures(
  db: DatabaseSync,
  options: { status?: "validated" | "all"; notPromoted?: boolean; limit?: number; validationThreshold?: number } = {},
): ProcedureTriageReport {
  const status = options.status ?? "validated";
  const notPromoted = options.notPromoted ?? true;
  const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 100)));
  const validationThreshold = Math.max(1, Math.floor(options.validationThreshold ?? 3));
  const clauses: string[] = [];
  if (status === "validated") clauses.push("last_validated IS NOT NULL");
  if (notPromoted) clauses.push("promoted_to_skill = 0");
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM procedures ${where}
       ORDER BY COALESCE(last_validated, updated_at, created_at) DESC, id ASC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  const procedures = rows.map((r) => procedureRowToEntry(db, r));

  const promotedRows = db
    .prepare("SELECT task_pattern, skill_path FROM procedures WHERE promoted_to_skill = 1 OR skill_path IS NOT NULL")
    .all() as Array<{ task_pattern: string; skill_path: string | null }>;
  const duplicateSlugs = new Set<string>();
  for (const promoted of promotedRows) {
    duplicateSlugs.add(slugForProcedure(promoted.task_pattern));
    if (promoted.skill_path) {
      const leaf = promoted.skill_path.split(/[/]/).filter(Boolean).pop();
      if (leaf) duplicateSlugs.add(leaf);
    }
  }

  const triageRows = procedures.map((proc) => ({
    id: proc.id,
    title: proc.taskPattern,
    validatedAt: proc.lastValidated,
    promotionBlockReason: procedureBlockReason(proc, duplicateSlugs, validationThreshold),
    lastRecall: proc.lastReinforcedAt ?? (proc.sourceSessions ? proc.lastValidated : null),
    successCount: proc.successCount,
    confidence: proc.confidence,
    skillPath: proc.skillPath,
  }));
  return { rows: triageRows, summary: summarizeProcedureTriage(triageRows) };
}

/** Procedures that are past TTL (last_validated older than ttl_days). For revalidation/decay. */
export function getStaleProcedures(db: DatabaseSync, ttlDays: number, limit = 100): ProcedureEntry[] {
  const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 24 * 3600;
  const rows = db
    .prepare(
      "SELECT * FROM procedures WHERE last_validated < ? OR (last_validated IS NULL AND created_at < ?) ORDER BY last_validated DESC NULLS LAST LIMIT ?",
    )
    .all(cutoff, cutoff, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => procedureRowToEntry(db, r));
}
