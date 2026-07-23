/**
 * Shadow ROI validation before autoPromote (#2179 / Epic #2169).
 *
 * Fail closed: live apply is refused until enough successful shadow dream runs
 * exist in the lookback window with acceptable quarantine/failure rates.
 */

import type { DatabaseSync } from "node:sqlite";
import type { DreamCandidateStore } from "../backends/dream-candidate-store.js";
import type { DreamingShadowValidationConfig } from "../config/types/dreaming.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/types/dreaming.js";
import { buildDreamRoiReport, type DreamRoiReport } from "./dream-roi.js";

export type ShadowValidationMetrics = {
  shadowRuns: number;
  decidedRuns: number;
  wouldPromoteRuns: number;
  quarantinedRuns: number;
  failedRuns: number;
  zeroCandidateRuns: number;
  quarantineRate: number | null;
  failureRate: number | null;
  zeroCandidateRate: number | null;
};

export type ShadowValidationResult = {
  ok: boolean;
  reasons: string[];
  metrics: ShadowValidationMetrics;
  thresholds: DreamingShadowValidationConfig;
  lookbackDays: number;
};

function parseGateWouldPromote(gateReportJson: string | null | undefined): boolean {
  if (!gateReportJson) return false;
  try {
    const parsed = JSON.parse(gateReportJson) as { wouldPromote?: unknown; ok?: unknown };
    // Require explicit wouldPromote — ok alone can be true for empty/no-op gates.
    return parsed.wouldPromote === true;
  } catch {
    return false;
  }
}

export function evaluateShadowValidation(
  report: DreamRoiReport,
  opts: {
    thresholds?: DreamingShadowValidationConfig;
    /** Optional map dreamRunId → gate_report_json for wouldPromote detection. */
    gateReportsByRunId?: Map<string, string | null>;
  } = {},
): ShadowValidationResult {
  const thresholds = opts.thresholds ?? DEFAULT_DREAMING_CONFIG.autoPromote.shadowValidation;
  const lookbackDays = Math.max(1, Math.floor((report.untilSec - report.sinceSec) / 86_400) || thresholds.lookbackDays);

  const shadowRuns = report.runs.filter((r) => r.shadow);
  const decided = shadowRuns.filter((r) =>
    ["gated", "quarantined", "failed", "promoted", "rolled_back"].includes(r.status),
  );
  let wouldPromoteRuns = 0;
  let zeroCandidateRuns = 0;
  for (const row of shadowRuns) {
    if (row.candidateCount === 0) zeroCandidateRuns++;
    const gateJson = opts.gateReportsByRunId?.get(row.dreamRunId);
    // Count only explicit wouldPromote with at least one candidate (avoid gated+empty inflation).
    if (row.candidateCount > 0 && parseGateWouldPromote(gateJson ?? null)) {
      wouldPromoteRuns++;
    }
  }

  const quarantinedRuns = shadowRuns.filter((r) => r.status === "quarantined").length;
  const failedRuns = shadowRuns.filter((r) => r.status === "failed").length;
  const decidedCount = Math.max(1, decided.length);
  const quarantineRate = decided.length > 0 ? quarantinedRuns / decidedCount : null;
  const failureRate = decided.length > 0 ? failedRuns / decidedCount : null;
  const zeroCandidateRate = shadowRuns.length > 0 ? zeroCandidateRuns / shadowRuns.length : null;

  const metrics: ShadowValidationMetrics = {
    shadowRuns: shadowRuns.length,
    decidedRuns: decided.length,
    wouldPromoteRuns,
    quarantinedRuns,
    failedRuns,
    zeroCandidateRuns,
    quarantineRate,
    failureRate,
    zeroCandidateRate,
  };

  const reasons: string[] = [];
  if (!thresholds.enabled) {
    return { ok: true, reasons: ["shadow_validation_disabled"], metrics, thresholds, lookbackDays };
  }

  if (shadowRuns.length < thresholds.minShadowRuns) {
    reasons.push(`min_shadow_runs_${shadowRuns.length}_lt_${thresholds.minShadowRuns}`);
  }
  if (wouldPromoteRuns < thresholds.minWouldPromoteRuns) {
    reasons.push(`min_would_promote_${wouldPromoteRuns}_lt_${thresholds.minWouldPromoteRuns}`);
  }
  if (quarantineRate != null && quarantineRate > thresholds.maxQuarantineRate) {
    reasons.push(`quarantine_rate_${quarantineRate.toFixed(2)}_gt_${thresholds.maxQuarantineRate}`);
  }
  if (failureRate != null && failureRate > thresholds.maxFailureRate) {
    reasons.push(`failure_rate_${failureRate.toFixed(2)}_gt_${thresholds.maxFailureRate}`);
  }
  if (zeroCandidateRate != null && zeroCandidateRate > thresholds.maxZeroCandidateRate) {
    reasons.push(`zero_candidate_rate_${zeroCandidateRate.toFixed(2)}_gt_${thresholds.maxZeroCandidateRate}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    metrics,
    thresholds,
    lookbackDays,
  };
}

/** Evaluate shadow validation from the candidate store + ROI window. */
export function evaluateShadowValidationFromStore(
  store: DreamCandidateStore,
  opts: {
    thresholds?: DreamingShadowValidationConfig;
    lookbackDays?: number;
    db?: DatabaseSync | null;
  } = {},
): ShadowValidationResult {
  const thresholds = opts.thresholds ?? DEFAULT_DREAMING_CONFIG.autoPromote.shadowValidation;
  const lookbackDays = opts.lookbackDays ?? thresholds.lookbackDays;
  const untilSec = Math.floor(Date.now() / 1000);
  const sinceSec = untilSec - lookbackDays * 86_400;
  const report = buildDreamRoiReport(store, { sinceSec, untilSec, db: opts.db ?? null });
  const gateReportsByRunId = new Map<string, string | null>();
  for (const row of report.runs) {
    const run = store.getDreamRun(row.dreamRunId);
    gateReportsByRunId.set(row.dreamRunId, run?.gateReportJson ?? null);
  }
  return evaluateShadowValidation(report, { thresholds, gateReportsByRunId });
}
