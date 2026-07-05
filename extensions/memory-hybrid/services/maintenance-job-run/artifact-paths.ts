import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatTimestampUtcFromMs } from "../../utils/dates.js";

const DEFAULT_LOG_ROOT = join(homedir(), ".openclaw", "logs", "cron-hybrid-mem");

export function resolveMaintenanceLogRoot(openclawDir?: string): string {
  if (openclawDir) return join(openclawDir, "logs", "cron-hybrid-mem");
  return DEFAULT_LOG_ROOT;
}

export function resolveRunDayDir(logRoot: string, startedAt: Date = new Date()): string {
  const day = formatTimestampUtcFromMs(startedAt.getTime()).slice(0, 10).replace(/-/g, "");
  const dir = join(logRoot, day);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveOrchestratorRunIdFromEnv(): string | undefined {
  return process.env.HM_RUN_ID?.trim() || process.env.HM_ORCHESTRATOR_RUN_ID?.trim() || undefined;
}

export function resolveOrchestratorJobFromEnv(): string | undefined {
  return process.env.HM_JOB?.trim() || undefined;
}

export function buildJobRunId(command: string, fingerprint: string): string {
  const safeCmd = command.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "");
  // Sanitize the fingerprint the same way as the command before truncating so raw separators
  // (colons, dots) and mid-token boolean truncation cannot produce misleading ids like
  // `job-distill-::14:fal` (#2024). Collapse non-alphanumeric runs to single dashes, then cap.
  const fp =
    fingerprint
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+/g, "")
      .slice(0, 16)
      .replace(/-+$/g, "") || "0";
  return `job-${safeCmd}-${fp}`;
}

export function resolveJobRunArtifactDir(opts: {
  logRoot?: string;
  openclawDir?: string;
  jobRunId: string;
  orchestratorRunId?: string;
  startedAt?: Date;
}): { runDayDir: string; jobRunDir: string } {
  const logRoot = opts.logRoot ?? resolveMaintenanceLogRoot(opts.openclawDir);
  const runDayDir = resolveRunDayDir(logRoot, opts.startedAt);
  const orchSegment = opts.orchestratorRunId ? `job-runs` : `job-runs-standalone`;
  const jobRunDir = join(runDayDir, orchSegment, opts.jobRunId);
  if (!existsSync(jobRunDir)) mkdirSync(jobRunDir, { recursive: true });
  return { runDayDir, jobRunDir };
}

export function buildOrchestratorSummaryPath(runDayDir: string, job: string, runId: string): string {
  return join(runDayDir, `${job}-${runId}.summary.json`);
}

export function buildOrchestratorValidationPath(runDayDir: string, job: string, runId: string): string {
  return join(runDayDir, `${job}-${runId}.validation.json`);
}
