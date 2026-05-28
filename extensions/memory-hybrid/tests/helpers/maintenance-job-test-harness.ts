import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ExitValidationResult, validateMaintenanceExecution } from "../../services/cron-exit-validator.js";

const DEFAULT_STEP_TS = "2026-05-15T03:00:00Z";

export interface MaintenanceJobHarnessInput {
  requiredSteps: string[];
  allowSkip?: boolean;
  jobName?: string;
  exitRows?: string[];
  logLines?: string[];
  missingExitLedger?: boolean;
  applyGuardUpdate?: boolean;
  guardTimestampMs?: number;
}

export interface MaintenanceJobHarnessResult {
  root: string;
  exitPath: string;
  logPath: string;
  guardPath: string;
  validation: ExitValidationResult;
  guardWritten: boolean;
}

export function hmExitStepLine(input: {
  step: string;
  exitCode: number;
  status?: "ok" | "failed" | "skipped";
  reason?: string;
  durationMs?: number;
  timestamp?: string;
}): string {
  const timestamp = input.timestamp ?? DEFAULT_STEP_TS;
  const status = input.status ?? (input.exitCode === 0 ? "ok" : "failed");
  const reason = input.reason ?? (input.exitCode === 0 ? "ok" : "error");
  const durationMs = input.durationMs ?? 1;
  return `${timestamp} step=${input.step} exit=${input.exitCode} status=${status} reason=${reason} duration_ms=${durationMs}`;
}

export function runMaintenanceJobHarness(input: MaintenanceJobHarnessInput): MaintenanceJobHarnessResult {
  const root = mkdtempSync(join(tmpdir(), "hm-maintenance-job-harness-"));
  const jobName = input.jobName ?? "nightly-memory-sweep-20260515T030000Z-1";
  const logRoot = join(root, "logs", "cron-hybrid-mem", "20260515");
  mkdirSync(logRoot, { recursive: true });

  const exitPath = join(logRoot, `${jobName}.exit.txt`);
  const logPath = join(logRoot, `${jobName}.log`);
  const guardPath = join(root, "cron", "guard", `${jobName}.ms`);

  const rows = input.exitRows ?? [];
  const logs = input.logLines ?? [];
  if (!input.missingExitLedger) writeFileSync(exitPath, rows.length > 0 ? `${rows.join("\n")}\n` : "", "utf-8");
  writeFileSync(logPath, logs.length > 0 ? `${logs.join("\n")}\n` : "", "utf-8");

  const validation = validateMaintenanceExecution(exitPath, logPath, input.requiredSteps, input.allowSkip ?? false);

  if ((input.applyGuardUpdate ?? true) && validation.guardUpdated) {
    mkdirSync(dirname(guardPath), { recursive: true });
    writeFileSync(guardPath, `${input.guardTimestampMs ?? Date.UTC(2026, 4, 15, 3, 5, 0)}`, "utf-8");
  }

  return {
    root,
    exitPath,
    logPath,
    guardPath,
    validation,
    guardWritten: existsSync(guardPath),
  };
}
