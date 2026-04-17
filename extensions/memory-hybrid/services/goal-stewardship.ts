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

function pruneOldTimestamps(): void {
	const cutoff = Date.now() - 60 * 60 * 1000;
	let firstValid = 0;
	while (
		firstValid < globalDispatchTimestamps.length &&
		globalDispatchTimestamps[firstValid]! < cutoff
	) {
		firstValid++;
	}
	if (firstValid > 0) {
		globalDispatchTimestamps.splice(0, firstValid);
	}
}

export function recordGoalDispatch(): void {
	pruneOldTimestamps();
	globalDispatchTimestamps.push(Date.now());
}

export function isGlobalRateLimited(maxPerHour: number): boolean {
	pruneOldTimestamps();
	return globalDispatchTimestamps.length >= maxPerHour;
}

export function goalStewardshipDefaultsFromConfig(
	cfg: GoalStewardshipConfig,
): GoalDefaults {
	return {
		maxDispatches: cfg.defaults.maxDispatches,
		maxAssessments: cfg.defaults.maxAssessments,
		cooldownMinutes: cfg.defaults.cooldownMinutes,
		escalateAfterFailures: cfg.defaults.escalateAfterFailures,
		priority: cfg.defaults.priority,
	};
}
