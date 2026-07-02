/**
 * dream-cycle and consolidate CLI commands race with the maintenance orchestrator's own
 * "dream-cycle-core"/"consolidate" scheduled steps: a manual CLI run overlapping a scheduled
 * orchestrator tick (or two manual runs) could both execute the same core logic concurrently,
 * producing duplicate consolidated facts or corrupted merges (#72, #73). Both commands now
 * acquire the same step lock name the orchestrator uses around its own steps.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageReflectionPipeline } from "../cli/commands/manage/register-reflection-pipeline.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";

const { acquireStepLockMock, releaseStepLockMock } = vi.hoisted(() => ({
  acquireStepLockMock: vi.fn(),
  releaseStepLockMock: vi.fn(),
}));

vi.mock("../services/cron-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/cron-guard.js")>();
  return {
    ...actual,
    acquireStepLock: acquireStepLockMock,
    releaseStepLock: releaseStepLockMock,
  };
});

function makeMinimalBindings(overrides: Partial<ManageBindings>): ManageBindings {
  const bindings = {
    factsDb: { getRawDb: () => ({}) },
    cfg: {
      toolEffectiveness: { enabled: false },
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
  // ManageBindings also exposes a self-referencing `ctx` for sparse `ctx.*` access
  // (see cli/commands/manage/bindings.ts's buildManageBindings) — some actions (e.g.
  // consolidate) read config through `ctx.cfg` rather than the flattened `cfg` field.
  bindings.ctx = bindings;
  return bindings;
}

function makeProgram(bindings: ManageBindings): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageReflectionPipeline(mem, bindings);
  return mem;
}

describe("dream-cycle / consolidate CLI commands acquire the orchestrator's step lock (#72, #73)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    acquireStepLockMock.mockReset();
    releaseStepLockMock.mockReset();
    process.exitCode = undefined;
  });

  it("dream-cycle acquires and releases the \"dream-cycle-core\" lock around the core run", async () => {
    acquireStepLockMock.mockReturnValue(true);
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
    const mem = makeProgram(makeMinimalBindings({ runDreamCycle }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["dream-cycle"], { from: "user" });

    expect(acquireStepLockMock).toHaveBeenCalledWith("dream-cycle-core");
    expect(runDreamCycle).toHaveBeenCalledTimes(1);
    expect(releaseStepLockMock).toHaveBeenCalledWith("dream-cycle-core");
  });

  it("dream-cycle skips the run without calling runDreamCycle when the lock is already held", async () => {
    acquireStepLockMock.mockReturnValue(false);
    const runDreamCycle = vi.fn();
    const mem = makeProgram(makeMinimalBindings({ runDreamCycle }));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["dream-cycle"], { from: "user" });

    expect(runDreamCycle).not.toHaveBeenCalled();
    expect(releaseStepLockMock).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("already in progress");
  });

  it("consolidate acquires and releases the \"consolidate\" lock around a real (non-dry-run) run", async () => {
    acquireStepLockMock.mockReturnValue(true);
    const runConsolidate = vi.fn().mockResolvedValue({ clustersFound: 1, merged: 1, deleted: 1 });
    const mem = makeProgram(makeMinimalBindings({ runConsolidate }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["consolidate"], { from: "user" });

    expect(acquireStepLockMock).toHaveBeenCalledWith("consolidate");
    expect(runConsolidate).toHaveBeenCalledTimes(1);
    expect(releaseStepLockMock).toHaveBeenCalledWith("consolidate");
  });

  it("consolidate skips the run without calling runConsolidate when the lock is already held", async () => {
    acquireStepLockMock.mockReturnValue(false);
    const runConsolidate = vi.fn();
    const mem = makeProgram(makeMinimalBindings({ runConsolidate }));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["consolidate"], { from: "user" });

    expect(runConsolidate).not.toHaveBeenCalled();
    expect(releaseStepLockMock).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("already in progress");
  });

  it("consolidate --dry-run does not acquire the lock at all", async () => {
    const runConsolidate = vi.fn().mockResolvedValue({ clustersFound: 0, merged: 0, deleted: 0 });
    const mem = makeProgram(makeMinimalBindings({ runConsolidate }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["consolidate", "--dry-run"], { from: "user" });

    expect(acquireStepLockMock).not.toHaveBeenCalled();
    expect(runConsolidate).toHaveBeenCalledTimes(1);
    expect(releaseStepLockMock).not.toHaveBeenCalled();
  });
});
