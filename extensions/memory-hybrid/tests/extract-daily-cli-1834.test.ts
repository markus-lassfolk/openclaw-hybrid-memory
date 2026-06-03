/**
 * Tests for issue #1834 — extract-daily --full / --force flag acceptance.
 *
 * Acceptance criteria:
 * - `openclaw hybrid-mem extract-daily --full` is accepted without error.
 * - `openclaw hybrid-mem extract-daily --force` is accepted without error.
 * - opts type accepts force/full properties (type-level contract).
 */

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDistillCommands } from "../cli/distill.js";
import type { DistillContext } from "../cli/distill.js";
import type { ExtractDailySink } from "../cli/types.js";

function makeDistillContext(
  runExtractDaily: DistillContext["runExtractDaily"],
): DistillContext {
  return {
    runDistillWindow: vi.fn().mockResolvedValue({ mode: "incremental", startDate: "", endDate: "", mtimeDays: 1 }),
    runRecordDistill: vi.fn().mockResolvedValue({ timestamp: "", path: "" }),
    runExtractDaily,
    runExtractProcedures: vi.fn().mockResolvedValue({ stored: 0 }),
    runGenerateAutoSkills: vi.fn().mockResolvedValue({ generated: 0 }),
    runDistill: vi.fn().mockResolvedValue({ stored: 0, sessionsScanned: 0 }),
    runExtractDirectives: vi.fn().mockResolvedValue({ sessionsScanned: 0 }),
    runExtractReinforcement: vi.fn().mockResolvedValue({ sessionsScanned: 0 }),
  } as unknown as DistillContext;
}

describe("extract-daily CLI flag contract (#1834)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("accepts --full flag and passes full=true and force=true to runExtractDaily", async () => {
    let capturedOpts: Record<string, unknown> = {};
    const runExtractDaily = vi
      .fn()
      .mockImplementation(async (opts: Record<string, unknown>, _sink: ExtractDailySink) => {
        capturedOpts = opts;
        return { totalExtracted: 2, totalStored: 1, daysBack: 3, dryRun: false };
      });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerDistillCommands(mem, makeDistillContext(runExtractDaily));

    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["extract-daily", "--full", "--days", "3"], { from: "user" });

    expect(runExtractDaily).toHaveBeenCalledOnce();
    expect(capturedOpts.force).toBe(true);
    expect(capturedOpts.full).toBe(true);
    expect(capturedOpts.days).toBe(3);
    expect(capturedOpts.dryRun).toBe(false);
  });

  it("accepts --force flag and passes force=true and full=true to runExtractDaily", async () => {
    let capturedOpts: Record<string, unknown> = {};
    const runExtractDaily = vi
      .fn()
      .mockImplementation(async (opts: Record<string, unknown>, _sink: ExtractDailySink) => {
        capturedOpts = opts;
        return { totalExtracted: 0, totalStored: 0, daysBack: 7, dryRun: false };
      });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerDistillCommands(mem, makeDistillContext(runExtractDaily));

    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["extract-daily", "--force"], { from: "user" });

    expect(runExtractDaily).toHaveBeenCalledOnce();
    expect(capturedOpts.force).toBe(true);
    expect(capturedOpts.full).toBe(true);
  });

  it("runs normally without --force or --full (force=false, full=false)", async () => {
    let capturedOpts: Record<string, unknown> = {};
    const runExtractDaily = vi
      .fn()
      .mockImplementation(async (opts: Record<string, unknown>, _sink: ExtractDailySink) => {
        capturedOpts = opts;
        return { totalExtracted: 5, totalStored: 3, daysBack: 7, dryRun: false };
      });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerDistillCommands(mem, makeDistillContext(runExtractDaily));

    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["extract-daily"], { from: "user" });

    expect(runExtractDaily).toHaveBeenCalledOnce();
    expect(capturedOpts.force).toBe(false);
    expect(capturedOpts.full).toBe(false);
    expect(capturedOpts.dryRun).toBe(false);
  });
});
