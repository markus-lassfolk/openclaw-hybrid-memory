/**
 * Dream ROI reporting (#2179) — cost + outcome summaries for autonomous ops.
 */

import type { DatabaseSync } from "node:sqlite";
import type { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import type { DreamRunRecord } from "./dream-candidate-ops.js";
import { parseBaseline, type DreamMetricSet } from "./dream-outcome.js";
import type { DreamRunMetricsSummary } from "./dream-metrics.js";

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
    wallSeconds: number | null;
    tokens: number | null;
    usdProxy: number | null;
    source: "llm_cost_log" | "insufficient_data";
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
    dreamTokens: number | null;
    dreamUsdProxy: number | null;
  };
  howToRead: string;
};

function parseRunSummary(json: string | null | undefined): DreamRunMetricsSummary | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as DreamRunMetricsSummary;
  } catch {
    return null;
  }
}

function summarizeOutcome(run: DreamRunRecord): DreamRoiRow["outcome"]["summary"] {
  if (run.status === "rolled_back") return "rolled_back";
  if (run.status === "quarantined") return "quarantined";
  if (run.status === "failed") return "failed";
  if (run.status === "promoted") return "promoted";
  if (run.shadow) return "shadow";
  if (run.status === "pending" || run.status === "running" || run.status === "gated") return "pending";
  return "insufficient_data";
}

function queryDreamCost(
  db: DatabaseSync | null | undefined,
  sinceSec: number,
  untilSec: number,
): { tokens: number; usdProxy: number } | null {
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
                COALESCE(SUM(estimated_cost_usd), 0) AS usd
         FROM llm_cost_log
         WHERE feature = 'dream' AND timestamp >= ? AND timestamp <= ?`,
      )
      .get(sinceSec, untilSec) as { tokens: number; usd: number } | undefined;
    if (!row) return null;
    return { tokens: Number(row.tokens) || 0, usdProxy: Number(row.usd) || 0 };
  } catch {
    return null;
  }
}

export function buildDreamRoiReport(
  store: DreamCandidateStore,
  options: {
    sinceSec?: number;
    untilSec?: number;
    limit?: number;
    db?: DatabaseSync | null;
  } = {},
): DreamRoiReport {
  const untilSec = options.untilSec ?? Math.floor(Date.now() / 1000);
  const sinceSec = options.sinceSec ?? untilSec - 30 * 24 * 3600;
  // Prefer a high ceiling so lookbackDays is honored; window is applied in SQL.
  const limit = Math.max(1, Math.min(10_000, options.limit ?? 5000));

  const all = store.listDreamRuns(limit, { sinceSec, untilSec });
  const runsInWindow = all;
  const costAgg = queryDreamCost(options.db, sinceSec, untilSec);

  const rows: DreamRoiRow[] = runsInWindow.map((run) => {
    const entries = store.listCandidateEntries(run.id);
    const perRun = parseRunSummary(run.metricsSummaryJson);
    const wallSeconds =
      perRun?.wallSeconds ??
      (run.startedAt != null && (run.gatedAt ?? run.promotedAt ?? run.failedAt) != null
        ? Math.max(0, (run.gatedAt ?? run.promotedAt ?? run.failedAt)! - run.startedAt)
        : null);
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
        tokens: perRun?.tokens ?? null,
        usdProxy: perRun?.usdProxy ?? null,
        source: perRun?.source ?? (costAgg ? "llm_cost_log" : "insufficient_data"),
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
      dreamTokens: costAgg?.tokens ?? null,
      dreamUsdProxy: costAgg?.usdProxy ?? null,
    },
    howToRead:
      "Higher promote ratio with low rollback rate and stable/rising effectScore means Dream spend is paying off. " +
      "Shadow-only runs are safe canaries — compare would-promote volume before enabling autoPromote. " +
      "Use rollback rate + effectScore drop to tune autoRollback.regressionThreshold (#2173). " +
      "Cost rows use llm_cost_log feature=dream when present; otherwise insufficient_data.",
  };
}
