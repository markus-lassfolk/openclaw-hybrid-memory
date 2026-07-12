import { describe, expect, it, vi } from "vitest";

import {
  buildEntityEnrichmentAdaptiveSummary,
  buildIssue1791AdaptiveTelemetry,
  buildVectorlessSloRepairRecommendation,
  entityEnrichmentSemanticStatus,
  errorIndicatesLlmTimeout,
  isEntityEnrichmentHardFailure,
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

  it("estimates runs from the recommended limit, not embeddedPerRun's floor of 1, on a dry run (#2093)", () => {
    // A dry run never embeds anything, so embeddedThisRun is 0. The old formula floored
    // embeddedPerRun to 1 and divided by it, producing "clear 2502 more, ~2502 run(s) at limit
    // 100" — internally contradictory (2502 runs at limit 100 implies 1 fact/run).
    const slo = buildVectorlessSloRepairRecommendation({
      activeFacts: 30_000,
      vectorlessBefore: 3101,
      vectorlessAfter: 3101,
      embeddedThisRun: 0,
      runLimit: 100,
    });

    expect(slo.vectorlessToClearForSlo).toBe(2501);
    expect(slo.recommendedLimitNextRun).toBe(100);
    // ceil(2501 / 100) — consistent with recommendedLimitNextRun, not ceil(2501 / 1).
    expect(slo.estimatedRunsToReachSlo).toBe(26);
  });

  it("still estimates from actual throughput when embeddedThisRun is 0 but runLimit is 0 too", () => {
    const slo = buildVectorlessSloRepairRecommendation({
      activeFacts: 100,
      vectorlessBefore: 50,
      vectorlessAfter: 50,
      embeddedThisRun: 0,
      runLimit: 0,
    });

    // recommendedLimitNextRun floors to embeddedPerRun's floor of 1 when runLimit is also 0;
    // the estimate must not divide by zero.
    expect(slo.recommendedLimitNextRun).toBe(1);
    expect(slo.estimatedRunsToReachSlo).toBeGreaterThan(0);
    expect(Number.isFinite(slo.estimatedRunsToReachSlo)).toBe(true);
  });
});

describe("isEntityEnrichmentHardFailure (#2009)", () => {
  it("does not fail healthy bounded catch-up with backlog remaining", () => {
    expect(
      isEntityEnrichmentHardFailure({
        processed: 200,
        llmFailures: 0,
        stopReason: "exhausted",
      }),
    ).toBe(false);
    expect(
      entityEnrichmentSemanticStatus({
        processed: 200,
        llmFailures: 0,
        stopReason: "exhausted",
      }),
    ).toBe("success");
  });

  it("fails on llmFailures even when stopReason is completed", () => {
    expect(isEntityEnrichmentHardFailure({ processed: 20, llmFailures: 2, stopReason: "completed" })).toBe(true);
  });

  it("fails on budget stop with zero processed facts", () => {
    expect(isEntityEnrichmentHardFailure({ processed: 0, llmFailures: 0, stopReason: "time_budget" })).toBe(true);
  });

  it("does not fail time_budget stop when some facts were processed", () => {
    expect(isEntityEnrichmentHardFailure({ processed: 25, llmFailures: 0, stopReason: "time_budget" })).toBe(false);
  });

  it("does not fail budget stop when processed metric is absent from log", () => {
    expect(isEntityEnrichmentHardFailure({ llmFailures: 0, stopReason: "exhausted" })).toBe(false);
    expect(isEntityEnrichmentHardFailure({ llmFailures: 0, stopReason: "time_budget" })).toBe(false);
  });

  it("tolerates a low llmFailures rate on a budget-limited stop with real progress (#2043)", () => {
    expect(isEntityEnrichmentHardFailure({ processed: 90, llmFailures: 2, stopReason: "time_budget" })).toBe(false);
    expect(entityEnrichmentSemanticStatus({ processed: 90, llmFailures: 2, stopReason: "time_budget" })).toBe(
      "monitoring",
    );
  });

  it("still fails a budget-limited stop when the failure rate is high", () => {
    expect(isEntityEnrichmentHardFailure({ processed: 10, llmFailures: 5, stopReason: "time_budget" })).toBe(true);
  });

  it("reports monitoring (not success) for a clean budget-limited stop with remaining work", () => {
    expect(entityEnrichmentSemanticStatus({ processed: 25, llmFailures: 0, stopReason: "time_budget" })).toBe(
      "monitoring",
    );
  });
});
