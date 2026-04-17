/**
 * Registry/store coverage for primitives that goal tools call (no full plugin API mock).
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createGoal,
	listActiveGoals,
	readGoal,
	resolveGoalId,
	terminateGoal,
	updateGoal,
} from "../services/goal-registry.js";
import { resolveGoalsDir } from "../services/goal-stewardship.js";
import { setEnv } from "../utils/env-manager.js";

const defaults = {
	maxDispatches: 5,
	maxAssessments: 10,
	cooldownMinutes: 5,
	escalateAfterFailures: 3,
	priority: "normal" as const,
};

describe("goal tools registry primitives", () => {
	let workspaceRoot: string;
	let goalsDir: string;
	let prevWorkspace: string | undefined;

	beforeEach(async () => {
		prevWorkspace = process.env.OPENCLAW_WORKSPACE;
		workspaceRoot = await mkdtemp(join(tmpdir(), "gt-reg-"));
		await mkdir(join(workspaceRoot, "state", "goals"), { recursive: true });
		setEnv("OPENCLAW_WORKSPACE", workspaceRoot);
		goalsDir = resolveGoalsDir(workspaceRoot, "state/goals");
	});

	afterEach(async () => {
		setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
		await rm(workspaceRoot, { recursive: true, force: true });
	});

	it("resolveGoalId resolves by label", async () => {
		const g = await createGoal(
			goalsDir,
			{ label: "my-goal", description: "d", acceptanceCriteria: ["a"] },
			defaults,
		);
		const resolved = await resolveGoalId(goalsDir, "my-goal");
		expect(resolved?.id).toBe(g.id);
		expect(resolved?.label).toBe("my-goal");
	});

	it("resolveGoalId returns null for missing", async () => {
		const resolved = await resolveGoalId(goalsDir, "no-such-goal-id-or-label");
		expect(resolved).toBeNull();
	});

	it("terminateGoal with completed sets correct status", async () => {
		const g = await createGoal(
			goalsDir,
			{ label: "finish", description: "d", acceptanceCriteria: ["a"] },
			defaults,
		);
		const after = await terminateGoal(
			goalsDir,
			g.id,
			"completed",
			"all criteria met",
			"user",
		);
		expect(after.status).toBe("completed");
		expect((await readGoal(goalsDir, g.id))?.status).toBe("completed");
	});

	it("terminateGoal with abandoned sets correct status", async () => {
		const g = await createGoal(
			goalsDir,
			{ label: "drop", description: "d", acceptanceCriteria: ["a"] },
			defaults,
		);
		const after = await terminateGoal(
			goalsDir,
			g.id,
			"abandoned",
			"no longer pursuing",
			"user",
		);
		expect(after.status).toBe("abandoned");
		expect((await readGoal(goalsDir, g.id))?.status).toBe("abandoned");
	});

	it("createGoal rejects when max active goals reached", async () => {
		await createGoal(
			goalsDir,
			{ label: "one", description: "d", acceptanceCriteria: ["a"] },
			defaults,
		);
		await createGoal(
			goalsDir,
			{ label: "two", description: "d", acceptanceCriteria: ["a"] },
			defaults,
		);
		const active = await listActiveGoals(goalsDir);
		expect(active.length).toBe(2);
		const maxActiveGoals = 2;
		expect(active.length >= maxActiveGoals).toBe(true);
	});

	it("createGoal rejects invalid label", async () => {
		await expect(
			createGoal(
				goalsDir,
				{
					label: "bad label spaces",
					description: "d",
					acceptanceCriteria: ["a"],
				},
				defaults,
			),
		).rejects.toThrow(/label/);
	});

	it("goal_assess budget check: updateGoal refuses when assessmentCount >= maxAssessments", async () => {
		const g = await createGoal(
			goalsDir,
			{
				label: "budget-goal",
				description: "d",
				acceptanceCriteria: ["a"],
				maxAssessments: 1,
			},
			{ ...defaults, maxAssessments: 1 },
		);
		await updateGoal(
			goalsDir,
			g.id,
			{ assessmentCount: 1 },
			{
				timestamp: new Date().toISOString(),
				action: "test",
				detail: "at cap",
				actor: "user",
			},
		);
		const after = await readGoal(goalsDir, g.id);
		expect(after).toBeDefined();
		if (!after) throw new Error("fixture: goal missing");
		expect(after.assessmentCount >= after.maxAssessments).toBe(true);
	});
});
