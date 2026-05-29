import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

const defaults = goalDefaults({ maxDispatches: 5, maxAssessments: 10, cooldownMinutes: 5 });

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
    await createGoal(dir, { label: "dup", description: "d", acceptanceCriteria: ["a"] }, defaults);
    await expect(
      createGoal(dir, { label: "dup", description: "d2", acceptanceCriteria: ["b"] }, defaults),
    ).rejects.toThrow(/already exists/);
  });

  it("createGoal recovers stale label lock directories", async () => {
    dir = await makeTempDir();
    const lockPath = join(dir, ".lock-label-stale-lock");
    await mkdir(lockPath);
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, stale, stale);
    const created = await createGoal(
      dir,
      { label: "stale-lock", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );
    expect(created.label).toBe("stale-lock");
  });

  it("does not evict stale lock when owner pid is alive", async () => {
    dir = await makeTempDir();
    const lockPath = join(dir, ".lock-label-held-lock");
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, acquiredAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }),
      "utf-8",
    );
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, stale, stale);

    const pending = createGoal(dir, { label: "held-lock", description: "d", acceptanceCriteria: ["a"] }, defaults);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(lockPath, { recursive: true, force: true });

    const created = await pending;
    expect(created.label).toBe("held-lock");
  });

  it("createGoal allows reuse of label after terminal goal", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "reuse", description: "d", acceptanceCriteria: ["a"] }, defaults);
    await terminateGoal(dir, g.id, "completed", "done", "user");
    const g2 = await createGoal(dir, { label: "reuse", description: "d2", acceptanceCriteria: ["b"] }, defaults);
    expect(g2.status).toBe("active");
    expect(g2.id).not.toBe(g.id);
  });

  it("listActiveGoals excludes terminal goals", async () => {
    dir = await makeTempDir();
    const g1 = await createGoal(dir, { label: "a1", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await createGoal(dir, { label: "a2", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await terminateGoal(dir, g1.id, "completed", "done", "user");
    const active = await listActiveGoals(dir);
    expect(active).toHaveLength(1);
    expect(active[0]?.label).toBe("a2");
  });

  it("updateGoal patches fields and appends history", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "upd", description: "d", acceptanceCriteria: ["c"] }, defaults);
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
        { timestamp: new Date().toISOString(), action: "t", detail: "d", actor: "user" },
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("terminateGoal sets status and appends history", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "term", description: "d", acceptanceCriteria: ["c"] }, defaults);
    const t = await terminateGoal(dir, g.id, "abandoned", "no longer needed", "user");
    expect(t.status).toBe("abandoned");
    expect(t.lastOutcome).toBe("no longer needed");
    expect(t.history.at(-1)?.action).toBe("abandoned");
  });

  it("rebuildGoalIndex survives corrupt JSON", async () => {
    dir = await makeTempDir();
    await createGoal(dir, { label: "ok", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await writeFile(join(dir, "corrupt.json"), "NOT JSON!", "utf-8");
    await rebuildGoalIndex(dir);
    const raw = JSON.parse(await readFile(join(dir, "_index.json"), "utf-8"));
    expect(raw.goals.length).toBe(1);
    expect(raw.goals[0].label).toBe("ok");
  });

  it("readGoal throws for corrupt goal JSON instead of returning null", async () => {
    dir = await makeTempDir();
    await writeFile(join(dir, "broken.json"), "{bad", "utf-8");
    await expect(readGoal(dir, "broken")).rejects.toThrow(/corrupt or unreadable/i);
  });

  it("listGoals skips corrupt goal JSON and continues processing healthy goals", async () => {
    dir = await makeTempDir();
    const healthy = await createGoal(dir, { label: "healthy", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await writeFile(join(dir, "broken.json"), "{bad", "utf-8");
    const listed = await listGoals(dir);
    expect(listed.map((g) => g.id)).toEqual([healthy.id]);
  });

  it("ignores housekeeping _*.json files during scans and still registers goals", async () => {
    dir = await makeTempDir();
    await writeFile(
      join(dir, "_global_dispatch_rate_limit.json"),
      JSON.stringify({ timestamps: [Date.now()], updatedAt: new Date().toISOString() }),
      "utf-8",
    );
    await writeFile(join(dir, "_future_housekeeping.json"), JSON.stringify({ state: "ok" }), "utf-8");
    const created = await createGoal(dir, { label: "with_housekeeping", description: "d", acceptanceCriteria: ["c"] }, defaults);
    const listed = await listGoals(dir);
    expect(listed.map((g) => g.id)).toEqual([created.id]);
    await expect(readGoalByLabel(dir, "with_housekeeping")).resolves.toMatchObject({ id: created.id });
  });

  it("rebuildGoalIndex excludes housekeeping _*.json files", async () => {
    dir = await makeTempDir();
    const created = await createGoal(dir, { label: "idx_housekeeping", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await writeFile(join(dir, "_global_dispatch_rate_limit.json"), JSON.stringify({ timestamps: [] }), "utf-8");
    await writeFile(join(dir, "_future_housekeeping.json"), JSON.stringify({ state: "ok" }), "utf-8");
    await rebuildGoalIndex(dir);
    const index = JSON.parse(await readFile(join(dir, "_index.json"), "utf-8")) as { goals: Array<{ id: string }> };
    expect(index.goals).toHaveLength(1);
    expect(index.goals[0]?.id).toBe(created.id);
  });

  it("readGoalByLabel stays safe when malformed goal json lacks label", async () => {
    dir = await makeTempDir();
    await writeFile(join(dir, "malformed.json"), JSON.stringify({ id: "malformed" }), "utf-8");
    await expect(readGoalByLabel(dir, "anything")).resolves.toBeNull();
  });

  it("listGoals and rebuildGoalIndex skip malformed goal json without label", async () => {
    dir = await makeTempDir();
    const healthy = await createGoal(dir, { label: "healthy_malformed", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await writeFile(join(dir, "malformed.json"), JSON.stringify({ id: "malformed" }), "utf-8");
    const listed = await listGoals(dir);
    expect(listed.map((g) => g.id)).toEqual([healthy.id]);
    await rebuildGoalIndex(dir);
    const index = JSON.parse(await readFile(join(dir, "_index.json"), "utf-8")) as { goals: Array<{ id: string }> };
    expect(index.goals).toHaveLength(1);
    expect(index.goals[0]?.id).toBe(healthy.id);
  });

  it("readGoalByLabel prefers active over terminal when labels collide", async () => {
    dir = await makeTempDir();
    const g1 = await createGoal(dir, { label: "pref", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await terminateGoal(dir, g1.id, "completed", "done", "user");
    const g2 = await createGoal(dir, { label: "pref", description: "d2", acceptanceCriteria: ["c2"] }, defaults);
    const found = await readGoalByLabel(dir, "pref");
    expect(found?.id).toBe(g2.id);
    expect(found?.status).toBe("active");
  });

  it("readGoalByLabel uses index and prefers active over terminal", async () => {
    dir = await makeTempDir();
    const g1 = await createGoal(dir, { label: "idx_pref", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await terminateGoal(dir, g1.id, "completed", "done", "user");
    const g2 = await createGoal(dir, { label: "idx_pref", description: "d2", acceptanceCriteria: ["c2"] }, defaults);
    const indexRaw = JSON.parse(await readFile(join(dir, "_index.json"), "utf-8"));
    expect(indexRaw.goals.some((x: { id: string }) => x.id === g1.id)).toBe(true);
    expect(indexRaw.goals.some((x: { id: string }) => x.id === g2.id)).toBe(true);
    const found = await readGoalByLabel(dir, "idx_pref");
    expect(found?.id).toBe(g2.id);
    expect(found?.status).toBe("active");
  });

  it("appendGoalHistory appends entry without changing other fields", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "hist_only", description: "d", acceptanceCriteria: ["c"] }, defaults);
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
    const g = await createGoal(dir, { label: "idx_match", description: "d", acceptanceCriteria: ["c"] }, defaults);
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
    const g = await createGoal(dir, { label: "rt", description: "round trip", acceptanceCriteria: ["done"] }, defaults);
    const r = await readGoal(dir, g.id);
    expect(r?.label).toBe("rt");
    await updateGoal(
      dir,
      g.id,
      { lastOutcome: "progress" },
      { timestamp: new Date().toISOString(), action: "upd", detail: "x", actor: "user" },
    );
    await terminateGoal(dir, g.id, "completed", "success", "agent");
    const all = await listGoals(dir);
    expect(all[0]?.status).toBe("completed");
    const active = await listActiveGoals(dir);
    expect(active).toHaveLength(0);
  });
});
