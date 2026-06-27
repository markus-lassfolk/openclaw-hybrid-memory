import { describe, expect, it } from "vitest";
import { buildCompactActiveGoalsPrepend, buildLightweightStewardshipDirective } from "../services/goal-context-injection.js";
import type { Goal } from "../services/goal-stewardship-types.js";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "g-1",
    label: "deploy-api",
    description: "Deploy API to production",
    acceptanceCriteria: ["health check passes"],
    status: "active",
    priority: "high",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAssessedAt: null,
    lastDispatchedAt: null,
    assessmentCount: 0,
    dispatchCount: 0,
    currentBlockers: [],
    lastOutcome: null,
    maxDispatches: 5,
    maxAssessments: 10,
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
    ...overrides,
  };
}

describe("goal-context-injection", () => {
  it("builds compact prepend with goal_list hint", () => {
    const text = buildCompactActiveGoalsPrepend([makeGoal()], { maxChars: 2500, maxGoals: 5 });
    expect(text).toContain("<active-goals-summary>");
    expect(text).toContain("goal_list");
    expect(text).toContain("deploy-api");
  });

  it("prioritizes blocked goals in ordering", () => {
    const active = makeGoal({ id: "a", label: "zzzz-active-goal", status: "active", priority: "normal" });
    const blocked = makeGoal({
      id: "b",
      label: "aaaa-blocked-goal",
      status: "blocked",
      priority: "normal",
      currentBlockers: ["CI failing"],
    });
    const text = buildCompactActiveGoalsPrepend([active, blocked], { maxChars: 2500, maxGoals: 2 });
    expect(text?.indexOf("aaaa-blocked-goal")).toBeLessThan(text?.indexOf("zzzz-active-goal") ?? 999);
  });

  it("buildLightweightStewardshipDirective flags stale assessments", () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const directive = buildLightweightStewardshipDirective(
      [makeGoal({ lastAssessedAt: old, label: "stale-goal" })],
      24,
    );
    expect(directive).toContain("goal-stewardship-hint");
    expect(directive).toContain("stale-goal");
  });
});
