import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { hmExitStepLine, runMaintenanceJobHarness } from "./helpers/maintenance-job-test-harness.js";

const harnessRoots: string[] = [];

afterEach(() => {
  while (harnessRoots.length > 0) {
    const root = harnessRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function runHarness(
  input: Parameters<typeof runMaintenanceJobHarness>[0],
): ReturnType<typeof runMaintenanceJobHarness> {
  const run = runMaintenanceJobHarness(input);
  harnessRoots.push(run.root);
  return run;
}

describe("maintenance job harness fixture", () => {
  it("models wrapper success and writes guard only after semantic validation succeeds", () => {
    const run = runHarness({
      requiredSteps: ["prune", "distill"],
      exitRows: [hmExitStepLine({ step: "prune", exitCode: 0 }), hmExitStepLine({ step: "distill", exitCode: 0 })],
      logLines: ["--- validate-cron-exit ---", '{"maintenanceStatus":"success"}'],
    });

    expect(run.validation.maintenanceStatus).toBe("success");
    expect(run.validation.guardUpdated).toBe(true);
    expect(run.guardWritten).toBe(true);
  });

  it("models skip/cooldown semantics as explicit skipped status with no guard update", () => {
    const run = runHarness({
      requiredSteps: ["reflect", "reflect-rules"],
      exitRows: [],
      logLines: ["reflection.enabled is false in hybrid-memory config. Job was skipped per preamble."],
    });

    expect(run.validation.maintenanceStatus).toBe("skipped");
    expect(run.validation.guardUpdated).toBe(false);
    expect(run.guardWritten).toBe(false);
  });

  it("models missing HM_EXIT ledger as failed_missing_ledger and blocks guard update", () => {
    const run = runHarness({
      requiredSteps: ["prune"],
      missingExitLedger: true,
      logLines: ["run started"],
    });

    expect(run.validation.maintenanceStatus).toBe("failed");
    expect(run.validation.error).toContain("Exit ledger not found");
    expect(run.validation.guardUpdated).toBe(false);
    expect(run.guardWritten).toBe(false);
  });

  it("models timeout failures as semantic maintenance failures", () => {
    const run = runHarness({
      requiredSteps: ["distill"],
      exitRows: [hmExitStepLine({ step: "distill", exitCode: 124, reason: "timeout", durationMs: 60000 })],
      logLines: ["timeout 124 killed after 60s"],
    });

    expect(run.validation.maintenanceStatus).toBe("failed");
    expect(run.validation.failedSteps).toHaveLength(1);
    expect(run.validation.failedSteps[0]?.step).toBe("distill");
    expect(run.validation.failedSteps[0]?.exitCode).toBe(124);
    expect(run.validation.guardUpdated).toBe(false);
    expect(run.guardWritten).toBe(false);
  });

  it("models failed-step semantics and keeps guard update disabled", () => {
    const run = runHarness({
      requiredSteps: ["prune", "distill"],
      exitRows: [
        hmExitStepLine({ step: "prune", exitCode: 0 }),
        hmExitStepLine({ step: "distill", exitCode: 1, reason: "inner_command_failed" }),
      ],
      logLines: ["distill failed"],
    });

    expect(run.validation.maintenanceStatus).toBe("failed");
    expect(run.validation.failedSteps).toHaveLength(1);
    expect(run.validation.failedSteps[0]?.step).toBe("distill");
    expect(run.validation.guardUpdated).toBe(false);
    expect(run.guardWritten).toBe(false);
  });

  it("models monthly-consolidation stopping before enrich-entities after reembed-vectorless provider failure", () => {
    const run = runHarness({
      requiredSteps: ["consolidate", "build-languages", "backfill-decay", "reembed-vectorless", "enrich-entities"],
      jobName: "monthly-consolidation-20260529T162810Z-10883",
      exitRows: [
        hmExitStepLine({ step: "consolidate", exitCode: 0 }),
        hmExitStepLine({ step: "build-languages", exitCode: 0 }),
        hmExitStepLine({ step: "backfill-decay", exitCode: 0 }),
        hmExitStepLine({ step: "reembed-vectorless", exitCode: 1, reason: "failed_embedding_provider_5xx" }),
      ],
      logLines: ['{"maintenanceStatus":"failed","guardUpdated":false}'],
    });

    expect(run.validation.maintenanceStatus).toBe("failed");
    expect(run.validation.missingSteps).toEqual(["enrich-entities"]);
    expect(run.validation.failedSteps).toHaveLength(1);
    expect(run.validation.failedSteps[0]?.step).toBe("reembed-vectorless");
    expect(run.validation.failedSteps[0]?.exitCode).toBe(1);
    expect(run.validation.failedSteps[0]?.failureReason).toBe("failed_embedding_provider_5xx");
    expect(run.validation.error).toContain("Missing steps: enrich-entities");
    expect(run.validation.error).toContain("Failed steps: reembed-vectorless (exit=1 failed_embedding_provider_5xx)");
    expect(run.validation.guardUpdated).toBe(false);
    expect(run.guardWritten).toBe(false);
  });
});
