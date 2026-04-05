/**
 * Goal stewardship circuit breaker — stop retrying when blockers do not change across assessments.
 * @see docs/GOAL-STEWARDSHIP-OPERATOR.md
 */

import type { GoalStewardshipCircuitBreakerConfig } from "../config/types/index.js";
import type { Goal } from "./goal-stewardship-types.js";

const SHORT_BLOCKER =
  "Circuit breaker: stewardship kept assessing without clearing blockers — human decision required.";

/** Stable fingerprint for sorted, trimmed blocker lines. */
export function blockerFingerprint(blockers: string[]): string | null {
  const sorted = [...blockers]
    .map((b) => b.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  if (sorted.length === 0) return null;
  return sorted.join("|");
}

export interface CircuitBreakerStatePatch {
  lastBlockerFingerprint: string | null;
  sameBlockerStreak: number;
  circuitBreakerLastProgressAssessmentCount: number;
}

export function computeCircuitBreakerStateAfterAssess(
  before: Goal,
  newBlockers: string[],
  newAssessmentCount: number,
): CircuitBreakerStatePatch {
  const fp = blockerFingerprint(newBlockers);
  const prevFp = before.lastBlockerFingerprint ?? null;
  const prevStreak = before.sameBlockerStreak ?? 0;
  const prevLastProg = before.circuitBreakerLastProgressAssessmentCount ?? 0;

  if (fp === null) {
    return {
      lastBlockerFingerprint: null,
      sameBlockerStreak: 0,
      circuitBreakerLastProgressAssessmentCount: newAssessmentCount,
    };
  }

  if (fp === prevFp) {
    return {
      lastBlockerFingerprint: fp,
      sameBlockerStreak: prevStreak + 1,
      circuitBreakerLastProgressAssessmentCount: prevLastProg,
    };
  }

  return {
    lastBlockerFingerprint: fp,
    sameBlockerStreak: 0,
    circuitBreakerLastProgressAssessmentCount: newAssessmentCount,
  };
}

export type CircuitBreakerTripReason = "same_blocker_streak" | "assessments_without_progress";

export function evaluateCircuitBreakerTrip(
  cfg: GoalStewardshipCircuitBreakerConfig,
  state: CircuitBreakerStatePatch,
  newAssessmentCount: number,
): { trip: false } | { trip: true; reason: CircuitBreakerTripReason } {
  if (!cfg.enabled) return { trip: false };
  if (state.lastBlockerFingerprint === null) return { trip: false };

  if (cfg.sameBlockerRepeatLimit > 0 && state.sameBlockerStreak >= cfg.sameBlockerRepeatLimit) {
    return { trip: true, reason: "same_blocker_streak" };
  }

  if (cfg.maxAssessmentsWithoutProgress > 0) {
    const since = newAssessmentCount - state.circuitBreakerLastProgressAssessmentCount;
    if (since >= cfg.maxAssessmentsWithoutProgress) {
      return { trip: true, reason: "assessments_without_progress" };
    }
  }

  return { trip: false };
}

export function composeCircuitBreakerHumanSummary(
  goal: Goal,
  reason: CircuitBreakerTripReason,
  cfg: GoalStewardshipCircuitBreakerConfig,
): string {
  const reasonLine =
    reason === "same_blocker_streak"
      ? `Same blocker fingerprint for ${goal.sameBlockerStreak ?? 0} consecutive assessments (threshold reached).`
      : `Assessments without blocker change: ${goal.assessmentCount - goal.circuitBreakerLastProgressAssessmentCount} (threshold ${cfg.maxAssessmentsWithoutProgress}).`;

  if (!cfg.composeHumanSummary) {
    return [
      `Circuit breaker — goal ${goal.label} (${goal.id})`,
      reasonLine,
      `Blockers: ${goal.currentBlockers.join("; ") || "(none)"}`,
      `Last assessment outcome: ${goal.lastOutcome ?? "(none)"}`,
    ].join("\n");
  }

  const lines: string[] = [
    "## Circuit breaker escalation",
    "",
    `**Goal:** ${goal.label} (${goal.id})`,
    `**Reason:** ${reasonLine}`,
    "",
    "**Description:**",
    goal.description.slice(0, 2000),
    "",
    "**Current blockers:**",
    ...(goal.currentBlockers.length > 0 ? goal.currentBlockers.map((b) => `- ${b}`) : ["- (none)"]),
    "",
    "**Acceptance criteria:**",
    ...goal.acceptanceCriteria.map((c) => `- ${c}`),
    "",
    "**Linked tasks:**",
    ...(goal.linkedTasks.length > 0
      ? goal.linkedTasks.map((t) => `- ${t.label}: ${t.status} (${t.sessionKey ?? "no session"})`)
      : ["- (none)"]),
    "",
    "**Recent stewardship history (last 15):**",
  ];

  const hist = (goal.history ?? []).slice(-15);
  for (const h of hist) {
    const d = h.detail.length > 400 ? `${h.detail.slice(0, 400)}…` : h.detail;
    lines.push(`- ${h.timestamp} [${h.actor}] ${h.action}: ${d}`);
  }

  lines.push("", "— Automated triage: stop autonomous retries; a human should unblock or abandon this goal.");

  return lines.join("\n");
}

export function circuitBreakerShortBlocker(reason: CircuitBreakerTripReason): string {
  if (reason === "same_blocker_streak") {
    return `${SHORT_BLOCKER} (same blockers across repeated assessments).`;
  }
  return `${SHORT_BLOCKER} (assessment budget for progress exhausted).`;
}
