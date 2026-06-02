import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDistillCommands, type DistillContext } from "../cli/distill.js";

function makeDistillContext(
  overrides: Partial<DistillContext>,
): DistillContext {
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

describe("extract-daily CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("accepts legacy --full and forwards it as a scan override", async () => {
    const mem = new Command("hybrid-mem");
    const runExtractDaily = vi.fn(async () => ({ dryRun: false, totalExtracted: 0, totalStored: 0, daysBack: 7 }));

    registerDistillCommands(
      mem,
      makeDistillContext({
        runExtractDaily,
      }),
    );

    await mem.parseAsync(["extract-daily", "--full"], { from: "user" });

    expect(runExtractDaily).toHaveBeenCalledWith(
      expect.objectContaining({ days: 7, force: true, full: true }),
      expect.any(Object),
    );
  });
});
