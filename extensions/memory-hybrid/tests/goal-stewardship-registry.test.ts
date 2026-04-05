import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGoal, listGoals, readGoal, resolveGoalId, validateGoalLabel } from "../services/goal-registry.js";

const defaults = {
  maxDispatches: 5,
  maxAssessments: 10,
  cooldownMinutes: 5,
  escalateAfterFailures: 3,
  priority: "normal" as const,
};

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
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("createGoal, resolveGoalId by id and label, listGoals", async () => {
    dir = await mkdtemp(join(tmpdir(), "goals-"));
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

  it("readGoal normalizes legacy JSON without circuit-breaker fields", async () => {
    dir = await mkdtemp(join(tmpdir(), "goals-"));
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
});
