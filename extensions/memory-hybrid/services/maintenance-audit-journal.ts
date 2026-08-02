/**
 * Maintenance audit journal (Issue #1913).
 */

import type { DatabaseSync } from "node:sqlite";
import { hasStepRetryOncePending } from "./cron-guard.js";
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
    // skipped_missing_runner included alongside failed/rate_limited — otherwise the journal row
    // for a permanently unwired step carries only the bare status enum, with no free-text
    // explanation of which runner was missing for an operator to act on (QA follow-up).
    errorSummary:
      step.status === "failed" || step.status === "rate_limited" || step.status === "skipped_missing_runner"
        ? step.summary
        : undefined,
    metadata: {
      durationMs: step.durationMs,
      orchestratorStatus: step.status,
      jobRunId: step.jobRunId,
      semanticOutcome: step.semanticOutcome,
    },
  });
}

/** Default tolerance applied to each step's own guard cadence before it's considered stale. */
export const DEFAULT_STALE_GUARD_MULTIPLIER = 3;

/**
 * Jobs overdue relative to their own guard cadence (for doctor warning; issue #2108).
 *
 * Each `MAINTENANCE_STEPS` entry already carries its real expected cadence via `guardIntervalMs`
 * (from 1h for `prune` up to 5d for slow steps like `build-languages`). A single flat cutoff
 * applied to every step — the previous behavior — false-flags any long-cadence step as stale long
 * before it's actually overdue (a 5-day-cadence step is guaranteed to look "stale" under a 48h
 * cutoff), while `maintenance status`/`maintenance inventory` correctly judge health against the
 * `maintenance-nightly` orchestrator's own cadence. Comparing against each step's own cadence
 * (with `staleGuardMultiplier` tolerance for missed/gated cycles) keeps doctor's signal consistent
 * with the rest of the maintenance health model instead of contradicting it.
 */
export function getStaleMaintenanceJobs(
  db: DatabaseSync,
  staleGuardMultiplier = DEFAULT_STALE_GUARD_MULTIPLIER,
): string[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const monitored = new Map(MAINTENANCE_STEPS.map((step) => [step.name, step]));
  const stale: string[] = [];
  for (const step of monitored.values()) {
    const last = getLastRunForJob(db, step.name);
    if (!last) continue;
    // A missing-runner step gets a fresh started_at on every orchestrator cycle even though it
    // never actually executes — recency alone can never surface it, so flag it unconditionally
    // (#2094 QA follow-up: cmd-doctor's "Maintenance health" check previously reported "pass"
    // indefinitely for a permanently unwired step).
    if (last.status === "skipped:missing-runner") {
      stale.push(step.name);
      continue;
    }
    const cutoffSec = nowSec - (step.guardIntervalMs * staleGuardMultiplier) / 1000;
    if (last.started_at < cutoffSec) stale.push(step.name);
  }
  return stale;
}

// --- Cron-lane run outcome persistence (issue #2231) ---
//
// The functions above track individual *orchestrator step* attempts (e.g. "distill", "prune") from
// inside a single `maintenance-nightly` invocation. Everything below tracks the *cron lane* itself
// (e.g. "maintenance-nightly", "nightly-doctor-repair") — one row per `maintenance validate-exit`
// invocation, which every hybrid-mem cron job runs unconditionally at shell exit (see
// cron-job-bash-harness.ts's `hm_validate` trap). This gives `maintenance status` and friends a
// durable, local record of "last scheduled run" / "last successful run" per cron job, independent
// of whether GlitchTip telemetry (errorReporting.consent) is enabled — unlike
// services/maintenance-failure-reporter.ts's reportMaintenanceFailureIssues, this write is never
// gated on telemetry consent, since it is local bookkeeping, not external reporting.

/** Mirrors cron-job-bash-harness.ts's own `ledger_status` mapping in `hm_validate` (success -> ok,
 *  skipped -> skipped, partial -> failed, failed -> failed) so the locally persisted status agrees
 *  with what the bash harness itself already treats as pass/fail. */
export function mapMaintenanceCronStatusToRunStatus(
  maintenanceStatus: "success" | "skipped" | "partial" | "failed",
): MaintenanceRunStatus {
  if (maintenanceStatus === "success") return "ran";
  if (maintenanceStatus === "skipped") return "skipped:quiet";
  return "failed";
}

export type MaintenanceCronRetryStatus = "not_applicable" | "retry_pending" | "scheduled_retry";

/**
 * Derive a coarse "will this be retried" signal for a failed/partial cron-lane run.
 * - `not_applicable` — the run succeeded or was intentionally skipped; nothing to retry.
 * - `retry_pending` — at least one failing nested step already has a #2094 forced retry-once
 *   marker pending (set by `analyze-maintenance-logs --auto-fix`), so it will re-run outside its
 *   normal cadence guard on the very next orchestrator evaluation.
 * - `scheduled_retry` — no forced retry-once marker; the failure will only be retried on this
 *   cron lane's next regular schedule (these are recurring jobs, so there always is one).
 */
export function resolveMaintenanceCronRetryStatus(
  maintenanceStatus: "success" | "skipped" | "partial" | "failed",
  failingStepNames: string[],
  openclawDir?: string,
): MaintenanceCronRetryStatus {
  if (maintenanceStatus === "success" || maintenanceStatus === "skipped") return "not_applicable";
  const retryPending = failingStepNames.some((stepName) => hasStepRetryOncePending(stepName, openclawDir));
  return retryPending ? "retry_pending" : "scheduled_retry";
}

export interface MaintenanceCronRunOutcomeInput {
  /** Cron-lane job name, e.g. "maintenance-nightly", "nightly-doctor-repair" (matches HM_JOB / the
   *  cron job's `name` field — see extractMaintenanceJobName in cron-exit-validator.ts). */
  jobName: string;
  maintenanceStatus: "success" | "skipped" | "partial" | "failed";
  /** Short, templated diagnostic strings only (e.g. "job:step exited non-zero") — never raw
   *  log/prompt/tool payload. Matches the existing MaintenanceTelemetryIssue.message convention
   *  already considered safe for external GlitchTip transmission (services/cron-exit-validator.ts). */
  primaryFailure?: { stepName: string; failureClass: string; message: string };
  failingStepNames?: string[];
  openclawDir?: string;
}

/**
 * Persist a structured per-cron-lane run outcome: success/failure, phase (the first failing
 * nested step, if any), error class, timestamp, and retry status (issue #2231). Best-effort and
 * never gated on telemetry consent — a write failure here must never fail the cron job itself.
 */
export function recordMaintenanceCronRunOutcome(
  db: DatabaseSync | undefined,
  input: MaintenanceCronRunOutcomeInput,
): void {
  if (!db) return;
  try {
    const retryStatus = resolveMaintenanceCronRetryStatus(
      input.maintenanceStatus,
      input.failingStepNames ?? (input.primaryFailure ? [input.primaryFailure.stepName] : []),
      input.openclawDir,
    );
    insertMaintenanceRun(db, {
      job: input.jobName,
      status: mapMaintenanceCronStatusToRunStatus(input.maintenanceStatus),
      errorSummary: input.primaryFailure?.message,
      metadata: {
        kind: "cron-lane-run",
        maintenanceStatus: input.maintenanceStatus,
        phase: input.primaryFailure?.stepName,
        errorClass: input.primaryFailure?.failureClass,
        retryStatus,
      },
    });
  } catch {
    // Best-effort — never fail the cron job over a local audit-journal write issue.
  }
}

/** Most recent successful cron-lane run for a job (status "ran", i.e. maintenanceStatus="success"). */
export function getLastSuccessfulCronRun(db: DatabaseSync, jobName: string): MaintenanceRunRow | null {
  return (
    (db
      .prepare(
        `SELECT id, job, started_at, ended_at, status, items_processed
         FROM maintenance_runs WHERE job = ? AND status = 'ran' ORDER BY started_at DESC LIMIT 1`,
      )
      .get(jobName) as MaintenanceRunRow | undefined) ?? null
  );
}
