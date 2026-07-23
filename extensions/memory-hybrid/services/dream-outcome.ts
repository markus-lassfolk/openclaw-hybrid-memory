/**
 * Dream outcome observation + auto-rollback (#2173).
 *
 * Machine "deny": if post-promote metrics regress past threshold within the window,
 * apply reverse plan via rollbackDreamRun.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import type { DreamingConfig } from "../config/types/dreaming.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import type { RollbackResult } from "./dream-candidate-ops.js";
import { rollbackDreamRun } from "./dream-rollback.js";

export type DreamMetricSet = {
  /** Aggregate task/tool success rate 0..1. */
  successRate: number;
  /** Mean retries per task. */
  retryRate: number;
  /** Optional effect score (higher is better). */
  effectScore: number;
  sessionsObserved: number;
};

export type DreamOutcomeDecision = "keep" | "rollback" | "insufficient_data";

export type DreamOutcomeReport = {
  dreamRunId: string;
  window: { fromSec: number; toSec: number; sessions: number };
  baseline: DreamMetricSet | null;
  after: DreamMetricSet;
  decision: DreamOutcomeDecision;
  reason: string;
  rollback?: RollbackResult;
};

export function parseBaseline(json: string | null | undefined): DreamMetricSet | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<DreamMetricSet>;
    if (typeof parsed.effectScore !== "number") return null;
    return {
      successRate: typeof parsed.successRate === "number" ? parsed.successRate : 0,
      retryRate: typeof parsed.retryRate === "number" ? parsed.retryRate : 0,
      effectScore: parsed.effectScore,
      sessionsObserved: typeof parsed.sessionsObserved === "number" ? parsed.sessionsObserved : 0,
    };
  } catch {
    return null;
  }
}

export function captureDreamBaseline(metrics: DreamMetricSet): string {
  return JSON.stringify(metrics);
}

/**
 * Compare after-window metrics to baseline and optionally auto-rollback.
 */
export function evaluateDreamOutcome(
  factsDb: FactsDB,
  store: DreamCandidateStore,
  dreamRunId: string,
  after: DreamMetricSet,
  options: {
    cfg?: DreamingConfig;
    nowSec?: number;
    /** Minimum sessions in the after window before deciding. */
    minSessions?: number;
    applyRollback?: boolean;
  } = {},
): DreamOutcomeReport {
  const cfg = options.cfg ?? DEFAULT_DREAMING_CONFIG;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const minSessions = options.minSessions ?? 3;
  const run = store.getDreamRun(dreamRunId);

  const finish = (report: DreamOutcomeReport): DreamOutcomeReport => {
    if (run) persistOutcomeDecision(store, dreamRunId, report);
    return report;
  };

  const emptyAfter = after;
  if (!run) {
    return {
      dreamRunId,
      window: { fromSec: nowSec, toSec: nowSec, sessions: after.sessionsObserved },
      baseline: null,
      after: emptyAfter,
      decision: "insufficient_data",
      reason: "dream_run_not_found",
    };
  }

  const baseline = parseBaseline(run.metricsBaselineJson);
  const fromSec = run.promotedAt ?? run.createdAt;
  const toSec = run.metricsObserveUntil ?? fromSec + cfg.autoRollback.observeWindowHours * 3600;

  if (after.sessionsObserved < minSessions) {
    return finish({
      dreamRunId,
      window: { fromSec, toSec, sessions: after.sessionsObserved },
      baseline,
      after,
      decision: "insufficient_data",
      reason: "insufficient_sessions",
    });
  }

  if (!baseline) {
    return finish({
      dreamRunId,
      window: { fromSec, toSec, sessions: after.sessionsObserved },
      baseline: null,
      after,
      decision: "insufficient_data",
      reason: "missing_baseline",
    });
  }

  const drop = baseline.effectScore - after.effectScore;
  const shouldRollback = drop >= cfg.autoRollback.regressionThreshold;

  if (!shouldRollback) {
    return finish({
      dreamRunId,
      window: { fromSec, toSec, sessions: after.sessionsObserved },
      baseline,
      after,
      decision: "keep",
      reason: `effect_score_drop=${drop.toFixed(3)}_below_threshold`,
    });
  }

  if (!cfg.autoRollback.enabled || options.applyRollback === false) {
    return finish({
      dreamRunId,
      window: { fromSec, toSec, sessions: after.sessionsObserved },
      baseline,
      after,
      decision: "rollback",
      reason: `would_rollback_effect_drop=${drop.toFixed(3)}`,
    });
  }

  if (nowSec < toSec && options.applyRollback !== true) {
    // Still inside window unless caller forces apply.
    return finish({
      dreamRunId,
      window: { fromSec, toSec, sessions: after.sessionsObserved },
      baseline,
      after,
      decision: "rollback",
      reason: `regression_detected_waiting_window_or_force`,
    });
  }

  const rollback = rollbackDreamRun(factsDb, store, dreamRunId, {
    reason: `auto_rollback_effect_drop=${drop.toFixed(3)}`,
  });

  return finish({
    dreamRunId,
    window: { fromSec, toSec, sessions: after.sessionsObserved },
    baseline,
    after,
    decision: "rollback",
    reason: `auto_rollback_effect_drop=${drop.toFixed(3)}`,
    rollback,
  });
}

/** Persist keep/rollback/insufficient decisions on the dream_run metrics summary (#2173 audit). */
function persistOutcomeDecision(
  store: DreamCandidateStore,
  dreamRunId: string,
  report: DreamOutcomeReport,
): void {
  try {
    const run = store.getDreamRun(dreamRunId);
    let base: Record<string, unknown> = {};
    if (run?.metricsSummaryJson) {
      try {
        base = JSON.parse(run.metricsSummaryJson) as Record<string, unknown>;
      } catch {
        base = {};
      }
    }
    store.setDreamRunMetrics(dreamRunId, {
      metricsSummaryJson: JSON.stringify({
        ...base,
        outcome: {
          decision: report.decision,
          reason: report.reason,
          at: Math.floor(Date.now() / 1000),
          window: report.window,
          baseline: report.baseline,
          after: report.after,
        },
      }),
    });
  } catch {
    // Best-effort audit — never fail the outcome path on journal write.
  }
}
