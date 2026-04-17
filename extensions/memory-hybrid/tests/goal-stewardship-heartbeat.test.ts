import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GoalStewardshipConfig } from "../config/types/index.js";
import {
	createGoal,
	listActiveGoals,
	updateGoal,
} from "../services/goal-registry.js";
import {
	buildMultiGoalStewardshipPrepend,
	compileHeartbeatMatchers,
	getCachedMatchers,
	heuristicNeedsHeavyAttention,
	matchesHeartbeat,
} from "../services/goal-stewardship-heartbeat.js";
import { goalDefaults } from "./helpers/goal-helpers.js";

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
		confirmationPolicy: {
			requireRegisterAckForPriorities: ["critical", "high"],
		},
		llmTriageOnHeartbeat: false,
		triageSuggestHeavyDirective: true,
		circuitBreaker: {
			enabled: false,
			sameBlockerRepeatLimit: 0,
			maxAssessmentsWithoutProgress: 0,
			composeHumanSummary: true,
			appendMemoryEscalation: true,
		},
		escalationPolicy: { taskHygieneOnBlockedGoals: true },
		allowCommandVerification: false,
		allowPrVerification: false,
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

describe("heartbeat integration", () => {
	it("matchesHeartbeat returns false for empty text", () => {
		expect(matchesHeartbeat("", gs({}))).toBe(false);
		expect(matchesHeartbeat("   ", gs({}))).toBe(false);
	});

	it("matchesHeartbeat returns false for non-heartbeat text", () => {
		expect(
			matchesHeartbeat("please review this PR when you have time", gs({})),
		).toBe(false);
	});

	it("matchesHeartbeat supports regex pattern /HEARTBEAT/i", () => {
		const cfg = gs({ heartbeatPatterns: ["/HEARTBEAT/i"] });
		expect(matchesHeartbeat("status: HEARTBEAT ok", cfg)).toBe(true);
		expect(matchesHeartbeat("no match here", cfg)).toBe(false);
	});

	it("getCachedMatchers caches results for same patterns", () => {
		const a = getCachedMatchers(["ping", "pong"]);
		const b = getCachedMatchers(["ping", "pong"]);
		expect(a).toBe(b);
		const c = getCachedMatchers(["different"]);
		expect(c).not.toBe(a);
	});
});

describe("buildMultiGoalStewardshipPrepend", () => {
	const defaults = goalDefaults();
	let goalsDir: string;

	afterEach(async () => {
		if (goalsDir) await rm(goalsDir, { recursive: true, force: true });
	});

	it("returns empty string when no active goals", async () => {
		goalsDir = await mkdtemp(join(tmpdir(), "hb-"));
		const goals = await listActiveGoals(goalsDir);
		const cfg = gs({});
		const result = await buildMultiGoalStewardshipPrepend(
			goalsDir,
			cfg,
			goals,
			{
				suggestHeavyDirective: false,
				triageHeavy: false,
			},
		);
		expect(result).toBeNull();
	});

	it("includes goal label in prepend when goal is past cooldown", async () => {
		goalsDir = await mkdtemp(join(tmpdir(), "hb-"));
		const g = await createGoal(
			goalsDir,
			{
				label: "hb-test",
				description: "test",
				acceptanceCriteria: ["done"],
				cooldownMinutes: 1,
			},
			{ ...defaults, cooldownMinutes: 1 },
		);
		const old = new Date(Date.now() - 10 * 60_000).toISOString();
		await updateGoal(
			goalsDir,
			g.id,
			{ lastAssessedAt: old },
			{
				timestamp: new Date().toISOString(),
				action: "t",
				detail: "d",
				actor: "user",
			},
		);
		const goals = await listActiveGoals(goalsDir);
		const result = await buildMultiGoalStewardshipPrepend(
			goalsDir,
			gs({}),
			goals,
			{
				suggestHeavyDirective: false,
				triageHeavy: false,
			},
		);
		expect(result).not.toBeNull();
		expect(result!.prepend).toContain("hb-test");
	});

	it("skips goals still in cooldown", async () => {
		goalsDir = await mkdtemp(join(tmpdir(), "hb-"));
		const g = await createGoal(
			goalsDir,
			{
				label: "cool-test",
				description: "test",
				acceptanceCriteria: ["done"],
				cooldownMinutes: 999,
			},
			{ ...defaults, cooldownMinutes: 999 },
		);
		await updateGoal(
			goalsDir,
			g.id,
			{ lastAssessedAt: new Date().toISOString() },
			{
				timestamp: new Date().toISOString(),
				action: "t",
				detail: "d",
				actor: "user",
			},
		);
		const goals = await listActiveGoals(goalsDir);
		const result = await buildMultiGoalStewardshipPrepend(
			goalsDir,
			gs({}),
			goals,
			{
				suggestHeavyDirective: false,
				triageHeavy: false,
			},
		);
		expect(result).toBeNull();
	});

	it("selects critical goals before normal", async () => {
		goalsDir = await mkdtemp(join(tmpdir(), "hb-"));
		const old = new Date(Date.now() - 60 * 60_000).toISOString();
		const g1 = await createGoal(
			goalsDir,
			{
				label: "low-pri",
				description: "d",
				acceptanceCriteria: ["c"],
				priority: "low",
				cooldownMinutes: 1,
			},
			{ ...defaults, cooldownMinutes: 1 },
		);
		await updateGoal(
			goalsDir,
			g1.id,
			{ lastAssessedAt: old },
			{
				timestamp: new Date().toISOString(),
				action: "t",
				detail: "d",
				actor: "user",
			},
		);
		const g2 = await createGoal(
			goalsDir,
			{
				label: "crit-pri",
				description: "d",
				acceptanceCriteria: ["c"],
				priority: "critical",
				cooldownMinutes: 1,
			},
			{ ...defaults, cooldownMinutes: 1 },
		);
		await updateGoal(
			goalsDir,
			g2.id,
			{ lastAssessedAt: old },
			{
				timestamp: new Date().toISOString(),
				action: "t",
				detail: "d",
				actor: "user",
			},
		);
		const goals = await listActiveGoals(goalsDir);
		const cfg = gs({ multiGoalMaxGoals: 1 });
		const result = await buildMultiGoalStewardshipPrepend(
			goalsDir,
			cfg,
			goals,
			{
				suggestHeavyDirective: false,
				triageHeavy: false,
			},
		);
		expect(result).not.toBeNull();
		expect(result!.prepend).toContain("crit-pri");
	});
});

describe("heuristicNeedsHeavyAttention", () => {
	it("returns true when a goal has consecutive failures", () => {
		const goals = [
			{ consecutiveFailures: 2, currentBlockers: [], status: "active" },
		] as any;
		expect(heuristicNeedsHeavyAttention(goals)).toBe(true);
	});

	it("returns false for clean goals", () => {
		const goals = [
			{ consecutiveFailures: 0, currentBlockers: [], status: "active" },
		] as any;
		expect(heuristicNeedsHeavyAttention(goals)).toBe(false);
	});
});
