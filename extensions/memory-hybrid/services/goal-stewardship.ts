/**
 * Goal stewardship — barrel re-exports + global dispatch rate limit.
 * @see docs/GOAL-STEWARDSHIP-DESIGN.md
 */

import type { GoalStewardshipConfig } from "../config/types/index.js";
import type { GoalDefaults } from "./goal-stewardship-types.js";

export * from "./goal-stewardship-types.js";
export * from "./goal-registry.js";
export * from "./goal-health.js";
export * from "./goal-subagent.js";
export * from "./goal-stewardship-heartbeat.js";
export * from "./goal-active-task-mirror.js";
export * from "./goal-circuit-breaker.js";

const globalDispatchTimestamps: number[] = [];

export function recordGoalDispatch(): void {
  globalDispatchTimestamps.push(Date.now());
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (globalDispatchTimestamps.length > 0 && globalDispatchTimestamps[0]! < cutoff) {
    globalDispatchTimestamps.shift();
  }
}

export function isGlobalRateLimited(maxPerHour: number): boolean {
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (globalDispatchTimestamps.length > 0 && globalDispatchTimestamps[0]! < cutoff) {
    globalDispatchTimestamps.shift();
  }
  return globalDispatchTimestamps.length >= maxPerHour;
}

export function goalStewardshipDefaultsFromConfig(cfg: GoalStewardshipConfig): GoalDefaults {
  return {
    maxDispatches: cfg.defaults.maxDispatches,
    maxAssessments: cfg.defaults.maxAssessments,
    cooldownMinutes: cfg.defaults.cooldownMinutes,
    escalateAfterFailures: cfg.defaults.escalateAfterFailures,
    priority: cfg.defaults.priority,
  };
}
