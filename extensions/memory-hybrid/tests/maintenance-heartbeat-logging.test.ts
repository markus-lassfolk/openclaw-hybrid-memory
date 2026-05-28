import { afterEach, describe, expect, it, vi } from "vitest";

import { runMaintenanceHeartbeat } from "../cli/commands/manage/maintenance-heartbeat.js";

describe("maintenance heartbeat logging", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs periodic still-running lines with progress when verbose is enabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    let resolveWork: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });

    let progress = "stage=scan; processed=0/2";
    const run = runMaintenanceHeartbeat(
      "build-languages",
      true,
      async () => {
        await done;
      },
      {
        heartbeatIntervalMs: 1_000,
        progressSupplier: () => progress,
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      logs.some((line) => line.includes("build-languages — still running after 1s") && line.includes("processed=0/2")),
    ).toBe(true);

    progress = "stage=scan; processed=1/2";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      logs.some((line) => line.includes("build-languages — still running after 2s") && line.includes("processed=1/2")),
    ).toBe(true);

    resolveWork?.();
    await run;
  });

  it("can force heartbeat output when verbose is disabled", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    await runMaintenanceHeartbeat("reflect-meta-collapse", false, async () => undefined, {
      forceHeartbeat: true,
    });

    expect(logs.some((line) => line.includes("reflect-meta-collapse — start"))).toBe(true);
    expect(logs.some((line) => line.includes("reflect-meta-collapse — complete in"))).toBe(true);
  });

  it("emits periodic still-running lines for synchronous work when heartbeat() is called in-loop", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    let nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    await runMaintenanceHeartbeat(
      "backfill-decay",
      true,
      ({ heartbeat }) => {
        for (let i = 0; i < 7; i++) {
          nowMs += 500;
          heartbeat();
        }
      },
      {
        heartbeatIntervalMs: 1_000,
        progressSupplier: () => "stage=reclassify-stable-facts; scanned=700/700; updated=33",
      },
    );

    expect(logs.filter((line) => line.includes("backfill-decay — still running after")).length).toBeGreaterThanOrEqual(
      3,
    );
  });
});
