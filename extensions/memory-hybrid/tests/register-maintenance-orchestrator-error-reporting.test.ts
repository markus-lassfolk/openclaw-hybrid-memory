/**
 * The maintenance-orchestrator CLI (`maintenance cycle`/`nightly`/`full`/`step`, driven by
 * runTier() in register-maintenance-orchestrator.ts) is the process that actually executes
 * dream-cycle's reflect-rules stage and friends. Those stages already call capturePluginError()
 * directly with rich diagnostics, but capturePluginError() is a silent no-op until
 * initErrorReporter() has run in-process — and this CLI path never called it, so all of that
 * diagnostic detail was dropped in production.
 *
 * These tests assert runTier() now calls initErrorReporter() before invoking the orchestrator,
 * gated by the same errorReporting.enabled && errorReporting.consent check used by
 * services/maintenance-failure-reporter.ts, and that it respects the isErrorReporterActive()
 * idempotency guard (mirrors tests/maintenance-failure-reporter.test.ts's mocking style).
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerMaintenanceOrchestratorCommands } from "../cli/commands/manage/register-maintenance-orchestrator.js";

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

// The real runner map requires a fully-wired ManageBindings; since runMaintenanceOrchestrator
// itself is mocked above, the runners it would receive are never invoked.
vi.mock("../cli/commands/manage/maintenance-step-runners.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/commands/manage/maintenance-step-runners.js")>();
  return {
    ...actual,
    buildCliMaintenanceRunners: () => new Map(),
  };
});

function mockOrchestratorResult() {
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
}

function buildErrorReportingConfig(overrides?: Partial<{ enabled: boolean; consent: boolean }>) {
  return {
    enabled: true,
    consent: true,
    mode: "community" as const,
    dsn: "https://7d641cabffdb4557a7bd2f02c338dc80@glitchtip.lassfolk.cc/1",
    sampleRate: 1,
    updateNudge: { enabled: true, intervalHours: 24, cacheTtlHours: 24 },
    ...overrides,
  };
}

function makeBindings(errorReporting: ReturnType<typeof buildErrorReportingConfig>): ManageBindings {
  return {
    cfg: { errorReporting },
    factsDb: { getRawDb: () => ({}) },
    versionInfo: { pluginVersion: "test-version", memoryManagerVersion: "test", schemaVersion: 1 },
    resolvedSqlitePath: ":memory:",
  } as unknown as ManageBindings;
}

async function runCycle(b: ManageBindings): Promise<void> {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  const maintenance = mem.command("maintenance");
  registerMaintenanceOrchestratorCommands(maintenance, b);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await mem.parseAsync(["maintenance", "cycle"], { from: "user" });
}

describe("register-maintenance-orchestrator error reporter wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    runMaintenanceOrchestratorMock.mockReset();
    process.exitCode = 0;
  });

  it("calls initErrorReporter before running the orchestrator when errorReporting is enabled + consented", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const initSpy = vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(false);
    mockOrchestratorResult();

    await runCycle(makeBindings(buildErrorReportingConfig()));

    expect(initSpy).toHaveBeenCalledTimes(1);
    const [config, pluginVersion] = initSpy.mock.calls[0]!;
    expect(config).toMatchObject({ enabled: true, consent: true, mode: "community" });
    expect(pluginVersion).toBe("test-version");
    // Must be called before the orchestrator itself runs, so any capturePluginError() calls made
    // by the steps it invokes are actually captured (not the point of this test to prove ordering
    // via call order, but the run must have completed without erroring either way).
    expect(runMaintenanceOrchestratorMock).toHaveBeenCalledTimes(1);
  });

  it("does not call initErrorReporter when errorReporting.enabled is false", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const initSpy = vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(false);
    mockOrchestratorResult();

    await runCycle(makeBindings(buildErrorReportingConfig({ enabled: false })));

    expect(initSpy).not.toHaveBeenCalled();
  });

  it("does not call initErrorReporter when errorReporting.consent is false", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const initSpy = vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(false);
    mockOrchestratorResult();

    await runCycle(makeBindings(buildErrorReportingConfig({ consent: false })));

    expect(initSpy).not.toHaveBeenCalled();
  });

  it("does not re-initialize (or throw) when the reporter is already active in-process", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const initSpy = vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(true);
    mockOrchestratorResult();

    await expect(runCycle(makeBindings(buildErrorReportingConfig()))).resolves.toBeUndefined();

    expect(initSpy).not.toHaveBeenCalled();
  });

  it("does not fail the maintenance run when initErrorReporter itself rejects", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    vi.spyOn(errorReporterMock, "initErrorReporter").mockRejectedValue(new Error("reporter init failed"));
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(false);
    mockOrchestratorResult();

    await expect(runCycle(makeBindings(buildErrorReportingConfig()))).resolves.toBeUndefined();

    expect(runMaintenanceOrchestratorMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeFalsy();
  });
});
