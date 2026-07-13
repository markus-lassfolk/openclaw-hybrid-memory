/**
 * Maintenance audit journal (Issue #1913).
 */

import type { DatabaseSync } from "node:sqlite";
import { MAINTENANCE_STEPS } from "./maintenance-orchestrator.js";

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
  | "skipped:missing-runner"
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
export function mapStepToMaintenanceRunStatus(status: OrchestratorStepStatus, summary: string): MaintenanceRunStatus {
  if (status === "ok") {
    const lower = summary.toLowerCase();
    if (lower.includes("dry-run")) return "skipped:quiet";
    return "ran";
  }
  if (status === "failed") return "failed";
  if (status === "rate_limited") return "skipped:rate";
  // Distinct from routine "skipped:quiet" — a step with no registered runner is a persistent
  // misconfiguration, not benign cadence-gated skipping, and must not be indistinguishable from
  // it (QA follow-up: getStaleMaintenanceJobs below treats this status as always-flaggable,
  // regardless of how recently it was last "checked").
  if (status === "skipped_missing_runner") return "skipped:missing-runner";
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
  const monitored = new Set(MAINTENANCE_STEPS.map((step) => step.name));
  const stale: string[] = [];
  for (const job of monitored) {
    const last = getLastRunForJob(db, job);
    if (!last) continue;
    // A missing-runner step gets a fresh started_at on every orchestrator cycle even though it
    // never actually executes — recency alone can never surface it, so flag it unconditionally
    // (#2094 QA follow-up: cmd-doctor's "Maintenance health" check previously reported "pass"
    // indefinitely for a permanently unwired step).
    if (last.status === "skipped:missing-runner" || last.started_at < cutoff) stale.push(job);
  }
  return stale;
}
