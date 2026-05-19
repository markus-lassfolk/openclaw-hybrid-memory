/**
 * Procedure search.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { capturePluginError } from "../../../services/error-reporter.js";
import type { ProcedureEntry, ScopeFilter } from "../../../types/memory.js";
import { recordEpisode } from "../episodes.js";
import { sanitizeFts5QueryForFacts } from "../fts-text.js";
import { scopeFilterClausePositional } from "../scope-sql.js";

import { procedureRowToEntry } from "./crud.js";

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
