/**
 * The tool-effectiveness follow-up stage in `dream-cycle` wrapped runFollowUpStage in its own
 * try/catch and called recordDreamCycleFollowUpFailure again on the caught error — but
 * runFollowUpStage already records the failure itself before re-throwing. A single tool
 * effectiveness failure was double-counted in the "N failure(s)" summary and the
 * follow_up_failures count used by any health monitoring keyed off that line.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageReflectionPipeline } from "../cli/commands/manage/register-reflection-pipeline.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";

function makeMinimalBindings(overrides: Partial<ManageBindings>): ManageBindings {
  return {
    factsDb: { getRawDb: () => ({}) },
    cfg: {
      toolEffectiveness: { enabled: true, runInNightlyCycle: true },
      verification: { enabled: false, continuousVerification: false },
      implicitFeedback: { enabled: false },
      closedLoop: { enabled: false },
      crossAgentLearning: { enabled: false },
      costTracking: { enabled: false },
      crystallization: { enabled: false },
    },
    reflectionConfig: { defaultWindow: 7, model: "test-model" },
    ...overrides,
  } as unknown as ManageBindings;
}

function makeProgram(bindings: ManageBindings): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageReflectionPipeline(mem, bindings);
  return mem;
}

describe("dream-cycle tool-effectiveness follow-up failure counting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("counts a tool-effectiveness failure exactly once in the follow-up failure summary", async () => {
    const runDreamCycle = vi.fn().mockResolvedValue({
      skipped: false,
      success: true,
      digestSummary: "ok",
      failedStages: [],
      factsPruned: 0,
      factsDecayed: 0,
      eventsConsolidated: 0,
      factsCreated: 0,
      patternsFound: 0,
      rulesGenerated: 0,
    });
    const runToolEffectiveness = vi.fn().mockRejectedValue(new Error("tool effectiveness boom"));
    const mem = makeProgram(makeMinimalBindings({ runDreamCycle, runToolEffectiveness }));

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["dream-cycle"], { from: "user" });

    const out = lines.join("\n");
    expect(out).toContain("Dream cycle follow-ups: 1 failure(s)");
    expect(out).toContain("follow_up_failures=1");
    const failureLines = lines.filter((l) => l.trim().startsWith("- ") && l.includes("tool effectiveness"));
    expect(failureLines).toHaveLength(1);
  });
});
