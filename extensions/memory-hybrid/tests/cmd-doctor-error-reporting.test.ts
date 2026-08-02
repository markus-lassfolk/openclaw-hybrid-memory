/**
 * `doctor --fix --reconcile` is the payload of the `hybrid-mem:nightly-doctor-repair` cron lane
 * (cli/install/cron-jobs.ts) and runs in its own isolated one-shot process. Nothing else on that
 * path called initErrorReporter() before this, so any capturePluginError() calls made deep inside
 * the repair/reconcile pipeline were silent no-ops in production (issue #2231).
 *
 * These tests assert `doctor`'s action handler now activates the error reporter before running any
 * checks, gated by the same errorReporting.enabled && errorReporting.consent check used by
 * cli/commands/manage/register-maintenance-orchestrator.ts's own
 * ensureMaintenanceOrchestratorErrorReporter (mirrors that file's test conventions).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { registerDoctorCommand } from "../cli/cmd-doctor.js";

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

describe("doctor CLI error reporter wiring (#2231)", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function setupDoctorHarness(errorReporting: ReturnType<typeof buildErrorReportingConfig>) {
    const root = mkdtempSync(join(tmpdir(), "hm-doctor-errrep-"));
    tmpRoots.push(root);

    const sqlitePath = join(root, "facts.db");
    const factsDb = new FactsDB(sqlitePath);
    const mem = new Command("hybrid-mem");
    mem.exitOverride();

    registerDoctorCommand(
      mem as never,
      { sqlitePath, embedding: { provider: "openai", apiKey: "sk-test" }, errorReporting } as never,
      factsDb,
      { getAllIds: async () => [] } as never,
      null,
      sqlitePath,
      null,
      null,
      undefined,
      "test-plugin-version",
    );

    return { factsDb, mem };
  }

  it("calls initErrorReporter before running checks when errorReporting is enabled + consented", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const initSpy = vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { factsDb, mem } = setupDoctorHarness(buildErrorReportingConfig());

    await mem.parseAsync(["doctor"], { from: "user" });

    expect(initSpy).toHaveBeenCalledTimes(1);
    const [config, pluginVersion] = initSpy.mock.calls[0]!;
    expect(config).toMatchObject({ enabled: true, consent: true, mode: "community" });
    expect(pluginVersion).toBe("test-plugin-version");
    factsDb.close();
  });

  it("does not call initErrorReporter when errorReporting.enabled is false", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const initSpy = vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { factsDb, mem } = setupDoctorHarness(buildErrorReportingConfig({ enabled: false }));

    await mem.parseAsync(["doctor"], { from: "user" });

    expect(initSpy).not.toHaveBeenCalled();
    factsDb.close();
  });

  it("does not call initErrorReporter when errorReporting.consent is false", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const initSpy = vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { factsDb, mem } = setupDoctorHarness(buildErrorReportingConfig({ consent: false }));

    await mem.parseAsync(["doctor"], { from: "user" });

    expect(initSpy).not.toHaveBeenCalled();
    factsDb.close();
  });

  it("does not re-initialize when the reporter is already active in-process", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const initSpy = vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(true);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { factsDb, mem } = setupDoctorHarness(buildErrorReportingConfig());

    await mem.parseAsync(["doctor"], { from: "user" });

    expect(initSpy).not.toHaveBeenCalled();
    factsDb.close();
  });

  it("does not fail doctor when initErrorReporter itself rejects", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    vi.spyOn(errorReporterMock, "initErrorReporter").mockRejectedValue(new Error("reporter init failed"));
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(false);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { factsDb, mem } = setupDoctorHarness(buildErrorReportingConfig());

    await expect(mem.parseAsync(["doctor"], { from: "user" })).resolves.toBeDefined();
    factsDb.close();
  });
});
