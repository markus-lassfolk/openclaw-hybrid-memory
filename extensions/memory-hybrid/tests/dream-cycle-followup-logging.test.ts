import { afterEach, describe, expect, it, vi } from "vitest";

import { runVerboseFollowUp } from "../cli/commands/manage/dream-cycle-followup.js";

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
});
