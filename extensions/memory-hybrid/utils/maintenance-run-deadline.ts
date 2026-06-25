/**
 * Orchestrator-wide maintenance run deadline (Issue #1953 follow-up).
 * Set once per orchestrator run; long-running steps consult it to stop before overrunning maxRuntimeMinutes.
 */

const MAINTENANCE_RUN_DEADLINE_ENV = "HM_MAINTENANCE_RUN_DEADLINE_MS";

export function setMaintenanceRunDeadlineMs(deadlineMs: number | undefined): void {
  if (deadlineMs == null || !Number.isFinite(deadlineMs)) {
    delete process.env[MAINTENANCE_RUN_DEADLINE_ENV];
    return;
  }
  process.env[MAINTENANCE_RUN_DEADLINE_ENV] = String(Math.floor(deadlineMs));
}

export function clearMaintenanceRunDeadline(): void {
  delete process.env[MAINTENANCE_RUN_DEADLINE_ENV];
}

export function getMaintenanceRunDeadlineMs(): number | undefined {
  const raw = process.env[MAINTENANCE_RUN_DEADLINE_ENV]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function maintenanceRunDeadlineReached(nowMs: number = Date.now()): boolean {
  const deadline = getMaintenanceRunDeadlineMs();
  return deadline != null && nowMs >= deadline;
}

export function remainingMaintenanceRunMs(nowMs: number = Date.now()): number {
  const deadline = getMaintenanceRunDeadlineMs();
  if (deadline == null) return Number.POSITIVE_INFINITY;
  return Math.max(0, deadline - nowMs);
}

/** Cap a per-call timeout by the orchestrator run deadline when one is active. */
export function capTimeoutByMaintenanceRunDeadline(timeoutMs: number, nowMs: number = Date.now()): number {
  const remaining = remainingMaintenanceRunMs(nowMs);
  if (!Number.isFinite(remaining)) return timeoutMs;
  if (remaining <= 0) return 0;
  return Math.min(timeoutMs, Math.max(1, Math.floor(remaining)));
}

/** Earliest deadline from an explicit step budget and the orchestrator run deadline. */
export function resolveMaintenanceStepDeadlineMs(
  startedAtMs: number,
  stepBudgetSec: number | undefined,
): number | undefined {
  const stepDeadline =
    stepBudgetSec != null && stepBudgetSec > 0 ? startedAtMs + stepBudgetSec * 1000 : undefined;
  const runDeadline = getMaintenanceRunDeadlineMs();
  if (stepDeadline == null && runDeadline == null) return undefined;
  if (stepDeadline == null) return runDeadline;
  if (runDeadline == null) return stepDeadline;
  return Math.min(stepDeadline, runDeadline);
}
