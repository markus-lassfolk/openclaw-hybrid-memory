import { describe, expect, it, vi } from "vitest";

import {
  buildEntityEnrichmentAdaptiveSummary,
  buildVectorlessSloRepairRecommendation,
  VECTORLESS_SLO_TARGET_RATIO,
} from "../services/entity-enrichment-adaptive.js";

describe("buildEntityEnrichmentAdaptiveSummary", () => {
  it("computes next-run recommendation from throughput", () => {
    const startedAtMs = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(startedAtMs + 30_000);
    const summary = buildEntityEnrichmentAdaptiveSummary({
      startedAtMs,
      processed: 10,
      remainingTotal: 90,
      limit: 25,
      mode: "bounded",
      rateLimitCount: 1,
      transientFailureCount: 2,
      timeoutFailureCount: 0,
      llmFailureCount: 1,
      startBatchSize: 20,
      endBatchSize: 25,
      startDelayMs: 150,
      endDelayMs: 100,
      startConcurrency: 2,
      endConcurrency: 3,
      stopReason: "time_budget",
      timeBudgetSec: 30,
    });

    expect(summary.avgSecondsPerFact).toBe(3);
    expect(summary.estimatedRunsRemaining).toBe(4);
    expect(summary.nextRecommendedLimit).toBeGreaterThanOrEqual(25);
    expect(summary.etaSecondsAtCurrentLimit).toBe(270);
    expect(summary.stopReason).toBe("time_budget");
    expect(summary.timeBudgetSec).toBe(30);
  });
});

describe("buildVectorlessSloRepairRecommendation", () => {
  it("estimates runs needed to reach 2% vectorless ratio", () => {
    const slo = buildVectorlessSloRepairRecommendation({
      activeFacts: 10_000,
      vectorlessBefore: 1200,
      vectorlessAfter: 1150,
      embeddedThisRun: 50,
      runLimit: 100,
    });

    expect(slo.targetVectorlessRatio).toBe(VECTORLESS_SLO_TARGET_RATIO);
    expect(slo.maxVectorlessAtTarget).toBe(200);
    expect(slo.vectorlessToClearForSlo).toBe(950);
    expect(slo.estimatedRunsToReachSlo).toBe(19);
    expect(slo.recommendedLimitNextRun).toBe(100);
    expect(slo.sloMetAfterRun).toBe(false);
  });

  it("marks sloMetAfterRun when ratio is at or below target", () => {
    const slo = buildVectorlessSloRepairRecommendation({
      activeFacts: 1000,
      vectorlessBefore: 30,
      vectorlessAfter: 18,
      embeddedThisRun: 12,
      runLimit: 25,
    });

    expect(slo.sloMetAfterRun).toBe(true);
    expect(slo.vectorlessToClearForSlo).toBe(0);
  });
});
