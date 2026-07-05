/**
 * `maintenance steps` must report the actual registered step count, not a stale hardcoded number
 * that silently drifts every time a step is added or removed from MAINTENANCE_STEPS.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerMaintenanceOrchestratorCommands } from "../cli/commands/manage/register-maintenance-orchestrator.js";
import { listMaintenanceSteps } from "../services/maintenance-orchestrator.js";

const { runMaintenanceOrchestratorMock } = vi.hoisted(() => ({
  runMaintenanceOrchestratorMock: vi.fn(),
}));

vi.mock("../services/maintenance-orchestrator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/maintenance-orchestrator.js")>();
  return {
    ...actual,
    runMaintenanceOrchestrator: runMaintenanceOrchestratorMock,
  };
});

// The real runner map requires a fully-wired ManageBindings (factsDb, vectorDb, runCompaction, ...);
// since runMaintenanceOrchestrator itself is mocked above, the runners it would receive are never
// invoked, so stub the builder to sidestep that wiring entirely.
vi.mock("../cli/commands/manage/maintenance-step-runners.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/commands/manage/maintenance-step-runners.js")>();
  return {
    ...actual,
    buildCliMaintenanceRunners: () => new Map(),
  };
});

function makeMinimalBindings(): ManageBindings {
  return {
    cfg: {},
    factsDb: { getRawDb: () => ({}) },
  } as unknown as ManageBindings;
}

function mockOrchestratorResult(overrides: {
  stepName: string;
  status: "ok" | "skipped_guard" | "skipped_gate";
  summary: string;
}) {
  const nowIso = new Date().toISOString();
  runMaintenanceOrchestratorMock.mockResolvedValue({
    tierLabel: "full",
    steps: [{ name: overrides.stepName, status: overrides.status, summary: overrides.summary, durationMs: 0 }],
    exitCode: 0,
    summaryLine: "Maintenance full — 1 steps",
    runId: "job-test-run",
    startedAt: nowIso,
    finishedAt: nowIso,
    durationMs: 5,
  });
}

describe("maintenance steps CLI step count", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the actual number of registered steps, not a hardcoded count", async () => {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, { cfg: {} } as unknown as ManageBindings);

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["maintenance", "steps"], { from: "user" });

    const actualCount = listMaintenanceSteps().length;
    expect(lines[0]).toBe(`Maintenance steps (${actualCount} registered):`);
  });
});

describe("maintenance step <step> CLI (#2028)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("rejects an unknown step name with a non-zero exit and lists the valid step names", async () => {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, { cfg: {} } as unknown as ManageBindings);

    const errLines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errLines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["maintenance", "step", "does-not-exist"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(errLines[0]).toContain("Unknown maintenance step: does-not-exist");
    // Lists valid step names so an operator can correct the invocation.
    const validNames = listMaintenanceSteps().map((s) => s.name);
    expect(errLines.some((l) => l.includes(`Valid steps (${validNames.length})`))).toBe(true);
    expect(errLines.some((l) => l.trim() === validNames[0])).toBe(true);
  });

  it("registers a `step <step>` command that takes a required step argument", () => {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, { cfg: {} } as unknown as ManageBindings);
    const stepCmd = maintenance.commands.find((c) => c.name() === "step");
    expect(stepCmd).toBeDefined();
    // The required positional makes `maintenance step` (no name) fail argument parsing.
    expect(stepCmd?.usage()).toContain("<step>");
  });
});

describe("maintenance step <step> exits non-zero when the selected step did not run (#2031)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runMaintenanceOrchestratorMock.mockReset();
    process.exitCode = 0;
  });

  it("exits non-zero when the only selected step is skipped_guard (e.g. locked by a concurrent run)", async () => {
    const stepName = listMaintenanceSteps()[0]?.name as string;
    mockOrchestratorResult({
      stepName,
      status: "skipped_guard",
      summary: "locked by a concurrent maintenance run (pid=123 host=test held=5s stale=false lock=/tmp/x.lock)",
    });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, makeMinimalBindings());

    vi.spyOn(console, "log").mockImplementation(() => {});
    const errLines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errLines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["maintenance", "step", stepName, "--force"], { from: "user" });

    expect(process.exitCode).toBe(3);
    expect(errLines.some((l) => l.includes("selected step(s) did not run") && l.includes("skipped_guard"))).toBe(true);
  });

  it("leaves exit code untouched when --allow-skip is passed for a skipped selected step", async () => {
    const stepName = listMaintenanceSteps()[0]?.name as string;
    mockOrchestratorResult({ stepName, status: "skipped_guard", summary: "locked by a concurrent maintenance run" });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, makeMinimalBindings());

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["maintenance", "step", stepName, "--force", "--allow-skip"], { from: "user" });

    expect(process.exitCode).toBeFalsy();
  });

  it("leaves exit code untouched when the selected step actually ran (status=ok)", async () => {
    const stepName = listMaintenanceSteps()[0]?.name as string;
    mockOrchestratorResult({ stepName, status: "ok", summary: "done" });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, makeMinimalBindings());

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["maintenance", "step", stepName, "--force"], { from: "user" });

    expect(process.exitCode).toBeFalsy();
  });
});

describe("maintenance cycle/nightly/full --include --force share the same skip protection (#2031)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runMaintenanceOrchestratorMock.mockReset();
    process.exitCode = 0;
  });

  it("exits non-zero when `cycle --include <step> --force` skips the only requested step", async () => {
    const stepName = listMaintenanceSteps()[0]?.name as string;
    mockOrchestratorResult({ stepName, status: "skipped_guard", summary: "locked by a concurrent maintenance run" });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, makeMinimalBindings());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["maintenance", "cycle", "--include", stepName, "--force"], { from: "user" });

    expect(process.exitCode).toBe(3);
  });

  it("does NOT flag a skip on `cycle --include <step>` without --force (ordinary cadence-guard skip stays exit 0)", async () => {
    const stepName = listMaintenanceSteps()[0]?.name as string;
    mockOrchestratorResult({ stepName, status: "skipped_guard", summary: "guard (ran 2h ago)" });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, makeMinimalBindings());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["maintenance", "cycle", "--include", stepName], { from: "user" });

    expect(process.exitCode).toBeFalsy();
  });

  it("exits non-zero when the requested --include name never produces a step result at all (wrong tier or typo)", async () => {
    // e.g. `cycle --include <nightly-only-step> --force`: the orchestrator's tier+include filter
    // drops the step before it ever runs, so result.steps is empty for that name — a blind spot in
    // a naive "filter result.steps down to the requested names" check (round-2 review finding).
    const nowIso = new Date().toISOString();
    runMaintenanceOrchestratorMock.mockResolvedValue({
      tierLabel: "cycle",
      steps: [],
      exitCode: 0,
      summaryLine: "Maintenance cycle — 0 steps",
      runId: "job-test-run",
      startedAt: nowIso,
      finishedAt: nowIso,
      durationMs: 5,
    });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, makeMinimalBindings());
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errLines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errLines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["maintenance", "cycle", "--include", "some-nightly-only-step", "--force"], {
      from: "user",
    });

    expect(process.exitCode).toBe(3);
    expect(errLines.some((l) => l.includes("no result (wrong tier, excluded, or unregistered runner)"))).toBe(true);
  });
});

describe("maintenance step <step> bounds runtime by default (#2032)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runMaintenanceOrchestratorMock.mockReset();
    process.exitCode = 0;
  });

  it("passes a default 15-minute maxRuntimeMs when --max-runtime-min is not given", async () => {
    const stepName = listMaintenanceSteps()[0]?.name as string;
    mockOrchestratorResult({ stepName, status: "ok", summary: "done" });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, makeMinimalBindings());
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["maintenance", "step", stepName, "--force"], { from: "user" });

    expect(runMaintenanceOrchestratorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxRuntimeMs: 15 * 60_000 }),
    );
  });

  it("honors an explicit --max-runtime-min override", async () => {
    const stepName = listMaintenanceSteps()[0]?.name as string;
    mockOrchestratorResult({ stepName, status: "ok", summary: "done" });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, makeMinimalBindings());
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["maintenance", "step", stepName, "--force", "--max-runtime-min", "5"], { from: "user" });

    expect(runMaintenanceOrchestratorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxRuntimeMs: 5 * 60_000 }),
    );
  });

  it("treats --max-runtime-min 0 as no budget instead of an immediately-exceeded zero-minute budget", async () => {
    // "0" is a truthy, finite numeric string — without an explicit > 0 check it would produce
    // maxRuntimeMs=0, which the orchestrator's `elapsed >= maxRuntimeMs` check treats as already
    // exceeded before the first step runs, deferring every step (round-2 review finding).
    const stepName = listMaintenanceSteps()[0]?.name as string;
    mockOrchestratorResult({ stepName, status: "ok", summary: "done" });

    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    const maintenance = mem.command("maintenance");
    registerMaintenanceOrchestratorCommands(maintenance, makeMinimalBindings());
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["maintenance", "step", stepName, "--force", "--max-runtime-min", "0"], { from: "user" });

    expect(runMaintenanceOrchestratorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxRuntimeMs: undefined }),
    );
  });
});
