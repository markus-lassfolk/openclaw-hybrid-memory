import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendGoalHistory,
	createGoal,
	listActiveGoals,
	listGoals,
	readGoal,
	readGoalByLabel,
	rebuildGoalIndex,
	resolveGoalId,
	terminateGoal,
	updateGoal,
	validateGoalLabel,
} from "../services/goal-registry.js";
import { cleanDir, goalDefaults, makeTempDir } from "./helpers/goal-helpers.js";

const defaults = goalDefaults({
	maxDispatches: 5,
	maxAssessments: 10,
	cooldownMinutes: 5,
});

describe("validateGoalLabel", () => {
	it("rejects empty and invalid characters", () => {
		expect(validateGoalLabel("").ok).toBe(false);
		expect(validateGoalLabel("bad space").ok).toBe(false);
		expect(validateGoalLabel("a".repeat(65)).ok).toBe(false);
	});

	it("accepts alphanumeric underscore hyphen", () => {
		expect(validateGoalLabel("ship_feature-2").ok).toBe(true);
	});
});

describe("goal registry", () => {
	let dir: string;
	afterEach(async () => {
		await cleanDir(dir);
	});

	it("createGoal, resolveGoalId by id and label, listGoals", async () => {
		dir = await makeTempDir();
		const g = await createGoal(
			dir,
			{
				label: "ship_feature_x",
				description: "Ship the feature",
				acceptanceCriteria: ["tests green", "docs updated"],
			},
			defaults,
		);
		expect(g.status).toBe("active");
		const byId = await resolveGoalId(dir, g.id);
		expect(byId?.label).toBe("ship_feature_x");
		const byLabel = await resolveGoalId(dir, "SHIP_FEATURE_X");
		expect(byLabel?.id).toBe(g.id);
		const all = await listGoals(dir);
		expect(all).toHaveLength(1);
		expect(all[0]?.label).toBe("ship_feature_x");
	});

	it("readGoal returns null for missing id", async () => {
		dir = await makeTempDir();
		expect(await readGoal(dir, "nonexistent")).toBeNull();
	});

	it("readGoal normalizes legacy JSON without circuit-breaker fields", async () => {
		dir = await makeTempDir();
		const raw = {
			id: "legacy-id",
			label: "legacy_g",
			description: "d",
			acceptanceCriteria: ["a"],
			status: "active",
			priority: "normal",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastAssessedAt: null,
			lastDispatchedAt: null,
			assessmentCount: 0,
			dispatchCount: 0,
			currentBlockers: [],
			lastOutcome: null,
			maxDispatches: 5,
			maxAssessments: 10,
			cooldownMinutes: 5,
			escalateAfterFailures: 3,
			consecutiveFailures: 0,
			linkedTasks: [],
			history: [],
		};
		await writeFile(join(dir, "legacy-id.json"), JSON.stringify(raw), "utf-8");
		const g = await readGoal(dir, "legacy-id");
		expect(g?.sameBlockerStreak).toBe(0);
		expect(g?.lastBlockerFingerprint).toBeNull();
		expect(g?.humanEscalationSummary).toBeNull();
	});

	it("createGoal rejects invalid label", async () => {
		dir = await makeTempDir();
		await expect(
			createGoal(
				dir,
				{
					label: "bad label!",
					description: "d",
					acceptanceCriteria: ["a"],
				},
				defaults,
			),
		).rejects.toThrow(/alphanumeric/);
	});

	it("createGoal rejects duplicate active label", async () => {
		dir = await makeTempDir();
		await createGoal(
			dir,
			{ label: "dup", description: "d", acceptanceCriteria: ["a"] },
			defaults,
		);
		await expect(
			createGoal(
				dir,
				{ label: "dup", description: "d2", acceptanceCriteria: ["b"] },
				defaults,
			),
		).rejects.toThrow(/already exists/);
	});

	it("createGoal allows reuse of label after terminal goal", async () => {
		dir = await makeTempDir();
		const g = await createGoal(
			dir,
			{ label: "reuse", description: "d", acceptanceCriteria: ["a"] },
			defaults,
		);
		await terminateGoal(dir, g.id, "completed", "done", "user");
		const g2 = await createGoal(
			dir,
			{ label: "reuse", description: "d2", acceptanceCriteria: ["b"] },
			defaults,
		);
		expect(g2.status).toBe("active");
		expect(g2.id).not.toBe(g.id);
	});

	it("listActiveGoals excludes terminal goals", async () => {
		dir = await makeTempDir();
		const g1 = await createGoal(
			dir,
			{ label: "a1", description: "d", acceptanceCriteria: ["c"] },
			defaults,
		);
		await createGoal(
			dir,
			{ label: "a2", description: "d", acceptanceCriteria: ["c"] },
			defaults,
		);
		await terminateGoal(dir, g1.id, "completed", "done", "user");
		const active = await listActiveGoals(dir);
		expect(active).toHaveLength(1);
		expect(active[0]?.label).toBe("a2");
	});

	it("updateGoal patches fields and appends history", async () => {
		dir = await makeTempDir();
		const g = await createGoal(
			dir,
			{ label: "upd", description: "d", acceptanceCriteria: ["c"] },
			defaults,
		);
		const ts = new Date().toISOString();
		const updated = await updateGoal(
			dir,
			g.id,
			{ currentBlockers: ["b1"], lastOutcome: "stuck" },
			{ timestamp: ts, action: "test-update", detail: "manual", actor: "user" },
		);
		expect(updated.currentBlockers).toEqual(["b1"]);
		expect(updated.lastOutcome).toBe("stuck");
		expect(updated.history.length).toBe(g.history.length + 1);
		expect(updated.history.at(-1)?.action).toBe("test-update");
	});

	it("updateGoal throws for missing id", async () => {
		dir = await makeTempDir();
		await expect(
			updateGoal(
				dir,
				"missing",
				{ status: "blocked" },
				{
					timestamp: new Date().toISOString(),
					action: "t",
					detail: "d",
					actor: "user",
				},
			),
		).rejects.toThrow(/not found/i);
	});

	it("terminateGoal sets status and appends history", async () => {
		dir = await makeTempDir();
		const g = await createGoal(
			dir,
			{ label: "term", description: "d", acceptanceCriteria: ["c"] },
			defaults,
		);
		const t = await terminateGoal(
			dir,
			g.id,
			"abandoned",
			"no longer needed",
			"user",
		);
		expect(t.status).toBe("abandoned");
		expect(t.lastOutcome).toBe("no longer needed");
		expect(t.history.at(-1)?.action).toBe("abandoned");
	});

	it("rebuildGoalIndex survives corrupt JSON", async () => {
		dir = await makeTempDir();
		await createGoal(
			dir,
			{ label: "ok", description: "d", acceptanceCriteria: ["c"] },
			defaults,
		);
		await writeFile(join(dir, "corrupt.json"), "NOT JSON!", "utf-8");
		await rebuildGoalIndex(dir);
		const raw = JSON.parse(await readFile(join(dir, "_index.json"), "utf-8"));
		expect(raw.goals.length).toBe(1);
		expect(raw.goals[0].label).toBe("ok");
	});

	it("readGoalByLabel prefers active over terminal when labels collide", async () => {
		dir = await makeTempDir();
		const g1 = await createGoal(
			dir,
			{ label: "pref", description: "d", acceptanceCriteria: ["c"] },
			defaults,
		);
		await terminateGoal(dir, g1.id, "completed", "done", "user");
		const g2 = await createGoal(
			dir,
			{ label: "pref", description: "d2", acceptanceCriteria: ["c2"] },
			defaults,
		);
		const found = await readGoalByLabel(dir, "pref");
		expect(found?.id).toBe(g2.id);
		expect(found?.status).toBe("active");
	});

	it("readGoalByLabel uses index and prefers active over terminal", async () => {
		dir = await makeTempDir();
		const g1 = await createGoal(
			dir,
			{ label: "idx_pref", description: "d", acceptanceCriteria: ["c"] },
			defaults,
		);
		await terminateGoal(dir, g1.id, "completed", "done", "user");
		const g2 = await createGoal(
			dir,
			{ label: "idx_pref", description: "d2", acceptanceCriteria: ["c2"] },
			defaults,
		);
		const indexRaw = JSON.parse(
			await readFile(join(dir, "_index.json"), "utf-8"),
		);
		expect(indexRaw.goals.some((x: { id: string }) => x.id === g1.id)).toBe(
			true,
		);
		expect(indexRaw.goals.some((x: { id: string }) => x.id === g2.id)).toBe(
			true,
		);
		const found = await readGoalByLabel(dir, "idx_pref");
		expect(found?.id).toBe(g2.id);
		expect(found?.status).toBe("active");
	});

	it("appendGoalHistory appends entry without changing other fields", async () => {
		dir = await makeTempDir();
		const g = await createGoal(
			dir,
			{ label: "hist_only", description: "d", acceptanceCriteria: ["c"] },
			defaults,
		);
		const before = await readGoal(dir, g.id);
		const entry = {
			timestamp: new Date().toISOString(),
			action: "note",
			detail: "append-only",
			actor: "user" as const,
		};
		await appendGoalHistory(dir, g.id, entry);
		const after = await readGoal(dir, g.id);
		expect(after?.label).toBe(before?.label);
		expect(after?.description).toBe(before?.description);
		expect(after?.status).toBe(before?.status);
		expect(after?.acceptanceCriteria).toEqual(before?.acceptanceCriteria);
		expect(after?.currentBlockers).toEqual(before?.currentBlockers);
		expect(after?.history.length).toBe((before?.history.length ?? 0) + 1);
		expect(after?.history.at(-1)).toEqual(entry);
	});

	it("rebuildGoalIndex matches individual files after manual corruption", async () => {
		dir = await makeTempDir();
		const g = await createGoal(
			dir,
			{ label: "idx_match", description: "d", acceptanceCriteria: ["c"] },
			defaults,
		);
		await writeFile(join(dir, "_index.json"), "{ not valid json", "utf-8");
		await rebuildGoalIndex(dir);
		const fromFile = await readGoal(dir, g.id);
		const idx = JSON.parse(await readFile(join(dir, "_index.json"), "utf-8"));
		expect(idx.goals).toHaveLength(1);
		expect(idx.goals[0].id).toBe(g.id);
		expect(idx.goals[0].label).toBe(fromFile?.label);
		expect(idx.goals[0].status).toBe(fromFile?.status);
		expect(idx.goals[0].priority).toBe(fromFile?.priority);
		expect(idx.goals[0].createdAt).toBe(fromFile?.createdAt);
		expect(idx.goals[0].lastAssessedAt).toBe(fromFile?.lastAssessedAt);
	});

	it("round-trip: create → read → update → terminate → list", async () => {
		dir = await makeTempDir();
		const g = await createGoal(
			dir,
			{ label: "rt", description: "round trip", acceptanceCriteria: ["done"] },
			defaults,
		);
		const r = await readGoal(dir, g.id);
		expect(r?.label).toBe("rt");
		await updateGoal(
			dir,
			g.id,
			{ lastOutcome: "progress" },
			{
				timestamp: new Date().toISOString(),
				action: "upd",
				detail: "x",
				actor: "user",
			},
		);
		await terminateGoal(dir, g.id, "completed", "success", "agent");
		const all = await listGoals(dir);
		expect(all[0]?.status).toBe("completed");
		const active = await listActiveGoals(dir);
		expect(active).toHaveLength(0);
	});
});
