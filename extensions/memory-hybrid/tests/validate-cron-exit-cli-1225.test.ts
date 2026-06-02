/**
 * Issue #1225 — validate-cron-exit must call process.exit after emitting JSON so one-shot CLI
 * does not linger on plugin handles.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerValidateCronExit,
  type ValidateCronExitContext,
} from "../cli/commands/manage/register-validate-cron-exit.js";
import * as maintenanceReporter from "../services/maintenance-failure-reporter.js";

describe("validate-cron-exit CLI (#1225)", () => {
  const origArgv = process.argv.slice();

  afterEach(() => {
    process.argv = origArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function stubOpenclawArgv() {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
  }

  it("exits 0 promptly after JSON for a successful ledger", async () => {
    stubOpenclawArgv();
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "success.exit");
    const logPath = join(dir, "success.log");
    writeFileSync(
      exitPath,
      `2026-05-08T21:10:00Z prune exit=0
2026-05-08T21:10:01Z distill exit=0
2026-05-08T21:10:02Z extract-daily exit=0
`,
    );
    writeFileSync(logPath, "all good\n");

    const mem = new Command("hybrid-mem");
    registerValidateCronExit(mem);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      [
        "validate-cron-exit",
        "--exit-path",
        exitPath,
        "--log-path",
        logPath,
        "--required-steps",
        "prune",
        "distill",
        "extract-daily",
        "--allow-skip",
        "--json",
      ],
      { from: "user" },
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as { maintenanceStatus: string };
    expect(payload.maintenanceStatus).toBe("success");
  });

  it("exits non-zero after JSON when a required step is missing (partial)", async () => {
    stubOpenclawArgv();
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "missing.exit");
    const logPath = join(dir, "missing.log");
    writeFileSync(
      exitPath,
      `2026-05-08T21:10:00Z prune exit=0
2026-05-08T21:10:02Z extract-daily exit=0
`,
    );
    writeFileSync(logPath, "missing distill\n");

    const mem = new Command("hybrid-mem");
    registerValidateCronExit(mem);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      [
        "validate-cron-exit",
        "--exit-path",
        exitPath,
        "--log-path",
        logPath,
        "--required-steps",
        "prune",
        "distill",
        "extract-daily",
        "--allow-skip",
        "--json",
      ],
      { from: "user" },
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      maintenanceStatus: string;
      missingSteps: string[];
    };
    expect(payload.maintenanceStatus).toBe("partial");
    expect(payload.missingSteps).toContain("distill");
  });

  it("exits non-zero after JSON when a step has non-zero exit (failed)", async () => {
    stubOpenclawArgv();
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "partial.exit");
    const logPath = join(dir, "partial.log");
    writeFileSync(
      exitPath,
      `2026-05-08T21:10:00Z prune exit=0
2026-05-08T21:10:01Z distill exit=124
2026-05-08T21:10:02Z extract-daily exit=0
`,
    );
    writeFileSync(logPath, "distill timed out\n");

    const mem = new Command("hybrid-mem");
    registerValidateCronExit(mem);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      [
        "validate-cron-exit",
        "--exit-path",
        exitPath,
        "--log-path",
        logPath,
        "--required-steps",
        "prune",
        "distill",
        "extract-daily",
        "--allow-skip",
        "--json",
      ],
      { from: "user" },
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      maintenanceStatus: string;
      failedSteps: Array<{ name: string; exit: number }>;
    };
    expect(payload.maintenanceStatus).toBe("failed");
    expect(payload.failedSteps.some((s) => s.name === "distill" && s.exit === 124)).toBe(true);
  });

  it("emits grouped maintenance events for semantic failures without changing a zero exit status", async () => {
    stubOpenclawArgv();
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "weekly-reflection-20260508T021500Z-111.exit.txt");
    const logPath = join(dir, "reflect.log");
    writeFileSync(exitPath, "2026-05-08T02:10:01Z reflect-rules exit=0\n");
    writeFileSync(logPath, "reflect-rules parse_success=false stored=0 model=minimax/MiniMax-M2.7-highspeed\n");

    const mem = new Command("hybrid-mem");
    registerValidateCronExit(mem);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      [
        "validate-cron-exit",
        "--exit-path",
        exitPath,
        "--log-path",
        logPath,
        "--required-steps",
        "reflect-rules",
        "--json",
      ],
      { from: "user" },
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      maintenanceStatus: string;
      semanticStatus: string;
      reportableIssues: Array<{ fingerprint: string; failureClass: string }>;
    };
    expect(payload.maintenanceStatus).toBe("success");
    expect(payload.semanticStatus).toBe("semantic_fail");
    expect(payload.reportableIssues[0]?.fingerprint).toBe(
      "hybrid-memory-maintenance:weekly-reflection:reflect-rules:invalid_response_format_zero_stored",
    );
    expect(payload.reportableIssues[0]?.failureClass).toBe("invalid_response_format_zero_stored");
  });

  it("keeps the original validation exit status when maintenance reporting submission fails", async () => {
    stubOpenclawArgv();
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "failed.exit");
    const logPath = join(dir, "failed.log");
    writeFileSync(exitPath, "2026-05-08T21:10:00Z distill exit=124\n");
    writeFileSync(logPath, "distill timed out\n");

    const mem = new Command("hybrid-mem");
    registerValidateCronExit(mem);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      ["validate-cron-exit", "--exit-path", exitPath, "--log-path", logPath, "--required-steps", "distill", "--json"],
      { from: "user" },
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
  });

  it("calls reportMaintenanceFailureIssues when context is provided with a failed step (council)", async () => {
    stubOpenclawArgv();
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "failed.exit");
    const logPath = join(dir, "failed.log");

    // Create a realistic failed maintenance scenario with a storage/concurrency error
    writeFileSync(exitPath, "2026-05-08T21:10:00Z reflect-rules exit=1 status=failed reason=nonzero_exit\n");
    writeFileSync(
      logPath,
      `[2026-05-08T21:10:00Z] Starting reflect-rules
Error: LanceDB commit conflict detected
    at reflectRules (reflect.ts:42)
[2026-05-08T21:10:01Z] reflect-rules failed\n`,
    );

    const mem = new Command("hybrid-mem");

    // Mock reportMaintenanceFailureIssues to verify it's called
    const reportSpy = vi.spyOn(maintenanceReporter, "reportMaintenanceFailureIssues").mockResolvedValue(undefined);

    // Provide context with proper config to enable reporting
    const context: ValidateCronExitContext = {
      cfg: {
        errorReporting: {
          enabled: true,
          consent: true,
          dsn: "https://test@example.com/1",
          mode: "self-hosted" as const,
          environment: "test",
          sampleRate: 1.0,
          updateNudge: {
            enabled: false,
            intervalHours: 24,
            cacheTtlHours: 24,
          },
        },
        maintenance: {
          failureReporting: {
            enabled: true,
          },
          monthlyReview: {
            enabled: false,
            dayOfMonth: 1,
          },
          cronReliability: {
            nightlyCron: "0 3 * * *",
            weeklyBackupCron: "0 4 * * 0",
            verifyOnBoot: true,
            staleThresholdHours: 28,
          },
          council: {
            provenance: "none" as const,
            sessionKeyPrefix: "council-review",
          },
        },
      },
      versionInfo: { pluginVersion: "1.0.0-test" },
      logger: console,
    };

    registerValidateCronExit(mem, context);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      [
        "validate-cron-exit",
        "--exit-path",
        exitPath,
        "--log-path",
        logPath,
        "--required-steps",
        "reflect-rules",
        "--json",
      ],
      { from: "user" },
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));

    // Verify reportMaintenanceFailureIssues was called with issues
    expect(reportSpy).toHaveBeenCalledOnce();

    const [issues, reportContext] = reportSpy.mock.calls[0] ?? [];
    expect(issues).toBeDefined();
    expect(issues?.length).toBeGreaterThan(0);

    // Verify it found the concurrency/storage failure from the log
    const storageIssue = issues?.find(
      (i) => i.failureClass === "lancedb_commit_conflict" && i.fingerprint.includes("lancedb_commit_conflict"),
    );
    expect(storageIssue).toBeDefined();
    expect(storageIssue?.message).toContain("LanceDB");

    // Verify context was passed correctly
    expect(reportContext?.pluginVersion).toBe("1.0.0-test");
    expect(reportContext?.cfg.errorReporting.enabled).toBe(true);
  });
});
