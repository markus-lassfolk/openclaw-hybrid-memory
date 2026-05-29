import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assessContinuousVerificationResult,
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

  it("treats all-uncertain verification results as degraded", () => {
    const assessment = assessContinuousVerificationResult({
      checked: 12,
      confirmed: 0,
      stale: 0,
      uncertain: 12,
      errors: 0,
      errorSummaries: [],
    });

    expect(assessment.status).toBe("degraded");
    expect(assessment.shouldFailPipeline).toBe(true);
    expect(assessment.summary).toContain("all 12 verification check(s) were uncertain");
  });

  it("treats verification errors as degraded even when outcomes are uncertain", () => {
    const assessment = assessContinuousVerificationResult({
      checked: 5,
      confirmed: 0,
      stale: 0,
      uncertain: 5,
      errors: 5,
      errorSummaries: [
        "fact=abc12345…: provider timeout",
        "fact=def67890…: provider timeout",
        "fact=ghi54321…: provider timeout",
        "fact=jkl98765…: provider timeout",
        "fact=mno24680…: provider timeout",
      ],
    });

    expect(assessment.status).toBe("degraded");
    expect(assessment.shouldFailPipeline).toBe(true);
    expect(assessment.summary).toContain("5/5 verification check(s) errored");
  });
});
