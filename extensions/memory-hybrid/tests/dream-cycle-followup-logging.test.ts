import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assessContinuousVerificationResult,
  applyDreamCyclePipelineExitCode,
  dreamCycleFollowUpSkipReason,
  extractImplicitSemanticOutcome,
  formatContinuousVerificationAssessmentLine,
  formatExtractImplicitFeedbackProgress,
  isGracefulExtractImplicitPartial,
  recordDreamCycleFollowUpFailure,
  shouldSkipDreamCycleFollowUps,
  runVerboseFollowUp,
} from "../cli/commands/manage/dream-cycle-followup.js";

describe("dream-cycle follow-up heartbeat logging", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("includes progress counters in heartbeat lines when provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    let resolveWork: (() => void) | undefined;
    const workDone = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });

    let progress = "stage=scan-sessions; sessions=0/2; signals=0 (0+/0-)";
    const run = runVerboseFollowUp(
      "extract implicit feedback",
      true,
      async () => {
        await workDone;
      },
      {
        heartbeatIntervalMs: 1_000,
        progressSupplier: () => progress,
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(logs.some((l) => l.includes("still running after 1s") && l.includes("sessions="))).toBe(true);

    progress = "stage=scan-sessions; sessions=1/2; signals=7 (2+/5-)";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(logs.some((l) => l.includes("still running after 2s") && l.includes("sessions=1/2"))).toBe(true);

    resolveWork?.();
    await run;
  });

  it("prefixes follow-up stage counters in verbose logs", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    await runVerboseFollowUp("extract implicit feedback", true, async () => undefined, {
      stageIndex: 2,
      stageTotal: 6,
    });

    expect(logs.some((l) => l.includes("stage 2/6 extract implicit feedback — start"))).toBe(true);
    expect(logs.some((l) => l.includes("stage 2/6 extract implicit feedback — complete in"))).toBe(true);
  });

  it("formats partial extract-implicit progress with deferred backlog details", () => {
    expect(
      formatExtractImplicitFeedbackProgress({
        stage: "scan-sessions",
        sessionsDiscovered: 4,
        sessionsVisited: 2,
        sessionsProcessed: 2,
        sessionsReadErrors: 0,
        sessionsTooShort: 0,
        sessionsDeferred: 2,
        currentSession: undefined,
        signalsExtracted: 5,
        positiveCount: 2,
        negativeCount: 3,
        trajectoriesBuilt: 1,
        cleanupCollapsed: 0,
        cleanupScanned: 0,
        cleanupBatches: 0,
        backlogSessionsEstimate: 2,
        backlogSignalsEstimate: 7,
        backlogTrajectoriesEstimate: 3,
        partial: true,
        partialReason: "maxSignals",
      }),
    ).toBe(
      "stage=scan-sessions; sessions=2/4; signals=5 (2+/3-); traj=1; partial=maxSignals; deferred=2; backlog≈7s/3t",
    );
  });

  it("maps graceful extract-implicit budget caps to monitoring semantics", () => {
    expect(isGracefulExtractImplicitPartial("maxWallClock")).toBe(true);
    expect(extractImplicitSemanticOutcome({ partial: true, partialReason: "maxWallClock" })).toBe("monitoring");
    expect(extractImplicitSemanticOutcome({ partial: true, partialReason: "reinforcementError" })).toBe("partial");
  });

  it("treats all-uncertain verification results as healthy when the cycle completed", () => {
    const assessment = assessContinuousVerificationResult({
      checked: 12,
      confirmed: 0,
      stale: 0,
      uncertain: 12,
      errors: 0,
      errorSummaries: [],
    });

    expect(assessment.status).toBe("healthy");
    expect(assessment.reason).toBe("healthy");
    expect(assessment.shouldFailPipeline).toBe(false);
  });

  it("treats LLM-downgraded uncertain outcomes as healthy when every fact got a verdict", () => {
    const assessment = assessContinuousVerificationResult({
      checked: 5,
      confirmed: 0,
      stale: 0,
      uncertain: 5,
      errors: 0,
      errorSummaries: [
        "fact=abc12345…: provider timeout",
        "fact=def67890…: provider timeout",
      ],
    });

    expect(assessment.status).toBe("healthy");
    expect(assessment.reason).toBe("healthy");
    expect(assessment.shouldFailPipeline).toBe(false);
  });

  it("treats infrastructure verification errors as degraded pipeline failures", () => {
    const assessment = assessContinuousVerificationResult({
      checked: 0,
      confirmed: 0,
      stale: 0,
      uncertain: 0,
      errors: 1,
      errorSummaries: ["listDueForReverification: db locked"],
    });

    expect(assessment.status).toBe("degraded");
    expect(assessment.reason).toBe("errors_present");
    expect(assessment.shouldFailPipeline).toBe(true);
    expect(assessment.summary).toContain("infrastructure error prevented verification");
  });

  it("treats per-fact failures without verdicts as degraded pipeline failures", () => {
    const assessment = assessContinuousVerificationResult({
      checked: 5,
      confirmed: 1,
      stale: 0,
      uncertain: 3,
      errors: 1,
      errorSummaries: ["fact=abc12345…: unexpected store failure"],
    });

    expect(assessment.status).toBe("degraded");
    expect(assessment.reason).toBe("errors_present");
    expect(assessment.shouldFailPipeline).toBe(true);
    expect(assessment.summary).toContain("failed without a verdict");
  });

  it("emits machine-readable verification status details for infrastructure failures", () => {
    const result = {
      checked: 0,
      confirmed: 0,
      stale: 0,
      uncertain: 0,
      errors: 1,
      errorSummaries: ["listDueForReverification: db locked"],
    };
    const assessment = assessContinuousVerificationResult(result);
    expect(formatContinuousVerificationAssessmentLine(result, assessment)).toBe(
      "status=degraded reason=errors_present checked=0 confirmed=0 stale=0 uncertain=0 errors=1",
    );
  });

  it("records follow-up failures and sets exit code", () => {
    const failures: Array<{ phase: string; error: string }> = [];
    const previousExitCode = process.exitCode;
    recordDreamCycleFollowUpFailure(failures, "extract implicit feedback", new Error("boom"));
    expect(failures).toEqual([{ phase: "extract implicit feedback", error: "boom" }]);
    expect(process.exitCode).toBe(2);
    process.exitCode = previousExitCode;
  });

  it("applyDreamCyclePipelineExitCode marks degraded runs", () => {
    const previousExitCode = process.exitCode;
    applyDreamCyclePipelineExitCode({
      coreSuccess: false,
      coreFailedStages: ["reflection (patterns)"],
      followUpFailures: [],
    });
    expect(process.exitCode).toBe(2);
    process.exitCode = previousExitCode;
  });

  it("skips follow-ups when WAL pre-flush failed in core cycle", () => {
    expect(
      shouldSkipDreamCycleFollowUps({
        skipped: false,
        failedStages: ["wal pre-flush", "episodic consolidation"],
      }),
    ).toBe(true);
    expect(
      dreamCycleFollowUpSkipReason({
        skipped: false,
        failedStages: ["wal pre-flush"],
      }),
    ).toContain("WAL pre-flush failed");
  });

  it("does not skip follow-ups when core succeeded", () => {
    expect(
      shouldSkipDreamCycleFollowUps({
        skipped: false,
        failedStages: [],
      }),
    ).toBe(false);
    expect(dreamCycleFollowUpSkipReason({ skipped: false, failedStages: [] })).toBeNull();
  });
});
