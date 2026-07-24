/**
 * Dream metrics collection (#2173 / #2179) — baseline + after-window signals from the facts DB.
 */

import type { DatabaseSync } from "node:sqlite";
import type { FactsDB } from "../backends/facts-db.js";
import type { DreamMetricSet } from "./dream-outcome.js";

export type DreamHygieneSnapshot = {
  openContradictions: number;
  activeFactCount: number;
};

export type DreamCostSnapshot = {
  feature: "dream";
  wallSeconds: number | null;
  tokens: number | null;
  usdProxy: number | null;
  source: "llm_cost_log" | "insufficient_data";
};

export type DreamRunMetricsSummary = DreamCostSnapshot &
  DreamHygieneSnapshot & {
    recordedAt: number;
    sessionIds: string[];
  };

function countOpenContradictions(db: DatabaseSync): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM contradictions
         WHERE resolved_at IS NULL`,
      )
      .get() as { c: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

/** Scope feedback to dream sessions when available (#2173 — avoid false global rollback). */
function sessionScopeSql(sessionIds: string[]): { clause: string; params: string[] } {
  const ids = [...new Set(sessionIds.map((s) => s.trim()).filter((s) => s.length > 0))];
  if (ids.length === 0) {
    return { clause: "", params: [] };
  }
  const placeholders = ids.map(() => "?").join(",");
  return {
    clause: ` AND (
      (scope = 'session' AND scope_target IN (${placeholders}))
      OR provenance_session IN (${placeholders})
    )`,
    params: [...ids, ...ids],
  };
}

function countFeedbackSignals(
  db: DatabaseSync,
  fromSec: number,
  toSec: number,
  sessionIds: string[],
): { corrections: number; praise: number; sessions: number } {
  const scope = sessionScopeSql(sessionIds);
  let corrections = 0;
  let praise = 0;
  let sessions = 0;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM facts
         WHERE source IN ('self-correction', 'self-correction-analysis')
           AND created_at >= ? AND created_at <= ?${scope.clause}`,
      )
      .get(fromSec, toSec, ...scope.params) as { c: number };
    corrections = Number(row?.c ?? 0);
  } catch {
    corrections = 0;
  }
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM facts
         WHERE source = 'reinforcement'
           AND created_at >= ? AND created_at <= ?${scope.clause}`,
      )
      .get(fromSec, toSec, ...scope.params) as { c: number };
    praise = Number(row?.c ?? 0);
  } catch {
    praise = 0;
  }
  try {
    // Distinct sessions that actually produced feedback in-window (#2173).
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(NULLIF(provenance_session, ''), scope_target)) AS c FROM facts
         WHERE source IN ('self-correction', 'self-correction-analysis', 'reinforcement')
           AND created_at >= ? AND created_at <= ?${scope.clause}`,
      )
      .get(fromSec, toSec, ...scope.params) as { c: number };
    sessions = Number(row?.c ?? 0);
  } catch {
    sessions = corrections + praise > 0 ? 1 : 0;
  }
  return { corrections, praise, sessions };
}

/** Derive a simple effect score from feedback balance (higher is better). */
export function deriveEffectScore(corrections: number, praise: number): number {
  const denom = Math.max(1, corrections + praise);
  const raw = (praise - corrections) / denom;
  return Math.max(-1, Math.min(1, raw));
}

function readToolEffectivenessAggregate(
  db: DatabaseSync,
  fromSec: number,
  toSec: number,
): { successRate: number; totalCalls: number } | null {
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(success_calls), 0) AS ok,
                COALESCE(SUM(total_calls), 0) AS total
         FROM tool_effectiveness
         WHERE last_updated >= ? AND last_updated <= ?`,
      )
      .get(fromSec, toSec) as { ok: number; total: number } | undefined;
    const total = Number(row?.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) return null;
    const ok = Number(row?.ok ?? 0);
    return { successRate: Math.max(0, Math.min(1, ok / total)), totalCalls: total };
  } catch {
    // Table may not exist in this DB — feedback proxy remains the primary signal.
    return null;
  }
}

export function collectDreamMetricSet(
  factsDb: FactsDB,
  input: { fromSec: number; toSec: number; sessionIds: string[] },
): DreamMetricSet {
  const db = factsDb.getRawDb();
  const { corrections, praise, sessions } = countFeedbackSignals(db, input.fromSec, input.toSec, input.sessionIds);
  const effectScore = deriveEffectScore(corrections, praise);
  const feedbackSuccess = praise + corrections > 0 ? praise / (praise + corrections) : 1;
  const retryRate = corrections;
  const tool = readToolEffectivenessAggregate(db, input.fromSec, input.toSec);

  if (tool && praise + corrections > 0) {
    // Prefer blended signal when both feedback and tool effectiveness exist (#2173).
    const successRate = 0.5 * feedbackSuccess + 0.5 * tool.successRate;
    return {
      successRate,
      retryRate,
      effectScore,
      sessionsObserved: sessions,
      signalSource: "blended",
    };
  }
  if (tool && praise + corrections === 0) {
    return {
      successRate: tool.successRate,
      retryRate,
      effectScore: tool.successRate * 2 - 1,
      sessionsObserved: Math.max(sessions, 1),
      signalSource: "tool_effectiveness",
    };
  }
  return {
    successRate: feedbackSuccess,
    retryRate,
    effectScore,
    sessionsObserved: sessions,
    signalSource: "feedback_proxy",
  };
}

export function collectHygieneSnapshot(factsDb: FactsDB): DreamHygieneSnapshot {
  const db = factsDb.getRawDb();
  return {
    openContradictions: countOpenContradictions(db),
    activeFactCount: factsDb.count(),
  };
}

export function queryDreamCost(db: DatabaseSync, fromSec: number, toSec: number): DreamCostSnapshot {
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
                COALESCE(SUM(estimated_cost_usd), 0) AS usd
         FROM llm_cost_log
         WHERE feature = 'dream' AND timestamp >= ? AND timestamp <= ?`,
      )
      .get(fromSec, toSec) as { tokens: number; usd: number } | undefined;
    if (!row) {
      return { feature: "dream", wallSeconds: null, tokens: null, usdProxy: null, source: "insufficient_data" };
    }
    return {
      feature: "dream",
      wallSeconds: Math.max(0, toSec - fromSec),
      tokens: Number(row.tokens) || 0,
      usdProxy: Number(row.usd) || 0,
      source: "llm_cost_log",
    };
  } catch {
    return { feature: "dream", wallSeconds: null, tokens: null, usdProxy: null, source: "insufficient_data" };
  }
}

export function buildRunMetricsSummary(
  factsDb: FactsDB,
  input: {
    sessionIds: string[];
    startedAt: number | null;
    endedAt: number | null;
  },
): DreamRunMetricsSummary {
  const now = Math.floor(Date.now() / 1000);
  const fromSec = input.startedAt ?? now;
  const toSec = input.endedAt ?? now;
  const cost = queryDreamCost(factsDb.getRawDb(), fromSec, toSec);
  const hygiene = collectHygieneSnapshot(factsDb);
  return {
    ...cost,
    ...hygiene,
    wallSeconds:
      input.startedAt != null && input.endedAt != null
        ? Math.max(0, input.endedAt - input.startedAt)
        : cost.wallSeconds,
    recordedAt: now,
    sessionIds: input.sessionIds,
  };
}

export const DREAM_RUN_TAG_PREFIX = "dream-run:";

export function dreamRunTag(dreamRunId: string): string {
  return `${DREAM_RUN_TAG_PREFIX}${dreamRunId}`.toLowerCase();
}
