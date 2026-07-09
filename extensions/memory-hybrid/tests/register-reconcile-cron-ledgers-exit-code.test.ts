/**
 * Regression test (loop iteration 131) for cli/commands/manage/register-reconcile-cron-ledgers.ts:
 *
 * The whole purpose of `reconcile-cron-ledgers` is to catch cron runs falsely recorded as
 * `status:"ok"`. The action handler printed `False-OK runs found: N` but never converted a
 * nonzero `result.falseOk` into `process.exitCode` -- a CI/heartbeat script gating on the exit
 * code (the pattern this whole plugin uses everywhere else) never noticed the corruption the
 * command exists to detect, especially in --dry-run mode where result.corrected stays 0 by design.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconciliationResult } from "../services/cron-maintenance-reconciler.js";

const { reconcileAllCronRunLedgersMock } = vi.hoisted(() => ({
  reconcileAllCronRunLedgersMock: vi.fn<() => ReconciliationResult>(),
}));

vi.mock("../services/cron-maintenance-reconciler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/cron-maintenance-reconciler.js")>();
  return {
    ...actual,
    reconcileAllCronRunLedgers: reconcileAllCronRunLedgersMock,
  };
});

let cronRunsDir: string;
let logDir: string;

function makeProgram(): Command {
  const program = new Command("hybrid-mem");
  return program;
}

beforeEach(async () => {
  cronRunsDir = mkdtempSync(join(tmpdir(), "reconcile-cron-runs-"));
  logDir = mkdtempSync(join(tmpdir(), "reconcile-cron-logs-"));
  process.exitCode = undefined;
  reconcileAllCronRunLedgersMock.mockReset();
});

afterEach(() => {
  rmSync(cronRunsDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.resetModules();
});

describe("reconcile-cron-ledgers exit code (loop iteration 131 regression)", () => {
  it("sets process.exitCode when false-OK runs are found in --dry-run mode", async () => {
    reconcileAllCronRunLedgersMock.mockReturnValue({
      examined: 5,
      falseOk: 2,
      corrected: 0,
      corrections: [],
    });
    const { registerReconcileCronLedgers } = await import("../cli/commands/manage/register-reconcile-cron-ledgers.js");
    const program = makeProgram();
    program.exitOverride();
    registerReconcileCronLedgers(program as never);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(
      ["reconcile-cron-ledgers", "--cron-runs-dir", cronRunsDir, "--log-dir", logDir, "--dry-run", "--json"],
      { from: "user" },
    );

    expect(process.exitCode).toBe(1);
  });

  it("does not set process.exitCode when no false-OK runs are found", async () => {
    reconcileAllCronRunLedgersMock.mockReturnValue({
      examined: 5,
      falseOk: 0,
      corrected: 0,
      corrections: [],
    });
    const { registerReconcileCronLedgers } = await import("../cli/commands/manage/register-reconcile-cron-ledgers.js");
    const program = makeProgram();
    program.exitOverride();
    registerReconcileCronLedgers(program as never);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(
      ["reconcile-cron-ledgers", "--cron-runs-dir", cronRunsDir, "--log-dir", logDir, "--json"],
      { from: "user" },
    );

    expect(process.exitCode).toBeUndefined();
  });
});
