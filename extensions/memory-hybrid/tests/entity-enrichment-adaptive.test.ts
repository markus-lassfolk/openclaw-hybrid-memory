import { describe, expect, it, vi } from "vitest";

import {
  buildEntityEnrichmentAdaptiveSummary,
  buildIssue1791AdaptiveTelemetry,
  buildVectorlessSloRepairRecommendation,
  errorIndicatesLlmTimeout,
  VECTORLESS_SLO_TARGET_RATIO,
} from "../services/entity-enrichment-adaptive.js";

describe("errorIndicatesLlmTimeout", () => {
  it("detects timeouts on wrapped LLMRetryError causes", () => {
    const cause = new Error("LLM request timeout after 120000ms");
    const wrapped = Object.assign(new Error("Failed after 3 attempts"), {
      name: "LLMRetryError",
      cause,
    });
    expect(errorIndicatesLlmTimeout(wrapped)).toBe(true);
  });
});

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

    const telemetry = buildIssue1791AdaptiveTelemetry(summary, 8);
    expect(telemetry.mode).toBe("adaptive-catchup");
    expect(telemetry.provider429s).toBe(1);
    expect(telemetry.timeouts).toBe(0);
    expect(telemetry.avgSecPerFact).toBe(3);
    expect(telemetry.batchSizeStart).toBe(20);
    expect(telemetry.nextRecommendedLimit).toBeGreaterThanOrEqual(25);
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
      effectiveBatchSize: 40,
    });

    expect(slo.sloScope).toBe("global");
    expect(slo.targetVectorlessRatio).toBe(VECTORLESS_SLO_TARGET_RATIO);
    expect(slo.maxVectorlessAtTarget).toBe(200);
    expect(slo.vectorlessToClearForSlo).toBe(950);
    expect(slo.estimatedRunsToReachSlo).toBe(19);
    expect(slo.recommendedLimitNextRun).toBe(100);
    expect(slo.recommendedBatchSizeNextRun).toBe(40);
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

  it("uses source-scoped counts when sloScope is source", () => {
    const slo = buildVectorlessSloRepairRecommendation({
      sloScope: "source",
      activeFacts: 200,
      vectorlessBefore: 40,
      vectorlessAfter: 10,
      embeddedThisRun: 30,
      runLimit: 50,
      scopedSource: "session:abc",
      scopedVectorlessBefore: 40,
      scopedVectorlessAfter: 10,
    });

    expect(slo.sloScope).toBe("source");
    expect(slo.vectorlessRatioAfter).toBe(0.05);
    expect(slo.sloMetAfterRun).toBe(false);
    expect(slo.scopedSource).toBe("session:abc");
  });
});
