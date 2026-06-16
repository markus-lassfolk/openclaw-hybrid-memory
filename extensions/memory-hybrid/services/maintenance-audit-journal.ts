/**
 * Maintenance audit journal (Issue #1913).
 */

import type { DatabaseSync } from "node:sqlite";

export type OrchestratorStepStatus =
  | "ok"
  | "skipped_guard"
  | "skipped_gate"
  | "skipped_dep"
  | "skipped_missing_runner"
  | "deferred"
  | "failed"
  | "rate_limited";

export type OrchestratorStepJournalInput = {
  name: string;
  status: OrchestratorStepStatus;
  summary: string;
  durationMs: number;
  jobRunId?: string;
  semanticOutcome?: string;
};

export type MaintenanceRunStatus =
  | "ran"
  | "skipped:quiet"
  | "skipped:rate"
  | "skipped:lease"
  | "failed";

export type MaintenanceRunInput = {
  job: string;
  status: MaintenanceRunStatus;
  itemsProcessed?: number;
  costEstimate?: number;
  costActual?: number;
  errorSummary?: string;
  metadata?: Record<string, unknown>;
};

/** Insert a maintenance run row; returns run id. */
export function insertMaintenanceRun(db: DatabaseSync, input: MaintenanceRunInput): number {
  const now = Math.floor(Date.now() / 1000);
  const endedAt = input.status === "ran" || input.status === "failed" ? now : null;
  const result = db
    .prepare(
      `INSERT INTO maintenance_runs (job, started_at, ended_at, status, items_processed, cost_estimate, cost_actual, error_summary, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.job,
      now,
      endedAt,
      input.status,
      input.itemsProcessed ?? null,
      input.costEstimate ?? null,
      input.costActual ?? null,
      input.errorSummary ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
  return Number(result.lastInsertRowid);
}

export type MaintenanceRunRow = {
  id: number;
  job: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  items_processed: number | null;
};

/** Last run per job name. */
export function getLastMaintenanceRuns(db: DatabaseSync, limit = 20): MaintenanceRunRow[] {
  return db
    .prepare(
      `SELECT id, job, started_at, ended_at, status, items_processed
       FROM maintenance_runs ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as MaintenanceRunRow[];
}

export function getLastRunForJob(db: DatabaseSync, job: string): MaintenanceRunRow | null {
  return (
    (db
      .prepare(
        `SELECT id, job, started_at, ended_at, status, items_processed
         FROM maintenance_runs WHERE job = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(job) as MaintenanceRunRow | undefined) ?? null
  );
}

/** Map orchestrator step outcome to journal status. */
export function mapStepToMaintenanceRunStatus(
  status: OrchestratorStepStatus,
  summary: string,
): MaintenanceRunStatus {
  if (status === "ok") return "ran";
  if (status === "failed") return "failed";
  if (status === "rate_limited") return "skipped:rate";
  const lower = summary.toLowerCase();
  if (lower.includes("lease")) return "skipped:lease";
  if (lower.includes("quiet") || lower.includes("rate")) return "skipped:quiet";
  return "skipped:quiet";
}

/** Record one orchestrator step attempt in maintenance_runs. */
export function recordMaintenanceStepRun(db: DatabaseSync, step: OrchestratorStepJournalInput): number {
  return insertMaintenanceRun(db, {
    job: step.name,
    status: mapStepToMaintenanceRunStatus(step.status, step.summary),
    itemsProcessed: step.status === "ok" ? 1 : undefined,
    errorSummary: step.status === "failed" || step.status === "rate_limited" ? step.summary : undefined,
    metadata: {
      durationMs: step.durationMs,
      orchestratorStatus: step.status,
      jobRunId: step.jobRunId,
      semanticOutcome: step.semanticOutcome,
    },
  });
}

/** Jobs not run in the last N hours (for doctor warning). */
export function getStaleMaintenanceJobs(db: DatabaseSync, hours = 48): string[] {
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  const jobs = db
    .prepare(`SELECT DISTINCT job FROM maintenance_runs`)
    .all() as Array<{ job: string }>;
  const stale: string[] = [];
  for (const { job } of jobs) {
    const last = getLastRunForJob(db, job);
    if (!last || last.started_at < cutoff) stale.push(job);
  }
  return stale;
}
