import { afterEach, describe, expect, it, vi } from "vitest";
import type { HybridMemoryConfig } from "../config.js";
import type { MaintenanceTelemetryIssue } from "../services/cron-exit-validator.js";
import { setEnv } from "../utils/env-manager.js";

describe("maintenance-failure-reporter", () => {
  afterEach(() => {
    setEnv("HYBRID_MEMORY_DISABLE_MAINTENANCE_ERROR_REPORTING", undefined);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function buildConfig() {
    return {
      errorReporting: {
        enabled: true,
        consent: true,
        mode: "community" as const,
        dsn: "https://7d641cabffdb4557a7bd2f02c338dc80@glitchtip.lassfolk.cc/1",
        sampleRate: 1,
        updateNudge: { enabled: true, intervalHours: 24, cacheTtlHours: 24 },
      },
      maintenance: {
        failureReporting: {
          enabled: true,
        },
      },
    };
  }

  function buildMockIssue(overrides?: Partial<MaintenanceTelemetryIssue>): MaintenanceTelemetryIssue {
    return {
      fingerprint: ["hybrid-memory-maintenance", "test-job", "test-step", "test-class"],
      jobName: "test-job",
      stepName: "test-step",
      failureCategory: "mechanical_failure",
      failureClass: "nonzero_exit",
      message: "Test maintenance failure",
      semanticStatus: "ok",
      exitCode: 1,
      guardFile: "/tmp/test-guard",
      guardStateBefore: "ok",
      guardStateAfter: "failed",
      hmLogPath: "/tmp/test.log",
      hmExitPath: "/tmp/test.exit",
      ...overrides,
    };
  }

  it("reports when maintenance and error reporting are both enabled", async () => {
    const { shouldReportMaintenanceFailures } = await import("../services/maintenance-failure-reporter.js");
    expect(shouldReportMaintenanceFailures(buildConfig())).toBe(true);
  });

  it("honors the maintenance reporting environment opt-out", async () => {
    setEnv("HYBRID_MEMORY_DISABLE_MAINTENANCE_ERROR_REPORTING", "1");
    const { shouldReportMaintenanceFailures } = await import("../services/maintenance-failure-reporter.js");
    expect(shouldReportMaintenanceFailures(buildConfig())).toBe(false);
  });

  it("honors config opt-out even when global error reporting remains enabled", async () => {
    const { shouldReportMaintenanceFailures } = await import("../services/maintenance-failure-reporter.js");
    const cfg = buildConfig();
    cfg.maintenance.failureReporting.enabled = false;
    expect(shouldReportMaintenanceFailures(cfg)).toBe(false);
  });

  it("honors global error reporting consent flag", async () => {
    const { shouldReportMaintenanceFailures } = await import("../services/maintenance-failure-reporter.js");
    const cfg = buildConfig();
    cfg.errorReporting.consent = false;
    expect(shouldReportMaintenanceFailures(cfg)).toBe(false);
  });

  it("honors global error reporting enabled flag", async () => {
    const { shouldReportMaintenanceFailures } = await import("../services/maintenance-failure-reporter.js");
    const cfg = buildConfig();
    cfg.errorReporting.enabled = false;
    expect(shouldReportMaintenanceFailures(cfg)).toBe(false);
  });

  it("no-ops when reporting is disabled", async () => {
    const { reportMaintenanceFailureIssues } = await import("../services/maintenance-failure-reporter.js");
    const cfg = buildConfig();
    cfg.maintenance.failureReporting.enabled = false;

    // Should not throw and should complete quickly
    await expect(
      reportMaintenanceFailureIssues([buildMockIssue()], {
        cfg,
        pluginVersion: "test-version",
      }),
    ).resolves.toBeUndefined();
  });

  it("no-ops when issue array is empty", async () => {
    const { reportMaintenanceFailureIssues } = await import("../services/maintenance-failure-reporter.js");

    await expect(
      reportMaintenanceFailureIssues([], {
        cfg: buildConfig(),
        pluginVersion: "test-version",
      }),
    ).resolves.toBeUndefined();
  });

  it("deduplicates issues by fingerprint", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const capturePluginErrorSpy = vi.spyOn(errorReporterMock, "capturePluginError");
    vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(true);
    vi.spyOn(errorReporterMock, "flushErrorReporter").mockResolvedValue(true);

    const { reportMaintenanceFailureIssues } = await import("../services/maintenance-failure-reporter.js");

    const issue1 = buildMockIssue();
    const issue2 = buildMockIssue({ message: "Different message, same fingerprint" });

    await reportMaintenanceFailureIssues([issue1, issue2], {
      cfg: buildConfig(),
      pluginVersion: "test-version",
    });

    // Should only capture once due to deduplication
    expect(capturePluginErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("passes stable fingerprints to the error reporter", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const capturePluginErrorSpy = vi.spyOn(errorReporterMock, "capturePluginError");
    vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(true);
    vi.spyOn(errorReporterMock, "flushErrorReporter").mockResolvedValue(true);

    const { reportMaintenanceFailureIssues } = await import("../services/maintenance-failure-reporter.js");

    const issue = buildMockIssue({
      fingerprint: ["hybrid-memory-maintenance", "reflect-rules", "parse-output", "zero_stored"],
    });

    await reportMaintenanceFailureIssues([issue], {
      cfg: buildConfig(),
      pluginVersion: "test-version",
    });

    expect(capturePluginErrorSpy).toHaveBeenCalledTimes(1);
    const captureCall = capturePluginErrorSpy.mock.calls[0];
    const context = captureCall?.[1];
    expect(context?.fingerprint).toEqual(["hybrid-memory-maintenance", "reflect-rules", "parse-output", "zero_stored"]);
  });

  it("includes maintenance context in the error report", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const capturePluginErrorSpy = vi.spyOn(errorReporterMock, "capturePluginError");
    vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(true);
    vi.spyOn(errorReporterMock, "flushErrorReporter").mockResolvedValue(true);

    const { reportMaintenanceFailureIssues } = await import("../services/maintenance-failure-reporter.js");

    const issue = buildMockIssue({
      jobName: "reflect-rules",
      stepName: "parse-output",
      failureCategory: "semantic_failure",
      failureClass: "zero_stored",
    });

    await reportMaintenanceFailureIssues([issue], {
      cfg: buildConfig(),
      pluginVersion: "test-version",
    });

    expect(capturePluginErrorSpy).toHaveBeenCalledTimes(1);
    const captureCall = capturePluginErrorSpy.mock.calls[0];
    const context = captureCall?.[1];

    expect(context?.subsystem).toBe("maintenance");
    expect(context?.operation).toBe("parse-output");
    expect(context?.phase).toBe("semantic_failure");
    expect(context?.tags?.job_name).toBe("reflect-rules");
    expect(context?.tags?.step_name).toBe("parse-output");
    expect(context?.tags?.failure_class).toBe("zero_stored");
    expect(context?.contexts?.maintenance).toBeDefined();
    expect(context?.contexts?.maintenance?.job_name).toBe("reflect-rules");
    expect(context?.contexts?.maintenance?.failure_category).toBe("semantic_failure");
  });

  it("threads distill batch-failure counts into tags and contexts (GlitchTip issue 27)", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const capturePluginErrorSpy = vi.spyOn(errorReporterMock, "capturePluginError");
    vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(true);
    vi.spyOn(errorReporterMock, "flushErrorReporter").mockResolvedValue(true);

    const { reportMaintenanceFailureIssues } = await import("../services/maintenance-failure-reporter.js");

    const issue = buildMockIssue({
      jobName: "nightly-memory-sweep",
      stepName: "distill",
      failureCategory: "semantic_failure",
      failureClass: "distill_partial_batch_failures",
      batchFailures: 2,
      hardBatchFailures: 1,
      truncatedBatches: 1,
    });

    await reportMaintenanceFailureIssues([issue], {
      cfg: buildConfig(),
      pluginVersion: "test-version",
    });

    const context = capturePluginErrorSpy.mock.calls[0]?.[1];
    expect(context?.tags?.batch_failures).toBe(2);
    expect(context?.tags?.hard_batch_failures).toBe(1);
    expect(context?.tags?.truncated_batches).toBe(1);
    expect(context?.contexts?.maintenance?.batch_failures).toBe(2);
    expect(context?.contexts?.maintenance?.hard_batch_failures).toBe(1);
    expect(context?.contexts?.maintenance?.truncated_batches).toBe(1);
  });

  it("threads analyzer finding titles into tags and contexts (GlitchTip issue 24)", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    const capturePluginErrorSpy = vi.spyOn(errorReporterMock, "capturePluginError");
    vi.spyOn(errorReporterMock, "initErrorReporter").mockResolvedValue();
    vi.spyOn(errorReporterMock, "isErrorReporterActive").mockReturnValue(true);
    vi.spyOn(errorReporterMock, "flushErrorReporter").mockResolvedValue(true);

    const { reportMaintenanceFailureIssues } = await import("../services/maintenance-failure-reporter.js");

    const issue = buildMockIssue({
      jobName: "maintenance-log-analyzer",
      stepName: "analyze-maintenance-logs",
      failureCategory: "semantic_failure",
      failureClass: "analyze_maintenance_logs_strict_fail",
      findingTitles: ["distill:plugin-bug", "reflect:transient-llm"],
    });

    await reportMaintenanceFailureIssues([issue], {
      cfg: buildConfig(),
      pluginVersion: "test-version",
    });

    const context = capturePluginErrorSpy.mock.calls[0]?.[1];
    expect(context?.tags?.finding_titles).toBe("distill:plugin-bug, reflect:transient-llm");
    expect(context?.contexts?.maintenance?.finding_titles).toEqual(["distill:plugin-bug", "reflect:transient-llm"]);
  });

  it("does not mask original exit status on reporting failure", async () => {
    const errorReporterMock = await import("../services/error-reporter.js");
    vi.spyOn(errorReporterMock, "initErrorReporter").mockRejectedValue(new Error("Reporter init failed"));

    const { reportMaintenanceFailureIssues } = await import("../services/maintenance-failure-reporter.js");

    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    // Should not throw even if reporter fails
    await expect(
      reportMaintenanceFailureIssues([buildMockIssue()], {
        cfg: buildConfig(),
        pluginVersion: "test-version",
        logger: mockLogger,
      }),
    ).resolves.toBeUndefined();

    // Should log the failure
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("maintenance failure reporting skipped"));
  });
});
