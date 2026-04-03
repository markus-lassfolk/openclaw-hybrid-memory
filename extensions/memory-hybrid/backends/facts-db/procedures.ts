/**
 * Procedural memory: procedures table CRUD (#782) (Issue #954 split).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ProcedureEntry, ScopeFilter } from "../../types/memory.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { recordEpisode } from "./episodes.js";
import { sanitizeFts5QueryForFacts } from "./fts-text.js";
import { scopeFilterClausePositional } from "./scope-sql.js";

// ---------- Procedural memory: procedures table CRUD ----------

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
      // No version records yet — return base with lastOutcome computed from procedure timestamps
      return { ...base, lastOutcome };
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
    const total = totalSuccess + totalFailure;
    const successRate = total > 0 ? totalSuccess / total : 0;

    // Merge avoidance notes across all versions
    const allNotes = new Set<string>(base.avoidanceNotes ?? []);
    if (versionRow.avoidance_notes) {
      try {
        const notes = JSON.parse(versionRow.avoidance_notes) as string[];
        notes.forEach((n) => allNotes.add(n));
      } catch {
        // ignore parse errors
      }
    }

    return {
      ...base,
      successCount: base.successCount + totalSuccess,
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
  const base: ProcedureEntry = {
    id: row.id as string,
    taskPattern: row.task_pattern as string,
    recipeJson: row.recipe_json as string,
    procedureType: (row.procedure_type as "positive" | "negative") || "positive",
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
  const proc = getProcedureById(db, input.procedureId);
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
        try {
          const existing = JSON.parse(row.avoidance_notes) as string[];
          avoidanceNotes.push(...existing);
        } catch {
          // ignore
        }
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

  return getProcedureById(db, input.procedureId);
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

  return rows.map((r) => ({
    id: r.id as string,
    versionNumber: r.version_number as number,
    successCount: r.success_count as number,
    failureCount: r.failure_count as number,
    avoidanceNotes: (() => {
      const raw = r.avoidance_notes as string | null;
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((n: unknown) => typeof n === "string") : null;
      } catch {
        return null;
      }
    })(),
    createdAt: r.created_at as number,
  }));
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
        `SELECT * FROM procedures WHERE procedure_type = 'positive' AND updated_at >= ? AND promoted_to_skill = 0 ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
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

export function getProcedureById(db: DatabaseSync, id: string): ProcedureEntry | null {
  const row = db.prepare("SELECT * FROM procedures WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return procedureRowToEntry(db, row);
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

/**
 * Search procedures by task description (FTS). Returns positive procedures first, then negative.
 * Phase 2: Applies reinforcement boost to score when reinforced_count > 0.
 */
export function searchProcedures(
  db: DatabaseSync,
  taskDescription: string,
  limit = 10,
  reinforcementBoost = 0.1,
  scopeFilter?: ScopeFilter,
): ProcedureEntry[] {
  const sanitized = sanitizeFts5QueryForFacts(taskDescription);
  const safeQuery = sanitized
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 8)
    .map((w) => `"${w}"`)
    .join(" OR ");
  if (!safeQuery) return [];
  try {
    // Apply scope filter to procedures search
    const { clause: scopeClause, params: scopeParams } = scopeFilterClausePositional(scopeFilter);
    const baseSql = `SELECT p.*, bm25(procedures_fts) as fts_score FROM procedures p JOIN procedures_fts fts ON p.rowid = fts.rowid WHERE procedures_fts MATCH ?${scopeClause} ORDER BY p.procedure_type DESC, bm25(procedures_fts) LIMIT ?`;
    const rows = db.prepare(baseSql).all(safeQuery, ...scopeParams, limit * 2) as Array<Record<string, unknown>>;

    if (rows.length === 0) return [];

    // Phase 2: Compute composite score: FTS relevance + confidence + reinforcement
    const minFtsScore = Math.min(...rows.map((r) => r.fts_score as number));
    const maxFtsScore = Math.max(...rows.map((r) => r.fts_score as number));
    const ftsRange = maxFtsScore - minFtsScore || 1;

    type ScoredRow = Record<string, unknown> & { boostedScore: number };
    const scored: ScoredRow[] = rows.map((r) => {
      const reinforcedCount = (r.reinforced_count as number) ?? 0;
      const confidence = (r.confidence as number) ?? 0.5;
      const reinforcement = reinforcedCount > 0 ? reinforcementBoost : 0;
      // Normalize FTS score to 0-1 range (inverted because bm25 returns negative scores)
      const rawFtsScore = 1 - ((r.fts_score as number) - minFtsScore) / ftsRange;
      const ftsScore = Number.isNaN(rawFtsScore) ? 0.8 : rawFtsScore;
      // Composite: 60% FTS relevance, 40% confidence, plus reinforcement boost (capped at 1.0)
      const boostedScore = Math.min(1.0, ftsScore * 0.6 + confidence * 0.4 + reinforcement);
      return { ...r, boostedScore };
    });

    // Sort by procedure_type (positive first), then boosted score, then validation
    scored.sort((a, b) => {
      const typeA = (a.procedure_type as string) === "positive" ? 1 : 0;
      const typeB = (b.procedure_type as string) === "positive" ? 1 : 0;
      if (typeB !== typeA) return typeB - typeA;
      if (b.boostedScore !== a.boostedScore) return b.boostedScore - a.boostedScore;
      const lastValA = (a.last_validated as number) ?? 0;
      const lastValB = (b.last_validated as number) ?? 0;
      return lastValB - lastValA;
    });

    return scored.slice(0, limit).map((r) => procedureRowToEntry(db, r));
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "fts-query",
      severity: "info",
      subsystem: "facts",
    });
    return [];
  }
}

/**
 * Confidence-weighted procedural ranking (enhancement):
 * - Combines FTS relevance with confidence, recency, success rate, and recent failures
 * - Recency decay over 30-day window (min 0.3 factor)
 * - Success rate boost (50-100% weight based on successCount/failureCount)
 * - Penalty for procedures that failed in last 7 days (0.5 multiplier)
 * - Never-validated procedures get 30% penalty
 * - Reinforcement boost for user-praised procedures (configurable)
 * Returns procedures with relevanceScore, sorted by composite score.
 */
export function searchProceduresRanked(
  db: DatabaseSync,
  taskDescription: string,
  limit = 10,
  reinforcementBoost = 0.1,
  scopeFilter?: ScopeFilter,
): Array<ProcedureEntry & { relevanceScore: number }> {
  const sanitized = sanitizeFts5QueryForFacts(taskDescription);
  const safeQuery = sanitized
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 8)
    .map((w) => `"${w}"`)
    .join(" OR ");
  if (!safeQuery) return [];

  const nowSec = Math.floor(Date.now() / 1000);
  const RECENCY_WINDOW = 30 * 24 * 3600; // 30 days
  const RECENT_FAILURE_WINDOW = 7 * 24 * 3600; // 7 days
  const MIN_RECENCY_FACTOR = 0.3;
  const NEVER_VALIDATED_PENALTY = 0.7; // 30% penalty
  const RECENT_FAILURE_PENALTY = 0.5;

  try {
    // Apply scope filter to procedures search
    const { clause: scopeClause, params: scopeParams } = scopeFilterClausePositional(scopeFilter);
    const rows = db
      .prepare(
        `SELECT p.*, bm25(procedures_fts) as fts_score FROM procedures p 
         JOIN procedures_fts fts ON p.rowid = fts.rowid 
         WHERE procedures_fts MATCH ?${scopeClause} 
         ORDER BY bm25(procedures_fts) 
         LIMIT ?`,
      )
      .all(safeQuery, ...scopeParams, limit * 3) as Array<Record<string, unknown>>;

    if (rows.length === 0) return [];

    // Normalize FTS scores to 0-1 range
    const minFtsScore = Math.min(...rows.map((r) => r.fts_score as number));
    const maxFtsScore = Math.max(...rows.map((r) => r.fts_score as number));
    const ftsRange = maxFtsScore - minFtsScore || 1;

    type ScoredRow = ProcedureEntry & { relevanceScore: number };
    const scored: ScoredRow[] = rows.map((r) => {
      const proc = procedureRowToEntry(db, r);
      const confidence = proc.confidence;

      // FTS relevance (inverted because bm25 returns negative scores)
      const rawFtsScore = 1 - ((r.fts_score as number) - minFtsScore) / ftsRange;
      const ftsScore = Number.isNaN(rawFtsScore) ? 0.8 : rawFtsScore;

      // Recency factor (decay over 30 days, min 0.3)
      const lastActive = proc.lastValidated ?? proc.createdAt;
      const ageSeconds = nowSec - lastActive;
      const recencyFactor =
        ageSeconds > RECENCY_WINDOW
          ? MIN_RECENCY_FACTOR
          : Math.max(MIN_RECENCY_FACTOR, 1 - ageSeconds / RECENCY_WINDOW);

      // Success rate (50-100% weight based on successCount/failureCount)
      const totalTrials = proc.successCount + proc.failureCount;
      let successRateWeight = 0.75; // default for never-validated
      if (totalTrials > 0) {
        const successRate = proc.successCount / totalTrials;
        successRateWeight = 0.5 + successRate * 0.5; // 50% base + up to 50% from success rate
      }

      // Penalty for recent failures (last 7 days)
      let recentFailurePenalty = 1.0;
      if (proc.lastFailed && nowSec - proc.lastFailed < RECENT_FAILURE_WINDOW) {
        recentFailurePenalty = RECENT_FAILURE_PENALTY;
      }

      // Penalty for never-validated procedures
      let validationPenalty = 1.0;
      if (!proc.lastValidated) {
        validationPenalty = NEVER_VALIDATED_PENALTY;
      }

      // Reinforcement boost for user-praised procedures
      const reinforcedCount = (r.reinforced_count as number) ?? 0;
      const reinforcement = reinforcedCount > 0 ? reinforcementBoost : 0;

      // Composite score: FTS relevance + confidence + reinforcement, weighted by recency, success_rate, and penalties
      const baseScore = ftsScore * 0.6 + confidence * 0.4 + reinforcement;
      const relevanceScore = Math.min(
        1.0,
        baseScore * recencyFactor * successRateWeight * recentFailurePenalty * validationPenalty,
      );

      return { ...proc, relevanceScore };
    });

    // Sort by relevanceScore, then procedure_type (positive first as tiebreaker), then last validated
    scored.sort((a, b) => {
      if (Math.abs(b.relevanceScore - a.relevanceScore) > 0.001) {
        return b.relevanceScore - a.relevanceScore;
      }
      const typeA = a.procedureType === "positive" ? 1 : 0;
      const typeB = b.procedureType === "positive" ? 1 : 0;
      if (typeB !== typeA) return typeB - typeA;
      const lastValA = a.lastValidated ?? 0;
      const lastValB = b.lastValidated ?? 0;
      return lastValB - lastValA;
    });

    return scored.slice(0, limit);
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "fts-query",
      severity: "info",
      subsystem: "facts",
    });
    return [];
  }
}

/** Get negative procedures whose task_pattern might match the given description (for warnings). */
export function getNegativeProceduresMatching(
  db: DatabaseSync,
  taskDescription: string,
  limit = 5,
  scopeFilter?: ScopeFilter,
): ProcedureEntry[] {
  const all = searchProcedures(db, taskDescription, limit * 2, 0.1, scopeFilter);
  return all.filter((p) => p.procedureType === "negative").slice(0, limit);
}

/** Record a successful use of a procedure (bump success_count, last_validated). */
export function recordProcedureSuccess(db: DatabaseSync, id: string, recipeJson?: string, sessionId?: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const proc = getProcedureById(db, id);
  if (!proc) return false;

  // Check if this session has already been counted
  if (sessionId) {
    const sourceSessions = proc.sourceSessions ? proc.sourceSessions.split(",") : [];
    if (sourceSessions.includes(sessionId)) {
      return false;
    }
    sourceSessions.push(sessionId);
    const newSourceSessions = sourceSessions.join(",");

    const successCount = proc.successCount + 1;
    const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (successCount - proc.failureCount)));
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
    const successCount = proc.successCount + 1;
    const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (successCount - proc.failureCount)));
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

  // Check if this session has already been counted
  if (sessionId) {
    const sourceSessions = proc.sourceSessions ? proc.sourceSessions.split(",") : [];
    if (sourceSessions.includes(sessionId)) {
      return false;
    }
    sourceSessions.push(sessionId);
    const newSourceSessions = sourceSessions.join(",");

    const failureCount = proc.failureCount + 1;
    const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (proc.successCount - failureCount)));
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
    const failureCount = proc.failureCount + 1;
    const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (proc.successCount - failureCount)));
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
): ProcedureEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM procedures WHERE procedure_type = 'positive' AND success_count >= ? AND promoted_to_skill = 0 ORDER BY success_count DESC, last_validated DESC LIMIT ?`,
    )
    .all(validationThreshold, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => procedureRowToEntry(db, r));
}

/** Mark procedure as promoted to skill (skill_path set). */
export function markProcedurePromoted(db: DatabaseSync, id: string, skillPath: string): boolean {
  const result = db
    .prepare("UPDATE procedures SET promoted_to_skill = 1, skill_path = ?, updated_at = ? WHERE id = ?")
    .run(skillPath, Math.floor(Date.now() / 1000), id);
  return result.changes > 0;
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
