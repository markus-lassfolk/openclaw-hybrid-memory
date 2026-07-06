import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getEnv } from "../utils/env-manager.js";
import { nowIso } from "../utils/dates.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import type { ResolveContradictionsAutoResult } from "../backends/facts-db/contradictions.js";

export const DEFAULT_AMBIGUOUS_BACKLOG_DEGRADED_THRESHOLD = 200;
export const DEFAULT_DEGRADED_CONSECUTIVE_THRESHOLD = 1;
/** Matches nightly cron `resolve-contradictions --degraded-consecutive-threshold 3`. */
export const ORCHESTRATOR_CONTRADICTION_DEGRADED_CONSECUTIVE_THRESHOLD = 3;

export interface ContradictionProgressMetrics {
  autoResolved: number;
  ambiguous: number;
  totalConsidered: number;
}

export interface ContradictionProgressEvaluation {
  noProgress: boolean;
  degradedThresholdEnabled: boolean;
  degradedAmbiguousThreshold: number;
  degradedConsecutiveThreshold: number;
  consecutiveNoProgressRuns: number;
  degraded: boolean;
  exitCode: number;
  exitReason: string;
  resolutionRate: number;
}

export interface ContradictionProgressJsonSummary extends ContradictionProgressEvaluation {
  mode: "default" | "auto";
  autoResolved: number;
  ambiguous: number;
  totalConsidered: number;
  suggestions: {
    details: string;
    projectStateLwwDryRun: string;
    autoApply?: string;
    exportReview?: string;
  };
}

interface PersistedNoProgressState {
  consecutiveNoProgressRuns: number;
  lastAmbiguous: number;
  lastAutoResolved: number;
  updatedAt: string;
}

function resolveStatePath(openclawHome?: string): string {
  const root = openclawHome ?? getEnv("OPENCLAW_HOME") ?? join(homedir(), ".openclaw");
  return join(root, "cron", "guard", "resolve-contradictions-no-progress.json");
}

export function readConsecutiveNoProgressRuns(openclawHome?: string): number {
  const statePath = resolveStatePath(openclawHome);
  if (!existsSync(statePath)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<PersistedNoProgressState>;
    return typeof parsed.consecutiveNoProgressRuns === "number" && parsed.consecutiveNoProgressRuns >= 0
      ? parsed.consecutiveNoProgressRuns
      : 0;
  } catch {
    return 0;
  }
}

export function persistConsecutiveNoProgressState(
  metrics: ContradictionProgressMetrics,
  evaluation: Pick<ContradictionProgressEvaluation, "consecutiveNoProgressRuns">,
  openclawHome?: string,
): void {
  const statePath = resolveStatePath(openclawHome);
  mkdirSync(dirname(statePath), { recursive: true });
  atomicWriteFile(
    statePath,
    `${JSON.stringify(
      {
        consecutiveNoProgressRuns: evaluation.consecutiveNoProgressRuns,
        lastAmbiguous: metrics.ambiguous,
        lastAutoResolved: metrics.autoResolved,
        updatedAt: nowIso(),
      } satisfies PersistedNoProgressState,
      null,
      2,
    )}\n`,
  );
}

export function evaluateContradictionProgress(
  metrics: ContradictionProgressMetrics,
  opts: {
    degradedAmbiguousThreshold: number;
    degradedConsecutiveThreshold: number;
    previousConsecutiveNoProgressRuns?: number;
  },
): ContradictionProgressEvaluation {
  const { degradedAmbiguousThreshold, degradedConsecutiveThreshold } = opts;
  const previousConsecutiveNoProgressRuns = opts.previousConsecutiveNoProgressRuns ?? 0;
  const totalConsidered = metrics.totalConsidered;
  const noProgress = totalConsidered > 0 && metrics.autoResolved === 0;
  const degradedThresholdEnabled = degradedAmbiguousThreshold > 0;
  const thresholdExceeded = degradedThresholdEnabled && metrics.ambiguous >= degradedAmbiguousThreshold;
  const consecutiveNoProgressRuns = noProgress && thresholdExceeded ? previousConsecutiveNoProgressRuns + 1 : 0;
  const consecutiveRequired = degradedConsecutiveThreshold > 0 ? degradedConsecutiveThreshold : 1;
  const degraded = thresholdExceeded && noProgress && consecutiveNoProgressRuns >= consecutiveRequired;
  const exitCode = degraded ? 2 : 0;
  const exitReason = degraded
    ? "ambiguous_backlog_no_progress"
    : noProgress && thresholdExceeded
      ? "ambiguous_backlog_monitoring"
      : "success";

  return {
    noProgress,
    degradedThresholdEnabled,
    degradedAmbiguousThreshold,
    degradedConsecutiveThreshold: consecutiveRequired,
    consecutiveNoProgressRuns,
    degraded,
    exitCode,
    exitReason,
    resolutionRate: totalConsidered === 0 ? 1 : metrics.autoResolved / totalConsidered,
  };
}

export function formatContradictionProgressSummaryLine(
  mode: "default" | "auto",
  metrics: ContradictionProgressMetrics,
  evaluation: ContradictionProgressEvaluation,
): string {
  const parts = [
    `resolve-contradictions summary mode=${mode}`,
    `auto_resolved=${metrics.autoResolved}`,
    `ambiguous=${metrics.ambiguous}`,
    `no_progress=${evaluation.noProgress ? 1 : 0}`,
    `degraded=${evaluation.degraded ? 1 : 0}`,
    `threshold_enabled=${evaluation.degradedThresholdEnabled ? 1 : 0}`,
    `threshold=${evaluation.degradedAmbiguousThreshold}`,
    `consecutive=${evaluation.consecutiveNoProgressRuns}`,
    `consecutive_threshold=${evaluation.degradedConsecutiveThreshold}`,
  ];
  if (
    evaluation.noProgress &&
    evaluation.degradedThresholdEnabled &&
    metrics.ambiguous >= evaluation.degradedAmbiguousThreshold
  ) {
    parts.push("backlog_alert=1");
    parts.push("triage_cmd=openclaw hybrid-mem resolve-contradictions --details");
    if (evaluation.consecutiveNoProgressRuns >= evaluation.degradedConsecutiveThreshold) {
      parts.push("operator_action=manual_triage_required");
    }
  }
  return parts.join(" ");
}

export function buildContradictionProgressJsonSummary(
  mode: "default" | "auto",
  metrics: ContradictionProgressMetrics,
  evaluation: ContradictionProgressEvaluation,
  extra?: Partial<Pick<ContradictionProgressJsonSummary, "suggestions">>,
): ContradictionProgressJsonSummary {
  const suggestions = extra?.suggestions ?? {
    details: "openclaw hybrid-mem resolve-contradictions --details",
    projectStateLwwDryRun: "openclaw hybrid-mem resolve-contradictions --project-state-lww --dry-run",
  };
  return {
    mode,
    autoResolved: metrics.autoResolved,
    ambiguous: metrics.ambiguous,
    totalConsidered: metrics.totalConsidered,
    ...evaluation,
    suggestions,
  };
}

/** Run autonomous contradiction resolution and evaluate degraded backlog for maintenance orchestrator/cron. */
export async function runContradictionMaintenanceAutoStep(params: {
  runAuto: () => Promise<ResolveContradictionsAutoResult>;
  openclawHome?: string;
  degradedAmbiguousThreshold?: number;
  degradedConsecutiveThreshold?: number;
}): Promise<{
  summary: string;
  evaluation: ContradictionProgressEvaluation;
  metrics: ContradictionProgressMetrics;
}> {
  const res = await params.runAuto();
  const autoResolvedCount = res.deterministic + res.llm + res.merged;
  const metrics: ContradictionProgressMetrics = {
    autoResolved: autoResolvedCount,
    ambiguous: res.manualReview,
    totalConsidered: res.total,
  };
  const previousConsecutive = readConsecutiveNoProgressRuns(params.openclawHome);
  const evaluation = evaluateContradictionProgress(metrics, {
    degradedAmbiguousThreshold: params.degradedAmbiguousThreshold ?? DEFAULT_AMBIGUOUS_BACKLOG_DEGRADED_THRESHOLD,
    degradedConsecutiveThreshold:
      params.degradedConsecutiveThreshold ?? ORCHESTRATOR_CONTRADICTION_DEGRADED_CONSECUTIVE_THRESHOLD,
    previousConsecutiveNoProgressRuns: previousConsecutive,
  });
  persistConsecutiveNoProgressState(metrics, evaluation, params.openclawHome);
  const semantic = evaluation.degraded ? "monitoring" : "success";
  const summary = `${formatContradictionProgressSummaryLine("auto", metrics, evaluation)} semantic=${semantic}`;
  return { summary, evaluation, metrics };
}
