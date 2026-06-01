import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDistillCommands, type DistillContext } from "../cli/distill.js";

function makeDistillContext(
  overrides: Partial<DistillContext> & Required<Pick<DistillContext, "runGenerateProposals">>,
): DistillContext {
  const { runGenerateProposals, ...contextOverrides } = overrides;

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
    ...contextOverrides,
    runGenerateProposals,
  } as DistillContext;
}

describe("generate-proposals CLI status", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("should exit successfully when zero proposals are generated", async () => {
    const mem = new Command("hybrid-mem");

    registerDistillCommands(
      mem,
      makeDistillContext({
        runGenerateProposals: vi.fn(async () => ({ created: 0 })),
      }),
    );

    await mem.parseAsync(["generate-proposals"], { from: "user" });

    expect(logSpy).toHaveBeenCalledWith("\nCreated 0 proposal(s).");
    expect(process.exitCode).toBeUndefined();
  });

  it("should throw error when proposal generation fails", async () => {
    const mem = new Command("hybrid-mem");
    vi.spyOn(console, "error").mockImplementation(() => {});

    registerDistillCommands(
      mem,
      makeDistillContext({
        runGenerateProposals: vi.fn(async () => {
          throw new Error("memory-hybrid: generate-proposals LLM call failed");
        }),
      }),
    );

    await expect(mem.parseAsync(["generate-proposals"], { from: "user" })).rejects.toThrow(
      "memory-hybrid: generate-proposals LLM call failed",
    );
    expect(logSpy).not.toHaveBeenCalledWith("\nCreated 0 proposal(s).");
  });
});
