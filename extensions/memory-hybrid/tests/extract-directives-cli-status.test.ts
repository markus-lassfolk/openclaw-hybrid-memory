import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDistillCommands, type DistillContext } from "../cli/distill.js";

function makeDistillContext(
  overrides: Partial<DistillContext> & Required<Pick<DistillContext, "runExtractDirectives">>,
): DistillContext {
  const { runExtractDirectives, ...contextOverrides } = overrides;

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
    runExtractDirectives,
    runExtractReinforcement: vi.fn(async () => ({ incidents: [], sessionsScanned: 0, annotationStatus: "ok" })),
    ...contextOverrides,
  } as DistillContext;
}

describe("extract-directives CLI status", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("sets non-zero exit code when extraction is partial and cursor did not advance", async () => {
    const mem = new Command("hybrid-mem");

    registerDistillCommands(
      mem,
      makeDistillContext({
        runExtractDirectives: vi.fn(async () => ({
          incidents: [],
          sessionsScanned: 1,
          stored: 0,
          rejected: 0,
          partial: true,
          directiveRejected: {
            permanent: 0,
            retryable: 1,
            parserOrModelFailure: 0,
            boundedPartialRetry: 0,
          },
          cursorAdvanced: false,
          cursorBlockedReason: "retryable_rejections",
        })),
      }),
    );

    await mem.parseAsync(["extract-directives"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("keeps successful exit when cursor advances", async () => {
    const mem = new Command("hybrid-mem");

    registerDistillCommands(
      mem,
      makeDistillContext({
        runExtractDirectives: vi.fn(async () => ({
          incidents: [],
          sessionsScanned: 1,
          stored: 0,
          rejected: 0,
          partial: false,
          directiveRejected: {
            permanent: 0,
            retryable: 0,
            parserOrModelFailure: 0,
            boundedPartialRetry: 0,
          },
          cursorAdvanced: true,
        })),
      }),
    );

    await mem.parseAsync(["extract-directives"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
  });
});
