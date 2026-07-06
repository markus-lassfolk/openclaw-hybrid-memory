/**
 * Procedure row mapping and CRUD.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { capturePluginError } from "../../../services/error-reporter.js";
import {
  GENERATED_SKILL_LIFECYCLE_STATES,
  type MemoryScope,
  type ProcedureEntry,
  type ScopeFilter,
} from "../../../types/memory.js";
import { recordEpisode } from "../episodes.js";
import { sanitizeFts5QueryForFacts } from "../fts-text.js";
import { scopedRowMatchesFilter } from "../scope-sql.js";

// ---------- Procedural memory: procedures table CRUD ----------

const PROCEDURE_TYPES = ["positive", "negative"] as const;
const PROCEDURE_TYPE_SET = new Set<ProcedureEntry["procedureType"]>(PROCEDURE_TYPES);
const PROCEDURE_SKILL_STATE_SET = new Set<NonNullable<ProcedureEntry["skillState"]>>(GENERATED_SKILL_LIFECYCLE_STATES);

function reportUnexpectedProcedureEnum(field: "procedure_type" | "skill_state", value: unknown): void {
  capturePluginError(new TypeError(`Unexpected procedures.${field} value: ${String(value)}`), {
    operation: `procedure-row-${field}`,
    severity: "info",
    subsystem: "facts",
  });
}

export function normalizeProcedureType(value: unknown): ProcedureEntry["procedureType"] {
  if (typeof value !== "string" || value.trim() === "") return "positive";
  const trimmed = value.trim().toLowerCase();
  if (PROCEDURE_TYPE_SET.has(trimmed as ProcedureEntry["procedureType"])) {
    return trimmed as ProcedureEntry["procedureType"];
  }
  reportUnexpectedProcedureEnum("procedure_type", value);
  return "positive";
}

export function normalizeProcedureSkillState(value: unknown): NonNullable<ProcedureEntry["skillState"]> {
  if (typeof value !== "string" || value.trim() === "") return "draft";
  const trimmed = value.trim().toLowerCase();
  if (PROCEDURE_SKILL_STATE_SET.has(trimmed as NonNullable<ProcedureEntry["skillState"]>)) {
    return trimmed as NonNullable<ProcedureEntry["skillState"]>;
  }
  reportUnexpectedProcedureEnum("skill_state", value);
  return "draft";
}

/** Sort-only type rank without emitting drift reports (used in search comparators). */
export function procedureTypeSortRank(value: unknown): number {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (trimmed === "negative") return 0;
  return 1;
}

/** SQLite predicate: rows that normalize to positive procedure_type (incl. enum drift). */
export const POSITIVE_PROCEDURE_TYPE_SQL = `(
  procedure_type IS NULL
  OR trim(procedure_type) = ''
  OR LOWER(trim(procedure_type)) = 'positive'
  OR (LOWER(trim(procedure_type)) NOT IN ('positive', 'negative') AND trim(procedure_type) != '')
)`;

function repairProcedureEnumDrift(
  db: DatabaseSync,
  id: string,
  rawType: unknown,
  normalizedType: ProcedureEntry["procedureType"],
  rawState: unknown,
  normalizedState: NonNullable<ProcedureEntry["skillState"]>,
): void {
  const rawTypeStr = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  const rawStateStr = typeof rawState === "string" ? rawState.trim().toLowerCase() : "";
  const typeDrifted = rawTypeStr !== "" && !PROCEDURE_TYPE_SET.has(rawTypeStr as ProcedureEntry["procedureType"]);
  const stateDrifted =
    rawStateStr !== "" && !PROCEDURE_SKILL_STATE_SET.has(rawStateStr as NonNullable<ProcedureEntry["skillState"]>);
  if (!typeDrifted && !stateDrifted) return;
  try {
    db.prepare("UPDATE procedures SET procedure_type = ?, skill_state = ? WHERE id = ?").run(
      normalizedType,
      normalizedState,
      id,
    );
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "repair-procedure-enum-drift",
      severity: "info",
      subsystem: "facts",
    });
  }
}

function parseAvoidanceNotes(raw: string | null | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((note): note is string => typeof note === "string");
  } catch {
    return [];
  }
}

/**
 * Load version-level feedback data for a procedure and merge into ProcedureEntry.
 * Called after the base row is mapped so we keep procedureRowToEntry pure.
 */
export function enrichProcedureWithFeedback(db: DatabaseSync, base: ProcedureEntry): ProcedureEntry {
  try {
    // Always compute lastOutcome from procedure's own timestamps (available even without version records)
    let lastOutcome: "success" | "failure" | "unknown" = "unknown";
    if (base.lastFailed !== null && base.lastValidated !== null) {
      lastOutcome = base.lastFailed > base.lastValidated ? "failure" : "success";
    } else if (base.lastFailed !== null) {
      lastOutcome = "failure";
    } else if (base.lastValidated !== null) {
      lastOutcome = "success";
    }

    const versionRow = db
      .prepare(
        `SELECT pv.version_number, pv.success_count, pv.failure_count, pv.avoidance_notes
         FROM procedure_versions pv
         WHERE pv.procedure_id = ?
         ORDER BY pv.version_number DESC
         LIMIT 1`,
      )
      .get(base.id) as
      | {
          version_number: number;
          success_count: number;
          failure_count: number;
          avoidance_notes: string | null;
        }
      | undefined;

    if (!versionRow) {
      // No version records yet — mirror implied-success for validated rows (see merged branch below).
      const implied =
        base.lastValidated != null &&
        base.successCount === 0 &&
        base.failureCount === 0 &&
        (base.lastFailed == null || base.lastValidated > base.lastFailed)
          ? 1
          : 0;
      return { ...base, lastOutcome, successCount: base.successCount + implied };
    }

    // Aggregate all successes and failures across ALL version records to compute overall successRate.
    // procedure_versions tracks per-version outcomes; procedure table tracks what was
    // validated/failed before version tracking started.
    const versionCounts = db
      .prepare(
        `SELECT COALESCE(SUM(success_count), 0) as total_succ,
                COALESCE(SUM(failure_count), 0) as total_fail
           FROM procedure_versions
           WHERE procedure_id = ?`,
      )
      .get(base.id) as { total_succ: number; total_fail: number };

    const totalSuccess = versionCounts.total_succ;
    const totalFailure = versionCounts.total_fail;
    // Validated procedures may have last_validated set by extraction with procedures.success_count still 0
    // and no procedure_versions rows yet — treat as one implicit success so promotion gates match operator intent (#audit remediation).
    const baseMergedSuccess = base.successCount + totalSuccess;
    const validatedWithoutTrials =
      base.lastValidated != null &&
      (base.lastFailed == null || base.lastValidated > base.lastFailed) &&
      base.failureCount === 0 &&
      totalFailure === 0;
    const effectiveSuccess = validatedWithoutTrials && baseMergedSuccess === 0 ? 1 : baseMergedSuccess;
    // successRate stays version-table-only (matches historical enrich semantics; tests + UI trends).
    const versionTrialTotal = totalSuccess + totalFailure;
    const successRate = versionTrialTotal > 0 ? totalSuccess / versionTrialTotal : 0;

    // Merge avoidance notes across all versions (not only the latest row — failures may be on older versions)
    const allNotes = new Set<string>(base.avoidanceNotes ?? []);
    const versionNoteRows = db
      .prepare(
        `SELECT avoidance_notes FROM procedure_versions
         WHERE procedure_id = ? AND avoidance_notes IS NOT NULL`,
      )
      .all(base.id) as Array<{ avoidance_notes: string }>;
    for (const row of versionNoteRows) {
      for (const n of parseAvoidanceNotes(row.avoidance_notes)) allNotes.add(n);
    }

    return {
      ...base,
      successCount: effectiveSuccess,
      failureCount: base.failureCount + totalFailure,
      version: versionRow.version_number,
      successRate,
      avoidanceNotes: allNotes.size > 0 ? Array.from(allNotes) : undefined,
      lastOutcome,
    };
  } catch {
    return base;
  }
}

export function procedureRowToEntry(db: DatabaseSync, row: Record<string, unknown>): ProcedureEntry {
  const id = row.id as string;
  const procedureType = normalizeProcedureType(row.procedure_type);
  const skillState = normalizeProcedureSkillState(row.skill_state);
  repairProcedureEnumDrift(db, id, row.procedure_type, procedureType, row.skill_state, skillState);
  const base: ProcedureEntry = {
    id,
    taskPattern: row.task_pattern as string,
    recipeJson: row.recipe_json as string,
    procedureType,
    successCount: (row.success_count as number) ?? 0,
    failureCount: (row.failure_count as number) ?? 0,
    lastValidated: (row.last_validated as number) ?? null,
    lastFailed: (row.last_failed as number) ?? null,
    confidence: (row.confidence as number) ?? 0.5,
    ttlDays: (row.ttl_days as number) ?? 30,
    promotedToSkill: (row.promoted_to_skill as number) ?? 0,
    skillPath: (row.skill_path as string) ?? null,
    createdAt: (row.created_at as number) ?? 0,
    updatedAt: (row.updated_at as number) ?? 0,
    sourceSessions: (row.source_sessions as string) ?? undefined,
    reinforcedCount: (row.reinforced_count as number) ?? 0,
    lastReinforcedAt: (row.last_reinforced_at as number) ?? null,
    reinforcedQuotes: (() => {
      const raw = row.reinforced_quotes as string | null;
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : null;
      } catch (err) {
        capturePluginError(err as Error, {
          operation: "json-parse-quotes",
          severity: "info",
          subsystem: "facts",
        });
        return null;
      }
    })(),
    promotedAt: (row.promoted_at as number) ?? null,
    skillState,
    skillStateReason: (row.skill_state_reason as string) ?? null,
    skillVersion: (row.skill_version as number) ?? 1,
    skillGeneratedAt: (row.skill_generated_at as number) ?? null,
    skillStateChangedAt: (row.skill_state_changed_at as number) ?? null,
    scope: (row.scope as string) ?? "global",
    scopeTarget: (row.scope_target as string) ?? null,
  };
  return enrichProcedureWithFeedback(db, base);
}

// ---------- Procedure feedback loop (#782) ----------

/**
 * Record feedback (success or failure) for a procedure.
 *
 * On failure:
 *   - Inserts a failure record in `procedure_failures`.
 *   - Upserts a new or existing row in `procedure_versions` (increments version).
 *   - Creates an episode record via `recordEpisode()`.
 *   - Updates `last_failed` on the procedure.
 *
 * On success:
 *   - Upserts a new or existing row in `procedure_versions` (increments success count).
 *   - Updates `last_validated` on the procedure.
 *   - Updates procedure_type to 'positive'.
 *
 * Returns the procedure entry with enriched feedback fields, or null if the procedure
 * does not exist.
 */
export function procedureFeedback(
  db: DatabaseSync,
  input: {
    procedureId: string;
    success: boolean;
    context?: string;
    failedAtStep?: number;
    tags?: string[];
    duration?: number;
    scope?: "global" | "user" | "agent" | "session";
    scopeTarget?: string | null;
    agentId?: string;
    userId?: string;
    sessionId?: string;
  },
): ProcedureEntry | null {
  const nowSec = Math.floor(Date.now() / 1000);
  // Only enforce scope when the caller actually identified one — omitting it entirely
  // preserves unrestricted (e.g. CLI/admin) access, matching getById's scopeFilter contract.
  const feedbackScopeFilter: ScopeFilter | undefined =
    input.userId || input.agentId || input.sessionId
      ? { userId: input.userId ?? null, agentId: input.agentId ?? null, sessionId: input.sessionId ?? null }
      : undefined;
  const proc = getProcedureById(db, input.procedureId, feedbackScopeFilter);
  if (!proc) return null;

  if (input.success) {
    // Upsert version record with +1 success
    const existingVer = db
      .prepare(
        "SELECT id, success_count FROM procedure_versions WHERE procedure_id = ? ORDER BY version_number DESC LIMIT 1",
      )
      .get(input.procedureId) as { id: string; success_count: number } | undefined;

    if (existingVer) {
      db.prepare("UPDATE procedure_versions SET success_count = success_count + 1 WHERE id = ?").run(existingVer.id);
    } else {
      // First version: create version 1 with 1 success
      db.prepare(
        `INSERT INTO procedure_versions (id, procedure_id, version_number, success_count, failure_count, avoidance_notes, created_at)
           VALUES (?, ?, 1, 1, 0, NULL, ?)`,
      ).run(randomUUID(), input.procedureId, nowSec);
    }

    // Get aggregated counts from version table (source of truth)
    const versionCounts = db
      .prepare(
        `SELECT COALESCE(SUM(success_count), 0) as total_succ,
                COALESCE(SUM(failure_count), 0) as total_fail
           FROM procedure_versions
           WHERE procedure_id = ?`,
      )
      .get(input.procedureId) as { total_succ: number; total_fail: number };

    // Update procedure record (do NOT bump success_count — version table is the source of truth for counts)
    db.prepare(
      `UPDATE procedures SET last_validated = ?, confidence = ?, procedure_type = 'positive', updated_at = ? WHERE id = ?`,
    ).run(
      nowSec,
      Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (versionCounts.total_succ - versionCounts.total_fail))),
      nowSec,
      input.procedureId,
    );
  } else {
    // Failure: insert new version record (one version per failure event) and failure record
    const latestVer = db
      .prepare(
        "SELECT version_number FROM procedure_versions WHERE procedure_id = ? ORDER BY version_number DESC LIMIT 1",
      )
      .get(input.procedureId) as { version_number: number } | undefined;

    const newVersionNumber = (latestVer?.version_number ?? 0) + 1;

    // Build avoidance note from context
    const avoidanceNotes: string[] = [];
    if (input.context) {
      const note =
        input.failedAtStep !== undefined
          ? `v${newVersionNumber} step ${input.failedAtStep}: ${input.context}`
          : `v${newVersionNumber}: ${input.context}`;
      avoidanceNotes.push(note);
    }

    // Merge with existing avoidance notes from previous versions
    const prevNotes = db
      .prepare("SELECT avoidance_notes FROM procedure_versions WHERE procedure_id = ?")
      .all(input.procedureId) as Array<{ avoidance_notes: string | null }>;
    for (const row of prevNotes) {
      if (row.avoidance_notes) {
        const existing = parseAvoidanceNotes(row.avoidance_notes);
        avoidanceNotes.push(...existing);
      }
    }

    const notesJson = avoidanceNotes.length > 0 ? JSON.stringify(avoidanceNotes) : null;

    // One version record per failure event
    db.prepare(
      `INSERT INTO procedure_versions (id, procedure_id, version_number, success_count, failure_count, avoidance_notes, created_at)
         VALUES (?, ?, ?, 0, 1, ?, ?)`,
    ).run(randomUUID(), input.procedureId, newVersionNumber, notesJson, nowSec);

    // Insert individual failure record
    db.prepare(
      `INSERT INTO procedure_failures (id, procedure_id, version_number, timestamp, context, failed_at_step)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), input.procedureId, newVersionNumber, nowSec, input.context ?? null, input.failedAtStep ?? null);

    // Get aggregated counts from version table (source of truth)
    const versionCounts = db
      .prepare(
        `SELECT COALESCE(SUM(success_count), 0) as total_succ,
                COALESCE(SUM(failure_count), 0) as total_fail
           FROM procedure_versions
           WHERE procedure_id = ?`,
      )
      .get(input.procedureId) as { total_succ: number; total_fail: number };

    // Update procedure record (do NOT bump failure_count — version table is the source of truth for counts)
    db.prepare(
      `UPDATE procedures SET last_failed = ?, confidence = ?, procedure_type = 'negative', updated_at = ? WHERE id = ?`,
    ).run(
      nowSec,
      Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (versionCounts.total_succ - versionCounts.total_fail))),
      nowSec,
      input.procedureId,
    );

    // Create an episode record for this failure
    const eventText =
      input.context && input.failedAtStep !== undefined
        ? `Procedure "${proc.taskPattern}" failed at step ${input.failedAtStep}: ${input.context}`
        : input.context
          ? `Procedure "${proc.taskPattern}" failed: ${input.context}`
          : `Procedure "${proc.taskPattern}" failed (version ${newVersionNumber})`;

    try {
      recordEpisode(db, {
        event: eventText,
        outcome: "failure",
        duration: input.duration,
        context: input.context,
        procedureId: input.procedureId,
        tags: input.tags,
        importance: 0.8,
        scope: input.scope ?? "global",
        scopeTarget: (input.scope ?? "global") === "global" ? null : (input.scopeTarget ?? null),
        agentId: input.agentId,
        userId: input.userId,
        sessionId: input.sessionId,
      });
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "record-episode-on-failure",
        severity: "warn",
        subsystem: "facts",
      });
    }
  }

  return getProcedureById(db, input.procedureId, feedbackScopeFilter);
}

/**
 * Get all versions for a procedure, ordered newest first.
 */
export function getProcedureVersions(
  db: DatabaseSync,
  procedureId: string,
): Array<{
  id: string;
  versionNumber: number;
  successCount: number;
  failureCount: number;
  avoidanceNotes: string[] | null;
  createdAt: number;
}> {
  const rows = db
    .prepare(
      `SELECT id, version_number, success_count, failure_count, avoidance_notes, created_at
       FROM procedure_versions
       WHERE procedure_id = ?
       ORDER BY version_number DESC`,
    )
    .all(procedureId) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const notes = parseAvoidanceNotes(r.avoidance_notes as string | null);
    return {
      id: r.id as string,
      versionNumber: r.version_number as number,
      successCount: r.success_count as number,
      failureCount: r.failure_count as number,
      avoidanceNotes: notes.length > 0 ? notes : null,
      createdAt: r.created_at as number,
    };
  });
}

/**
 * Get all failure records for a procedure, ordered newest first.
 */
export function getProcedureFailures(
  db: DatabaseSync,
  procedureId: string,
): Array<{
  id: string;
  versionNumber: number;
  timestamp: number;
  context: string | null;
  failedAtStep: number | null;
}> {
  const rows = db
    .prepare(
      `SELECT id, version_number, timestamp, context, failed_at_step
       FROM procedure_failures
       WHERE procedure_id = ?
       ORDER BY timestamp DESC`,
    )
    .all(procedureId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id as string,
    versionNumber: r.version_number as number,
    timestamp: r.timestamp as number,
    context: (r.context as string) ?? null,
    failedAtStep: (r.failed_at_step as number) ?? null,
  }));
}

/** Insert or replace a procedure. Returns the procedure id. */
export function upsertProcedure(
  db: DatabaseSync,
  proc: {
    id?: string;
    taskPattern: string;
    recipeJson: string;
    procedureType: "positive" | "negative";
    successCount?: number;
    failureCount?: number;
    lastValidated?: number | null;
    lastFailed?: number | null;
    confidence?: number;
    ttlDays?: number;
    sourceSessionId?: string;
    /** Memory scope — global, user, agent, or session. Default global. */
    scope?: "global" | "user" | "agent" | "session";
    /** Scope target (userId, agentId, or sessionId). Required when scope is user/agent/session. */
    scopeTarget?: string | null;
  },
): ProcedureEntry {
  const id = proc.id ?? randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const existing = getProcedureById(db, id);
  if (existing) {
    const successCount = proc.successCount ?? existing.successCount;
    const failureCount = proc.failureCount ?? existing.failureCount;
    const confidence = proc.confidence ?? Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (successCount - failureCount)));
    const scope = proc.scope ?? existing.scope ?? "global";
    const scopeTarget = proc.scopeTarget ?? existing.scopeTarget ?? null;
    db.prepare(
      "UPDATE procedures SET task_pattern = ?, recipe_json = ?, procedure_type = ?, success_count = ?, failure_count = ?, last_validated = ?, last_failed = ?, confidence = ?, ttl_days = ?, scope = ?, scope_target = ?, updated_at = ? WHERE id = ?",
    ).run(
      proc.taskPattern,
      proc.recipeJson,
      proc.procedureType,
      successCount,
      failureCount,
      proc.lastValidated ?? existing.lastValidated,
      proc.lastFailed ?? existing.lastFailed,
      confidence,
      proc.ttlDays ?? existing.ttlDays,
      scope,
      scopeTarget ?? null,
      now,
      id,
    );
    return getProcedureById(db, id)!;
  }
  const scope = proc.scope ?? "global";
  const scopeTarget = proc.scopeTarget ?? null;
  db.prepare(
    `INSERT INTO procedures (id, task_pattern, recipe_json, procedure_type, success_count, failure_count, last_validated, last_failed, confidence, ttl_days, promoted_to_skill, skill_path, source_sessions, scope, scope_target, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    proc.taskPattern,
    proc.recipeJson,
    proc.procedureType,
    proc.successCount ?? 1,
    proc.failureCount ?? 0,
    proc.lastValidated ?? null,
    proc.lastFailed ?? null,
    proc.confidence ?? 0.5,
    proc.ttlDays ?? 30,
    proc.sourceSessionId ?? null,
    scope,
    scopeTarget,
    now,
    now,
  );
  return getProcedureById(db, id)!;
}

/** List procedures ordered by updated_at DESC. Returns up to limit (default 100). */
export function listProcedures(db: DatabaseSync, limit = 100): ProcedureEntry[] {
  try {
    const rows = db
      .prepare("SELECT * FROM procedures ORDER BY updated_at DESC, created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => procedureRowToEntry(db, r));
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "list-procedures",
      severity: "info",
      subsystem: "facts",
    });
    return [];
  }
}

/** List positive procedures updated in the last N days. Days clamped to [1, 365]. */
export function listProceduresUpdatedInLastNDays(db: DatabaseSync, days: number, limit = 500): ProcedureEntry[] {
  if (Number.isNaN(days) || days <= 0) return [];
  const clampedDays = Math.min(365, Math.max(1, Math.floor(days)));
  try {
    const cutoff = Math.floor(Date.now() / 1000) - clampedDays * 24 * 3600;
    const rows = db
      .prepare(
        `SELECT * FROM procedures WHERE ${POSITIVE_PROCEDURE_TYPE_SQL} AND updated_at >= ? AND promoted_to_skill = 0 ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
      )
      .all(cutoff, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => procedureRowToEntry(db, r));
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "list-procedures-recent",
      severity: "info",
      subsystem: "facts",
    });
    return [];
  }
}

export function getProcedureById(
  db: DatabaseSync,
  id: string,
  scopeFilter?: ScopeFilter | null,
): ProcedureEntry | null {
  const row = db.prepare("SELECT * FROM procedures WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const entry = procedureRowToEntry(db, row);
  if (scopeFilter && !scopedRowMatchesFilter(entry.scope as MemoryScope | undefined, entry.scopeTarget, scopeFilter))
    return null;
  return entry;
}

/** Find procedure by task_pattern hash or normalized match (for dedupe). */
export function findProcedureByTaskPattern(db: DatabaseSync, taskPattern: string, limit = 5): ProcedureEntry[] {
  const sanitized = sanitizeFts5QueryForFacts(taskPattern);
  const safeQuery = sanitized
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 5)
    .map((w) => `"${w}"`)
    .join(" OR ");
  if (!safeQuery) return [];
  try {
    const rows = db
      .prepare(
        "SELECT p.* FROM procedures p JOIN procedures_fts fts ON p.rowid = fts.rowid WHERE procedures_fts MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(safeQuery, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => procedureRowToEntry(db, r));
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "fts-query",
      severity: "info",
      subsystem: "facts",
    });
    return [];
  }
}
