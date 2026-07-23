/**
 * Dream ROI reporting (#2179) — cost + outcome summaries for autonomous ops.
 */

import type { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import type { DreamRunRecord } from "./dream-candidate-ops.js";
import { parseBaseline, type DreamMetricSet } from "./dream-outcome.js";

export type DreamRoiRow = {
  dreamRunId: string;
  status: DreamRunRecord["status"];
  shadow: boolean;
  createdAt: number;
  promotedAt: number | null;
  rolledBackAt: number | null;
  candidateCount: number;
  cost: {
    feature: "dream";
    /** Wall seconds if started/gated known; else null. */
    wallSeconds: number | null;
    /** Placeholder until llm_cost_log aggregation is wired. */
    tokens: number | null;
    usdProxy: number | null;
  };
  outcome: {
    baseline: DreamMetricSet | null;
    summary: "promoted" | "shadow" | "quarantined" | "rolled_back" | "failed" | "pending" | "insufficient_data";
  };
};

export type DreamRoiReport = {
  sinceSec: number;
  untilSec: number;
  runs: DreamRoiRow[];
  aggregates: {
    runCount: number;
    promoted: number;
    rolledBack: number;
    quarantined: number;
    shadowOnly: number;
    candidateToPromoteRatio: number | null;
  };
  howToRead: string;
};

function summarizeOutcome(run: DreamRunRecord): DreamRoiRow["outcome"]["summary"] {
  if (run.status === "rolled_back") return "rolled_back";
  if (run.status === "quarantined") return "quarantined";
  if (run.status === "failed") return "failed";
  if (run.status === "promoted") return "promoted";
  if (run.shadow) return "shadow";
  if (run.status === "pending" || run.status === "running" || run.status === "gated") return "pending";
  return "insufficient_data";
}

export function buildDreamRoiReport(
  store: DreamCandidateStore,
  options: { sinceSec?: number; untilSec?: number; limit?: number } = {},
): DreamRoiReport {
  const untilSec = options.untilSec ?? Math.floor(Date.now() / 1000);
  const sinceSec = options.sinceSec ?? untilSec - 30 * 24 * 3600;
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));

  const all = store.listDreamRuns(limit);
  const runsInWindow = all.filter((r) => r.createdAt >= sinceSec && r.createdAt <= untilSec);

  const rows: DreamRoiRow[] = runsInWindow.map((run) => {
    const entries = store.listCandidateEntries(run.id);
    const wallSeconds =
      run.startedAt != null && (run.gatedAt ?? run.promotedAt ?? run.failedAt) != null
        ? Math.max(0, (run.gatedAt ?? run.promotedAt ?? run.failedAt)! - run.startedAt)
        : null;
    return {
      dreamRunId: run.id,
      status: run.status,
      shadow: run.shadow,
      createdAt: run.createdAt,
      promotedAt: run.promotedAt,
      rolledBackAt: run.rolledBackAt,
      candidateCount: entries.length,
      cost: {
        feature: "dream",
        wallSeconds,
        tokens: null,
        usdProxy: null,
      },
      outcome: {
        baseline: parseBaseline(run.metricsBaselineJson),
        summary: summarizeOutcome(run),
      },
    };
  });

  const promoted = rows.filter((r) => r.status === "promoted" || r.status === "rolled_back").length;
  const rolledBack = rows.filter((r) => r.status === "rolled_back").length;
  const quarantined = rows.filter((r) => r.status === "quarantined").length;
  const shadowOnly = rows.filter((r) => r.shadow && r.status !== "promoted" && r.status !== "rolled_back").length;
  const totalCandidates = rows.reduce((n, r) => n + r.candidateCount, 0);

  return {
    sinceSec,
    untilSec,
    runs: rows,
    aggregates: {
      runCount: rows.length,
      promoted,
      rolledBack,
      quarantined,
      shadowOnly,
      candidateToPromoteRatio: totalCandidates > 0 ? promoted / totalCandidates : null,
    },
    howToRead:
      "Higher promote ratio with low rollback rate and stable/rising effectScore means Dream spend is paying off. " +
      "Shadow-only runs are safe canaries — compare would-promote volume before enabling autoPromote. " +
      "Use rollback rate + effectScore drop to tune autoRollback.regressionThreshold (#2173).",
  };
}
