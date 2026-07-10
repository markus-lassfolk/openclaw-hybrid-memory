/**
 * Regression test for cli/distill.ts's --days flag across distill/extract-daily/
 * extract-procedures/extract-directives/extract-reinforcement:
 *
 * `extract-daily` did `Number.parseInt(opts.days, 10)` with zero validation, and
 * `extract-directives`/`extract-reinforcement` did the same via `Number.parseInt(opts.days ??
 * "3", 10)`. A negative/NaN days value flows into a `for (let d = 0; d < daysBack; d++)` loop
 * (cli/cmd-extract-daily.ts:221) that silently no-ops when the condition is false from the start,
 * so the CLI reported "Extracted 0 new facts" with exit code 0 instead of rejecting the flag.
 * `distill run`/`extract-procedures` guarded NaN via `Number.isFinite`, but not negative values.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDistillCommands, type DistillContext } from "../cli/distill.js";

function makeDistillContext(overrides: Partial<DistillContext>): DistillContext {
  return {
    runDistillWindow: vi.fn(async () => ({
      mode: "full",
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      mtimeDays: 1,
    })),
    runRecordDistill: vi.fn(async () => ({ timestamp: "2026-01-01T00:00:00.000Z", path: ".distill_last_run" })),
    runExtractDaily: vi.fn(async () => ({ dryRun: false, totalExtracted: 0, totalStored: 0, daysBack: 7 })),
    runExtractProcedures: vi.fn(async () => ({
      dryRun: false,
      sessionsScanned: 0,
      proceduresStored: 0,
      positiveCount: 0,
      negativeCount: 0,
    })),
    runGenerateAutoSkills: vi.fn(async () => ({ dryRun: false, generated: 0, skipped: 0, paths: [] })),
    runDistill: vi.fn(async () => ({
      dryRun: false,
      factsExtracted: 0,
      sessionsScanned: 0,
      stored: 0,
      dedupSkipped: 0,
    })),
    runExtractDirectives: vi.fn(async () => ({ incidents: [], sessionsScanned: 0 })),
    runExtractReinforcement: vi.fn(async () => ({ incidents: [], sessionsScanned: 0, annotationStatus: "ok" })),
    runGenerateProposals: vi.fn(async () => ({ created: 0 })),
    ...overrides,
  } as DistillContext;
}

describe("--days flag validation across distill/extract-* commands (regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("extract-daily rejects a negative --days instead of silently processing zero days", async () => {
    const mem = new Command("hybrid-mem");
    const runExtractDaily = vi.fn(async () => ({ dryRun: false, totalExtracted: 0, totalStored: 0, daysBack: -5 }));
    registerDistillCommands(mem, makeDistillContext({ runExtractDaily }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["extract-daily", "--days", "-5"], { from: "user" });

    expect(runExtractDaily).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("extract-daily rejects a non-numeric --days", async () => {
    const mem = new Command("hybrid-mem");
    const runExtractDaily = vi.fn();
    registerDistillCommands(mem, makeDistillContext({ runExtractDaily }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["extract-daily", "--days", "not-a-number"], { from: "user" });

    expect(runExtractDaily).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("extract-directives rejects a negative --days", async () => {
    const mem = new Command("hybrid-mem");
    const runExtractDirectives = vi.fn(async () => ({ incidents: [], sessionsScanned: 0 }));
    registerDistillCommands(mem, makeDistillContext({ runExtractDirectives }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["extract-directives", "--days", "-1"], { from: "user" });

    expect(runExtractDirectives).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("extract-reinforcement rejects a negative --days", async () => {
    const mem = new Command("hybrid-mem");
    const runExtractReinforcement = vi.fn(async () => ({ incidents: [], sessionsScanned: 0 }));
    registerDistillCommands(mem, makeDistillContext({ runExtractReinforcement }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["extract-reinforcement", "--days", "-1"], { from: "user" });

    expect(runExtractReinforcement).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("distill run rejects a negative --days", async () => {
    const mem = new Command("hybrid-mem");
    const runDistill = vi.fn(async () => ({
      dryRun: false,
      factsExtracted: 0,
      sessionsScanned: 0,
      stored: 0,
      dedupSkipped: 0,
    }));
    registerDistillCommands(mem, makeDistillContext({ runDistill }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["distill", "--days", "-2"], { from: "user" });

    expect(runDistill).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("extract-procedures rejects a negative --days", async () => {
    const mem = new Command("hybrid-mem");
    const runExtractProcedures = vi.fn(async () => ({
      dryRun: false,
      sessionsScanned: 0,
      proceduresStored: 0,
      positiveCount: 0,
      negativeCount: 0,
    }));
    registerDistillCommands(mem, makeDistillContext({ runExtractProcedures }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["extract-procedures", "--days", "-3"], { from: "user" });

    expect(runExtractProcedures).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("extract-procedures still treats an omitted --days as unbounded (empty-string default)", async () => {
    const mem = new Command("hybrid-mem");
    const runExtractProcedures = vi.fn(async () => ({
      dryRun: false,
      sessionsScanned: 0,
      proceduresStored: 0,
      positiveCount: 0,
      negativeCount: 0,
    }));
    registerDistillCommands(mem, makeDistillContext({ runExtractProcedures }));

    await mem.parseAsync(["extract-procedures"], { from: "user" });

    expect(runExtractProcedures).toHaveBeenCalledWith(expect.objectContaining({ days: undefined }));
    expect(process.exitCode).toBeUndefined();
  });

  it("still accepts a valid positive --days for extract-daily", async () => {
    const mem = new Command("hybrid-mem");
    const runExtractDaily = vi.fn(async () => ({ dryRun: false, totalExtracted: 0, totalStored: 0, daysBack: 14 }));
    registerDistillCommands(mem, makeDistillContext({ runExtractDaily }));

    await mem.parseAsync(["extract-daily", "--days", "14"], { from: "user" });

    expect(runExtractDaily).toHaveBeenCalledWith(expect.objectContaining({ days: 14 }), expect.any(Object));
    expect(process.exitCode).toBeUndefined();
  });
});
