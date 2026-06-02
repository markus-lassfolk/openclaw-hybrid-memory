import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDistillCommands, type DistillContext } from "../cli/distill.js";

function makeContext(overrides?: Partial<DistillContext>): DistillContext {
  return {
    runDistillWindow: async () => ({ count: 0 }),
    runRecordDistill: async () => ({ recorded: 0 }),
    runExtractDaily: async () => ({ scanned: 0, extracted: 0, stored: 0, skipped: 0, errors: 0 }),
    runExtractProcedures: async () => ({ sessionsScanned: 0, proceduresExtracted: 0, stored: 0 }),
    runGenerateAutoSkills: async () => ({ scanned: 0, generated: 0, applied: 0 }),
    runDistill: async () => ({ processed: 0, extracted: 0, stored: 0, skipped: 0, errors: 0 }),
    runExtractDirectives: async () => ({
      incidents: [],
      sessionsScanned: 0,
      stored: 0,
      rejected: 0,
      partial: false,
      cursorAdvanced: true,
    }),
    runExtractReinforcement: async () => ({ incidents: [], sessionsScanned: 0, stored: 0, rejected: 0 }),
    ...overrides,
  } as DistillContext;
}

describe("distill semantic maintenance exits", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("marks extract-directives as non-zero when cursor advancement is blocked", async () => {
    const mem = new Command("hybrid-mem");
    registerDistillCommands(
      mem,
      makeContext({
        runExtractDirectives: async () => ({
          incidents: [],
          sessionsScanned: 12,
          stored: 0,
          rejected: 2,
          partial: true,
          cursorAdvanced: false,
          cursorBlockedReason: "retryable_rejections",
          directiveRejected: { permanent: 0, retryable: 2, parserOrModelFailure: 0, boundedPartialRetry: 0 },
        }),
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["extract-directives"], { from: "user" });

    expect(process.exitCode).toBe(2);
  });

  it("keeps extract-directives successful when cursor advances", async () => {
    const mem = new Command("hybrid-mem");
    registerDistillCommands(mem, makeContext());
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["extract-directives"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
  });
});
