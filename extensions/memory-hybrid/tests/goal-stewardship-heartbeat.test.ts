import { describe, expect, it } from "vitest";
import type { GoalStewardshipConfig } from "../config/types/index.js";
import { compileHeartbeatMatchers, matchesHeartbeat } from "../services/goal-stewardship-heartbeat.js";

function gs(partial: Partial<GoalStewardshipConfig>): GoalStewardshipConfig {
  return {
    enabled: true,
    goalsDir: "state/goals",
    model: null,
    heartbeatStewardship: true,
    watchdogHealthCheck: true,
    defaults: {
      maxDispatches: 20,
      maxAssessments: 50,
      cooldownMinutes: 10,
      escalateAfterFailures: 3,
      priority: "normal",
    },
    globalLimits: { maxDispatchesPerHour: 6, maxActiveGoals: 5 },
    heartbeatPatterns: [],
    attentionWeights: { critical: 4, high: 2, normal: 1, low: 0.5 },
    multiGoalMaxChars: 12_000,
    multiGoalMaxGoals: 8,
    heartbeatRefreshActiveTask: true,
    confirmationPolicy: { requireRegisterAckForPriorities: ["critical", "high"] },
    llmTriageOnHeartbeat: false,
    triageSuggestHeavyDirective: true,
    circuitBreaker: {
      enabled: false,
      sameBlockerRepeatLimit: 0,
      maxAssessmentsWithoutProgress: 0,
      composeHumanSummary: true,
      appendMemoryEscalation: true,
    },
    ...partial,
  };
}

describe("matchesHeartbeat", () => {
  it("matches default patterns", () => {
    expect(matchesHeartbeat("cron heartbeat check", gs({}))).toBe(true);
    expect(matchesHeartbeat("Scheduled ping from ops", gs({}))).toBe(true);
  });

  it("respects custom patterns only", () => {
    const cfg = gs({ heartbeatPatterns: ["ping"] });
    expect(matchesHeartbeat("server ping ok", cfg)).toBe(true);
    expect(matchesHeartbeat("nothing here", cfg)).toBe(false);
  });
});

describe("compileHeartbeatMatchers", () => {
  it("falls back when empty", () => {
    const m = compileHeartbeatMatchers([]);
    expect(m.length).toBeGreaterThan(0);
  });
});
