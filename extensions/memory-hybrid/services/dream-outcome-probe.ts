/**
 * Post-promote outcome probe (#2173) — scheduled observation + auto-rollback.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import type { DreamingConfig } from "../config/types/dreaming.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { pluginLogger } from "../utils/logger.js";
import { collectDreamMetricSet } from "./dream-metrics.js";
import { evaluateDreamOutcome, type DreamOutcomeReport } from "./dream-outcome.js";

export type DreamOutcomeProbeResult = {
  examined: number;
  kept: number;
  rolledBack: number;
  insufficient: number;
  reports: DreamOutcomeReport[];
};

const PRE_WINDOW_SEC = 7 * 24 * 3600;

/**
 * Probe promoted dream runs whose observation window has elapsed (or is forced).
 * Requires a real baseline captured at promote time.
 */
export function probeDreamOutcomes(
  factsDb: FactsDB,
  store: DreamCandidateStore,
  options: {
    cfg?: DreamingConfig;
    nowSec?: number;
    limit?: number;
    applyRollback?: boolean;
    /** When true, also probe runs still inside the window (tests / forced observe). */
    force?: boolean;
  } = {},
): DreamOutcomeProbeResult {
  const cfg = options.cfg ?? DEFAULT_DREAMING_CONFIG;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const applyRollback = options.applyRollback ?? cfg.autoRollback.enabled;

  const candidates = store
    .listDreamRuns(limit * 3)
    .filter((r) => r.status === "promoted")
    .filter((r) => {
      if (options.force) return true;
      if (r.metricsObserveUntil == null) return false;
      return nowSec >= r.metricsObserveUntil;
    })
    .slice(0, limit);

  const reports: DreamOutcomeReport[] = [];
  let kept = 0;
  let rolledBack = 0;
  let insufficient = 0;

  for (const run of candidates) {
    const promotedAt = run.promotedAt ?? run.createdAt;
    const after = collectDreamMetricSet(factsDb, {
      fromSec: promotedAt,
      toSec: nowSec,
      sessionIds: run.sessionIds,
    });

    const report = evaluateDreamOutcome(factsDb, store, run.id, after, {
      cfg,
      nowSec,
      applyRollback,
      // Require real observation volume — do not treat "attached session ids" as observed sessions.
      minSessions: 3,
    });
    reports.push(report);

    if (report.decision === "insufficient_data") insufficient += 1;
    else if (report.decision === "keep") kept += 1;
    else if (report.decision === "rollback") {
      if (report.rollback?.rolledBack) rolledBack += 1;
    }

    pluginLogger.info?.(`memory-hybrid: dream outcome probe ${run.id} → ${report.decision} (${report.reason})`);
  }

  return { examined: candidates.length, kept, rolledBack, insufficient, reports };
}

/** Capture pre-promote baseline metrics for a dream run (#2173). */
export function capturePromoteBaseline(factsDb: FactsDB, sessionIds: string[], promotedAtSec: number): string {
  const metrics = collectDreamMetricSet(factsDb, {
    fromSec: promotedAtSec - PRE_WINDOW_SEC,
    toSec: promotedAtSec,
    sessionIds,
  });
  return JSON.stringify(metrics);
}
