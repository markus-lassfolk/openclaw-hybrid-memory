import { describe, expect, it } from "vitest";
import type { GoalStewardshipCircuitBreakerConfig } from "../config/types/index.js";
import {
  blockerFingerprint,
  computeCircuitBreakerStateAfterAssess,
  evaluateCircuitBreakerTrip,
} from "../services/goal-circuit-breaker.js";
import type { Goal } from "../services/goal-stewardship-types.js";

function baseGoal(over: Partial<Goal> = {}): Goal {
  return {
    id: "id-1",
    label: "g1",
    description: "desc",
    acceptanceCriteria: ["c1"],
    status: "active",
    priority: "normal",
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

const cbOn: GoalStewardshipCircuitBreakerConfig = {
  enabled: true,
  sameBlockerRepeatLimit: 3,
  maxAssessmentsWithoutProgress: 0,
  composeHumanSummary: true,
  appendMemoryEscalation: true,
};

describe("goal-circuit-breaker", () => {
  it("blockerFingerprint is order-insensitive", () => {
    const a = blockerFingerprint(["Z", "a"]);
    const b = blockerFingerprint(["a", "z"]);
    expect(a).toBe(b);
  });

  it("trips on same blocker streak", () => {
    const b = ["blocked by api"];
    let g = baseGoal();
    // assessment 1
    let state = computeCircuitBreakerStateAfterAssess(g, b, 1);
    expect(state.sameBlockerStreak).toBe(1);
    g = { ...g, ...state, currentBlockers: b, assessmentCount: 1 };
    expect(evaluateCircuitBreakerTrip(cbOn, state, 1).trip).toBe(false);

    state = computeCircuitBreakerStateAfterAssess(g, b, 2);
    g = { ...g, ...state, assessmentCount: 2 };
    expect(state.sameBlockerStreak).toBe(2);
    expect(evaluateCircuitBreakerTrip(cbOn, state, 2).trip).toBe(false);

    state = computeCircuitBreakerStateAfterAssess(g, b, 3);
    expect(state.sameBlockerStreak).toBe(3);
    expect(evaluateCircuitBreakerTrip(cbOn, state, 3).trip).toBe(true);
  });

  it("resets streak when blockers change", () => {
    const g = baseGoal({
      lastBlockerFingerprint: blockerFingerprint(["a"]),
      sameBlockerStreak: 2,
      circuitBreakerLastProgressAssessmentCount: 1,
      assessmentCount: 2,
      currentBlockers: ["a"],
    });
    const state = computeCircuitBreakerStateAfterAssess(g, ["b"], 3);
    expect(state.sameBlockerStreak).toBe(1);
    expect(state.circuitBreakerLastProgressAssessmentCount).toBe(3);
  });

  it("trips on maxAssessmentsWithoutProgress", () => {
    const cfg: GoalStewardshipCircuitBreakerConfig = {
      enabled: true,
      sameBlockerRepeatLimit: 0,
      maxAssessmentsWithoutProgress: 4,
      composeHumanSummary: true,
      appendMemoryEscalation: false,
    };
    const b = ["x"];
    let g = baseGoal();
    let state = computeCircuitBreakerStateAfterAssess(g, b, 1);
    g = { ...g, ...state, currentBlockers: b, assessmentCount: 1 };
    expect(evaluateCircuitBreakerTrip(cfg, state, 1).trip).toBe(false);

    state = computeCircuitBreakerStateAfterAssess(g, b, 2);
    g = { ...g, ...state, assessmentCount: 2 };
    expect(evaluateCircuitBreakerTrip(cfg, state, 2).trip).toBe(false);

    state = computeCircuitBreakerStateAfterAssess(g, b, 3);
    g = { ...g, ...state, assessmentCount: 3 };
    expect(evaluateCircuitBreakerTrip(cfg, state, 3).trip).toBe(false);

    state = computeCircuitBreakerStateAfterAssess(g, b, 4);
    g = { ...g, ...state, assessmentCount: 4 };
    // since last progress at 1, delta = 3 — not yet
    expect(evaluateCircuitBreakerTrip(cfg, state, 4).trip).toBe(false);

    state = computeCircuitBreakerStateAfterAssess(g, b, 5);
    expect(evaluateCircuitBreakerTrip(cfg, state, 5).trip).toBe(true);
  });

  it("does not trip when disabled", () => {
    const state = {
      lastBlockerFingerprint: "x",
      sameBlockerStreak: 99,
      circuitBreakerLastProgressAssessmentCount: 0,
    };
    const cfg: GoalStewardshipCircuitBreakerConfig = { ...cbOn, enabled: false };
    expect(evaluateCircuitBreakerTrip(cfg, state, 10).trip).toBe(false);
  });
});
