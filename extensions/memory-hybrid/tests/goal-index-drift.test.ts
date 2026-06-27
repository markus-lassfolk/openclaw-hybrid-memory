import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomicWrite from "../utils/atomic-write.js";
import {
  auditGoalIndexDrift,
  createGoal,
  readGoal,
  readGoalByLabel,
  rebuildGoalIndex,
  updateGoal,
} from "../services/goal-registry.js";
import { cleanDir, goalDefaults, makeTempDir } from "./helpers/goal-helpers.js";

const defaults = goalDefaults({ maxDispatches: 5, maxAssessments: 10, cooldownMinutes: 5 });

describe("goal index drift (#1987)", () => {
  let dir: string;
  afterEach(async () => {
    await cleanDir(dir);
  });

  it("auditGoalIndexDrift reports missing index entry for valid goal file", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "drift_missing", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await writeFile(join(dir, "_index.json"), JSON.stringify({ updatedAt: "2026-01-01T00:00:00.000Z", goals: [] }), "utf-8");

    const drift = await auditGoalIndexDrift(dir);
    expect(drift.missingInIndex).toContain(g.id);
    expect(drift.orphanInIndex).toEqual([]);
  });

  it("auditGoalIndexDrift reports orphan index entry when goal file removed", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "drift_orphan", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await writeFile(
      join(dir, "_index.json"),
      JSON.stringify({
        updatedAt: "2026-01-01T00:00:00.000Z",
        goals: [
          { id: g.id, label: g.label, status: g.status, priority: g.priority, createdAt: g.createdAt, lastAssessedAt: null },
          { id: "ghost-id", label: "ghost", status: "active", priority: "normal", createdAt: g.createdAt, lastAssessedAt: null },
        ],
      }),
      "utf-8",
    );

    const drift = await auditGoalIndexDrift(dir);
    expect(drift.orphanInIndex).toContain("ghost-id");
  });

  it("auditGoalIndexDrift reports stale status when index disagrees with file", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "drift_stale", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await updateGoal(dir, g.id, { status: "stalled" }, "user");

    await writeFile(
      join(dir, "_index.json"),
      JSON.stringify({
        updatedAt: "2026-01-01T00:00:00.000Z",
        goals: [
          {
            id: g.id,
            label: g.label,
            status: "active",
            priority: g.priority,
            createdAt: g.createdAt,
            lastAssessedAt: null,
          },
        ],
      }),
      "utf-8",
    );

    const drift = await auditGoalIndexDrift(dir);
    expect(drift.staleFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: g.id, field: "status", indexValue: "active", fileValue: "stalled" }),
      ]),
    );
  });

  it("rebuildGoalIndex restores index after manual repair without mutating goal body", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "idx_rebuild", description: "original", acceptanceCriteria: ["c"] }, defaults);
    await writeFile(join(dir, "_index.json"), "{ broken", "utf-8");

    await rebuildGoalIndex(dir);
    const index = JSON.parse(await readFile(join(dir, "_index.json"), "utf-8")) as { goals: Array<{ id: string }> };
    expect(index.goals.map((x) => x.id)).toEqual([g.id]);
    const body = await readGoal(dir, g.id);
    expect(body?.description).toBe("original");
  });

  it("auditGoalIndexDrift does not false-positive when filename stem differs from goal.id (#1999)", async () => {
    dir = await makeTempDir();
    const goalId = "smart-pool-qa-code-review-0001";
    const label = "smart-pool-qa-code-review";
    await writeFile(
      join(dir, `${label}.json`),
      JSON.stringify({
        id: goalId,
        label,
        description: "d",
        acceptanceCriteria: ["c"],
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
      }),
      "utf-8",
    );
    await writeFile(
      join(dir, "_index.json"),
      JSON.stringify({
        updatedAt: "2026-01-01T00:00:00.000Z",
        goals: [
          {
            id: goalId,
            label,
            status: "active",
            priority: "normal",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastAssessedAt: null,
          },
        ],
      }),
      "utf-8",
    );

    const drift = await auditGoalIndexDrift(dir);
    expect(drift.missingInIndex).toEqual([]);
    expect(drift.orphanInIndex).toEqual([]);
    expect(drift.staleFields).toEqual([]);
    expect(await readGoal(dir, goalId)).toMatchObject({ label });
  });
});

describe("goal atomic write (#1986)", () => {
  let dir: string;
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanDir(dir);
  });

  it("updateGoal leaves original file intact when atomic rename fails", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "atomic_fail", description: "before", acceptanceCriteria: ["c"] }, defaults);
    const goalPath = join(dir, `${g.id}.json`);
    const before = await readFile(goalPath, "utf-8");

    vi.spyOn(atomicWrite, "atomicWriteFile").mockImplementation(() => {
      throw new Error("simulated rename failure");
    });

    await expect(updateGoal(dir, g.id, { description: "after" }, "user")).rejects.toThrow("simulated rename failure");
    const after = await readFile(goalPath, "utf-8");
    expect(after).toBe(before);
    expect(await readGoal(dir, g.id)).toMatchObject({ description: "before" });
  });
});
