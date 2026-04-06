/**
 * Shared test helpers for goal stewardship tests.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoalStewardshipCircuitBreakerConfig, GoalStewardshipConfig } from "../../config/types/index.js";
import type { Goal, GoalDefaults, GoalPriority } from "../../services/goal-stewardship-types.js";

export const DEFAULT_GOAL_DEFAULTS: GoalDefaults = {
  maxDispatches: 20,
  maxAssessments: 50,
  cooldownMinutes: 10,
  escalateAfterFailures: 3,
  priority: "normal",
};

export function goalDefaults(over: Partial<GoalDefaults> = {}): GoalDefaults {
  return { ...DEFAULT_GOAL_DEFAULTS, ...over };
}

const defaultCB: GoalStewardshipCircuitBreakerConfig = {
  enabled: false,
  sameBlockerRepeatLimit: 0,
  maxAssessmentsWithoutProgress: 0,
  composeHumanSummary: true,
  appendMemoryEscalation: true,
};

export function baseGoalStewardshipConfig(over: Partial<GoalStewardshipConfig> = {}): GoalStewardshipConfig {
  return {
    enabled: true,
    goalsDir: "state/goals",
    model: null,
    heartbeatStewardship: true,
    watchdogHealthCheck: true,
    defaults: { ...DEFAULT_GOAL_DEFAULTS },
    globalLimits: { maxDispatchesPerHour: 6, maxActiveGoals: 5 },
    heartbeatPatterns: [],
    attentionWeights: { critical: 4, high: 2, normal: 1, low: 0.5 },
    multiGoalMaxChars: 12_000,
    multiGoalMaxGoals: 8,
    heartbeatRefreshActiveTask: true,
    confirmationPolicy: { requireRegisterAckForPriorities: ["critical", "high"] },
    llmTriageOnHeartbeat: false,
    triageSuggestHeavyDirective: true,
    escalationPolicy: { taskHygieneOnBlockedGoals: true },
    circuitBreaker: { ...defaultCB },
    allowCommandVerification: false,
    allowPrVerification: false,
    ...over,
  };
}

export function baseGoal(over: Partial<Goal> = {}): Goal {
  return {
    id: "test-id",
    label: "test-goal",
    description: "test desc",
    acceptanceCriteria: ["c1"],
    status: "active",
    priority: "normal" as GoalPriority,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAssessedAt: null,
    lastDispatchedAt: null,
    assessmentCount: 0,
    dispatchCount: 0,
    currentBlockers: [],
    lastOutcome: null,
    maxDispatches: 20,
    maxAssessments: 50,
    cooldownMinutes: 10,
    escalateAfterFailures: 3,
    consecutiveFailures: 0,
    lastBlockerFingerprint: null,
    sameBlockerStreak: 0,
    circuitBreakerLastProgressAssessmentCount: 0,
    humanEscalationSummary: null,
    escalationKind: null,
    linkedTasks: [],
    history: [],
    ...over,
  };
}

export async function makeTempDir(prefix = "goals-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanDir(dir: string | undefined): Promise<void> {
  if (dir) await rm(dir, { recursive: true, force: true });
}
