/**
 * Regression tests for #2089: `dream-cycle --dry-run` and `--dry-run --json`.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageReflectionPipeline } from "../cli/commands/manage/register-reflection-pipeline.js";

function makeProgram(overrides: Partial<ManageBindings>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageReflectionPipeline(mem, {
    cfg: {},
    reflectionConfig: { defaultWindow: 14, model: "test-model" },
    ...overrides,
  } as unknown as ManageBindings);
  return mem;
}

const baseResult = {
  skipped: false,
  success: true,
  digestSummary: "[DRY RUN — preview only] would prune 1 fact(s)",
  failedStages: [],
  factsPruned: 1,
  factsDecayed: 0,
  linksPruned: 0,
  eventsConsolidated: 0,
  factsCreated: 0,
  patternsFound: 0,
  rulesGenerated: 0,
  logRowsPruned: 0,
  vacuumRan: false,
  decayReclassified: 0,
  orphanVectorsRemoved: 0,
  dryRun: true,
};

describe("dream-cycle --dry-run CLI (#2089)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("passes dryRun:true through to runDreamCycle when --dry-run is set", async () => {
    const runDreamCycle = vi.fn(async () => baseResult);
    const mem = makeProgram({ runDreamCycle });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["dream-cycle", "--dry-run"], { from: "user" });

    expect(runDreamCycle).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(process.exitCode).toBeUndefined();
  });

  it("does not pass dryRun:true when --dry-run is omitted", async () => {
    const runDreamCycle = vi.fn(async (_opts?: { verbose?: boolean; dryRun?: boolean }) => ({
      ...baseResult,
      dryRun: false,
      digestSummary: "ok",
    }));
    const mem = makeProgram({ runDreamCycle });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["dream-cycle"], { from: "user" });

    const passedOpts = runDreamCycle.mock.calls[0]?.[0];
    expect(passedOpts?.dryRun).not.toBe(true);
  });

  it("--dry-run --json emits the full result as JSON on stdout", async () => {
    const runDreamCycle = vi.fn(async () => baseResult);
    const mem = makeProgram({ runDreamCycle });
    let jsonOut = "";
    vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
      jsonOut = String(arg);
    });

    await mem.parseAsync(["dream-cycle", "--dry-run", "--json"], { from: "user" });

    const parsed = JSON.parse(jsonOut);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.factsPruned).toBe(1);
    expect(parsed).toHaveProperty("coreElapsedSec");
    expect(process.exitCode).toBeUndefined();
  });

  it("--json without --dry-run is rejected — a live run touches too many follow-up subsystems for one summary", async () => {
    const runDreamCycle = vi.fn(async () => baseResult);
    const mem = makeProgram({ runDreamCycle });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(mem.parseAsync(["dream-cycle", "--json"], { from: "user" })).rejects.toThrow(
      /--json is only supported together with --dry-run/,
    );

    expect(runDreamCycle).not.toHaveBeenCalled();
  });

  it("--dry-run --json sets a nonzero exit code when the preview reports a failed core stage", async () => {
    const runDreamCycle = vi.fn(async () => ({
      ...baseResult,
      success: false,
      failedStages: ["core prune/decay/link/vector maintenance"],
    }));
    const mem = makeProgram({ runDreamCycle });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["dream-cycle", "--dry-run", "--json"], { from: "user" });

    expect(process.exitCode).toBe(2);
  });
});
