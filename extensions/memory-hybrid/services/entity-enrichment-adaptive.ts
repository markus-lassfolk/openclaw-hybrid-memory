/** Adaptive enrich-entities catch-up: budgets, summaries, and vectorless SLO repair hints. */

export const VECTORLESS_SLO_TARGET_RATIO = 0.02;

export type EntityEnrichmentStopReason = "completed" | "time_budget" | "exhausted";

export type EntityEnrichmentAdaptiveSummary = {
  enabled: true;
  durationMs: number;
  avgSecondsPerFact: number;
  processed: number;
  remainingTotal: number;
  rateLimitCount: number;
  transientFailureCount: number;
  timeoutFailureCount: number;
  llmFailureCount: number;
  startBatchSize: number;
  endBatchSize: number;
  startDelayMs: number;
  endDelayMs: number;
  startConcurrency: number;
  endConcurrency: number;
  stopReason: EntityEnrichmentStopReason;
  timeBudgetSec?: number;
  estimatedRunsRemaining: number;
  etaSecondsAtCurrentLimit?: number;
  nextRecommendedLimit: number;
  nextRecommendedTimeoutSec?: number;
};

export type VectorlessSloRepairRecommendation = {
  targetVectorlessRatio: number;
  activeFacts: number;
  vectorlessBefore: number;
  vectorlessAfter: number;
  vectorlessRatioBefore: number;
  vectorlessRatioAfter: number;
  maxVectorlessAtTarget: number;
  vectorlessToClearForSlo: number;
  embeddedThisRun: number;
  recommendedLimitNextRun: number;
  estimatedRunsToReachSlo: number;
  sloMetAfterRun: boolean;
};

export function sanitizeTimeBudgetSec(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x) || x < 1) return undefined;
  return Math.min(86_400, x);
}

export function sanitizeMaxConcurrency(n: number | undefined, adaptiveCatchUp: boolean): number {
  const x = Math.floor(Number(n ?? (adaptiveCatchUp ? 3 : 1)));
  if (!Number.isFinite(x) || x < 1) return adaptiveCatchUp ? 3 : 1;
  return Math.min(adaptiveCatchUp ? 16 : 1, x);
}

export function isLlmTimeoutLike(message: string): boolean {
  const msg = message.toLowerCase();
  return /timed out|llm request timeout|request was aborted/.test(msg);
}

export function buildEntityEnrichmentAdaptiveSummary(input: {
  startedAtMs: number;
  processed: number;
  remainingTotal: number;
  limit: number;
  mode: "bounded" | "all";
  rateLimitCount: number;
  transientFailureCount: number;
  timeoutFailureCount: number;
  llmFailureCount: number;
  startBatchSize: number;
  endBatchSize: number;
  startDelayMs: number;
  endDelayMs: number;
  startConcurrency: number;
  endConcurrency: number;
  stopReason: EntityEnrichmentStopReason;
  timeBudgetSec?: number;
}): EntityEnrichmentAdaptiveSummary {
  const durationMs = Math.max(0, Date.now() - input.startedAtMs);
  const avgSecondsPerFact = input.processed > 0 ? Number((durationMs / 1000 / input.processed).toFixed(3)) : 0;
  const estimatedRunsRemaining = input.mode === "all" ? 0 : Math.ceil(input.remainingTotal / Math.max(1, input.limit));
  const factsPerRun = Math.max(1, input.processed);
  const nextRecommendedLimit = Math.max(
    input.limit,
    Math.min(100_000, Math.ceil(input.remainingTotal / Math.max(1, estimatedRunsRemaining || 1))),
  );
  const etaSecondsAtCurrentLimit =
    input.processed > 0 && input.remainingTotal > 0
      ? Math.ceil((durationMs / 1000 / input.processed) * input.remainingTotal)
      : undefined;
  const nextRecommendedTimeoutSec =
    input.timeoutFailureCount > 0 && avgSecondsPerFact > 0
      ? Math.min(600, Math.max(60, Math.ceil(avgSecondsPerFact * 3)))
      : undefined;

  return {
    enabled: true,
    durationMs,
    avgSecondsPerFact,
    processed: input.processed,
    remainingTotal: input.remainingTotal,
    rateLimitCount: input.rateLimitCount,
    transientFailureCount: input.transientFailureCount,
    timeoutFailureCount: input.timeoutFailureCount,
    llmFailureCount: input.llmFailureCount,
    startBatchSize: input.startBatchSize,
    endBatchSize: input.endBatchSize,
    startDelayMs: input.startDelayMs,
    endDelayMs: input.endDelayMs,
    startConcurrency: input.startConcurrency,
    endConcurrency: input.endConcurrency,
    stopReason: input.stopReason,
    timeBudgetSec: input.timeBudgetSec,
    estimatedRunsRemaining,
    etaSecondsAtCurrentLimit,
    nextRecommendedLimit,
    nextRecommendedTimeoutSec,
  };
}

export function buildVectorlessSloRepairRecommendation(input: {
  activeFacts: number;
  vectorlessBefore: number;
  vectorlessAfter: number;
  embeddedThisRun: number;
  runLimit: number;
}): VectorlessSloRepairRecommendation {
  const activeFacts = Math.max(0, input.activeFacts);
  const vectorlessBefore = Math.max(0, input.vectorlessBefore);
  const vectorlessAfter = Math.max(0, input.vectorlessAfter);
  const vectorlessRatioBefore = activeFacts > 0 ? vectorlessBefore / activeFacts : 0;
  const vectorlessRatioAfter = activeFacts > 0 ? vectorlessAfter / activeFacts : 0;
  const maxVectorlessAtTarget = Math.floor(activeFacts * VECTORLESS_SLO_TARGET_RATIO);
  const vectorlessToClearForSlo = Math.max(0, vectorlessAfter - maxVectorlessAtTarget);
  const embeddedPerRun = Math.max(1, input.embeddedThisRun);
  const recommendedLimitNextRun = Math.max(input.runLimit, embeddedPerRun);
  const estimatedRunsToReachSlo = Math.ceil(vectorlessToClearForSlo / embeddedPerRun);

  return {
    targetVectorlessRatio: VECTORLESS_SLO_TARGET_RATIO,
    activeFacts,
    vectorlessBefore,
    vectorlessAfter,
    vectorlessRatioBefore: Number(vectorlessRatioBefore.toFixed(4)),
    vectorlessRatioAfter: Number(vectorlessRatioAfter.toFixed(4)),
    maxVectorlessAtTarget,
    vectorlessToClearForSlo,
    embeddedThisRun: input.embeddedThisRun,
    recommendedLimitNextRun,
    estimatedRunsToReachSlo,
    sloMetAfterRun: vectorlessRatioAfter <= VECTORLESS_SLO_TARGET_RATIO,
  };
}
