/**
 * Goal Stewardship — shared types (docs/GOAL-STEWARDSHIP-DESIGN.md).
 */

export type GoalStatus = "active" | "blocked" | "stalled" | "verifying" | "completed" | "failed" | "abandoned";

export type GoalPriority = "critical" | "high" | "normal" | "low";

export type GoalVerificationType = "manual" | "file_exists" | "command_exit_zero" | "pr_merged" | "http_ok";

export interface GoalVerification {
  type: GoalVerificationType;
  target: string;
}

/** Last deterministic verification attempt by the watchdog (mechanical checks). */
export interface GoalLastMechanicalCheck {
  at: string;
  ok: boolean;
  detail: string;
}

export interface GoalLinkedTask {
  label: string;
  sessionKey: string | null;
  status: string;
  linkedAt: string;
  updatedAt: string;
}

export type GoalHistoryActor = "watchdog" | "steward" | "agent" | "user";

/** Set when the goal is blocked by automated escalation (circuit breaker vs subagent failure). */
export type GoalEscalationKind = "circuit_breaker";

export interface GoalHistoryEntry {
  timestamp: string;
  action: string;
  detail: string;
  actor: GoalHistoryActor;
}

export interface Goal {
  id: string;
  label: string;
  description: string;
  acceptanceCriteria: string[];
  verification?: GoalVerification;
  status: GoalStatus;
  priority: GoalPriority;
  createdAt: string;
  lastAssessedAt: string | null;
  lastDispatchedAt: string | null;
  assessmentCount: number;
  dispatchCount: number;
  currentBlockers: string[];
  lastOutcome: string | null;
  /** Populated when the watchdog runs a non-skipped mechanical verification (`file_exists`, `http_ok`, `command_exit_zero`, `pr_merged`). */
  lastMechanicalCheck?: GoalLastMechanicalCheck | null;
  maxDispatches: number;
  maxAssessments: number;
  cooldownMinutes: number;
  escalateAfterFailures: number;
  consecutiveFailures: number;
  /** Normalized fingerprint of `currentBlockers` for circuit-breaker progress detection. */
  lastBlockerFingerprint: string | null;
  /** Consecutive assessments with the same blocker fingerprint (non-empty blockers). */
  sameBlockerStreak: number;
  /** `assessmentCount` value when blockers last changed (progress). */
  circuitBreakerLastProgressAssessmentCount: number;
  /** Long-form human escalation text when circuit breaker trips. */
  humanEscalationSummary: string | null;
  escalationKind: GoalEscalationKind | null;
  linkedTasks: GoalLinkedTask[];
  history: GoalHistoryEntry[];
}

export interface GoalDefaults {
  maxDispatches: number;
  maxAssessments: number;
  cooldownMinutes: number;
  escalateAfterFailures: number;
  priority: GoalPriority;
}

export interface CreateGoalInput {
  label: string;
  description: string;
  acceptanceCriteria: string[];
  priority?: GoalPriority;
  verification?: GoalVerification;
  maxDispatches?: number;
  maxAssessments?: number;
  cooldownMinutes?: number;
  escalateAfterFailures?: number;
}

export interface GoalIndex {
  updatedAt: string;
  goals: Array<{
    id: string;
    label: string;
    status: GoalStatus;
    priority: GoalPriority;
    createdAt: string;
    lastAssessedAt: string | null;
  }>;
}
