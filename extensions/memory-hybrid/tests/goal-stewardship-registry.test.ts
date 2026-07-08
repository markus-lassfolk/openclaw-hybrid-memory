import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendGoalHistory,
  createGoal,
  listActiveGoals,
  listGoals,
  readGoal,
  readGoalByLabel,
  rebuildGoalIndex,
  repairAllQuarantinedGoals,
  repairQuarantinedGoalFile,
  resolveGoalId,
  resolveGoalIdResult,
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

  it("readGoal and readGoalByLabel resolve legacy label-based filenames (#1999)", async () => {
    dir = await makeTempDir();
    const goalId = "legacy-label-0001";
    const label = "legacy-label";
    await writeFile(
      join(dir, `${label}.json`),
      JSON.stringify({
        id: goalId,
        label,
        description: "legacy layout",
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
      }),
      "utf-8",
    );
    const byId = await readGoal(dir, goalId);
    expect(byId?.description).toBe("legacy layout");
    const byLabel = await readGoalByLabel(dir, label);
    expect(byLabel?.id).toBe(goalId);
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

  it("terminateGoal is a no-op when a concurrent call already terminated the goal (loop iteration 27 regression)", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "term_race", description: "d", acceptanceCriteria: ["c"] }, defaults);

    const first = await terminateGoal(dir, g.id, "completed", "shipped it", "agent");
    expect(first.status).toBe("completed");

    // Simulate a second terminate call racing in — e.g. goal_abandon reading the goal before
    // goal_complete's write landed, then reaching terminateGoal's own lock after it did.
    const second = await terminateGoal(dir, g.id, "abandoned", "changed my mind", "agent");

    // Must not flip an already-terminal goal to a different terminal status, and must not
    // append a second, contradictory history entry.
    expect(second.status).toBe("completed");
    expect(second.lastOutcome).toBe("shipped it");
    expect(second.history.filter((h) => h.action === "completed" || h.action === "abandoned")).toHaveLength(1);
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

  it("resolveGoalIdResult maps corrupt goal JSON to structured corrupt result (#1981)", async () => {
    dir = await makeTempDir();
    await writeFile(join(dir, "broken.json"), "{bad", "utf-8");
    const result = await resolveGoalIdResult(dir, "broken");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected corrupt result");
    expect(result.code).toBe("corrupt");
    expect(result.message).toMatch(/could not be loaded/i);
  });

  it("listGoals skips corrupt goal JSON and continues processing healthy goals", async () => {
    dir = await makeTempDir();
    const healthy = await createGoal(dir, { label: "healthy", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await writeFile(join(dir, "broken.json"), "{bad", "utf-8");
    const listed = await listGoals(dir);
    expect(listed.map((g) => g.id)).toEqual([healthy.id]);
    expect(existsSync(join(dir, "broken.json.corrupt"))).toBe(true);
    expect(existsSync(join(dir, "broken.json"))).toBe(false);
    const listedAgain = await listGoals(dir);
    expect(listedAgain.map((g) => g.id)).toEqual([healthy.id]);
  });

  it("still reports telemetry for a corrupt goal file when quarantine (rename) fails (#42)", async () => {
    dir = await makeTempDir();
    const errorReporter = await import("../services/error-reporter.js");
    const captureSpy = vi.spyOn(errorReporter, "capturePluginError").mockImplementation(() => undefined);
    try {
      await writeFile(join(dir, "broken.json"), "{bad", "utf-8");
      // Pre-create the quarantine destination so quarantineCorruptGoalFile's
      // `existsSync(destPath)` guard skips the rename entirely — deterministically simulating a
      // failed quarantine (e.g. a permissions or disk-full error on the real rename) without
      // needing to mock fs.rename.
      await writeFile(join(dir, "broken.json.corrupt"), "already here", "utf-8");

      await rebuildGoalIndex(dir);

      // Quarantine really did not happen — the source file is still present.
      expect(existsSync(join(dir, "broken.json"))).toBe(true);
      // Telemetry must still fire even though quarantine failed — previously this branch
      // returned before ever calling capturePluginError, so a persistently-corrupt file whose
      // quarantine keeps failing produced zero operator-visible signal.
      expect(captureSpy).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ operation: "invalid_goal_registry_entry", filename: "broken.json" }),
      );
    } finally {
      captureSpy.mockRestore();
    }
  });

  it("repairQuarantinedGoalFile restores valid quarantined goal JSON", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "repair_me", description: "d", acceptanceCriteria: ["c"] }, defaults);
    const activePath = join(dir, `${g.id}.json`);
    const corruptPath = join(dir, `${g.id}.json.corrupt`);
    await rename(activePath, corruptPath);
    const result = await repairQuarantinedGoalFile(dir, g.id);
    expect(result).toMatchObject({ ok: true, action: "restored" });
    expect(existsSync(activePath)).toBe(true);
    expect(existsSync(corruptPath)).toBe(false);
    expect((await readGoal(dir, g.id))?.label).toBe("repair_me");
  });

  it("repairQuarantinedGoalFile removes corrupt-report ledger entry (#1988)", async () => {
    dir = await makeTempDir();
    const g = await createGoal(dir, { label: "ledger_clear", description: "d", acceptanceCriteria: ["c"] }, defaults);
    await writeFile(join(dir, "broken.json"), "{bad", "utf-8");
    await listGoals(dir);
    const ledgerPath = join(dir, "_corrupt-reported.json");
    expect(existsSync(ledgerPath)).toBe(true);
    const ledgerBefore = JSON.parse(await readFile(ledgerPath, "utf-8")) as { keys: string[] };
    expect(ledgerBefore.keys.some((k) => k.endsWith("broken.json"))).toBe(true);

    const activePath = join(dir, `${g.id}.json`);
    const corruptPath = join(dir, `${g.id}.json.corrupt`);
    await rename(activePath, corruptPath);
    await repairQuarantinedGoalFile(dir, g.id);

    expect(existsSync(ledgerPath)).toBe(true);
    const ledgerAfter = JSON.parse(await readFile(ledgerPath, "utf-8")) as { keys: string[] };
    expect(ledgerAfter.keys.some((k) => k.endsWith(`${g.id}.json`))).toBe(false);
    expect(ledgerAfter.keys.some((k) => k.endsWith("broken.json"))).toBe(true);
  });

  it("repairAllQuarantinedGoals skips invalid quarantined JSON", async () => {
    dir = await makeTempDir();
    await writeFile(join(dir, "bad-id.json.corrupt"), "{not valid goal", "utf-8");
    const results = await repairAllQuarantinedGoals(dir);
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe("failed");
    expect(existsSync(join(dir, "bad-id.json.corrupt"))).toBe(true);
  });

  it("ignores housekeeping _*.json files during scans and still registers goals", async () => {
    dir = await makeTempDir();
    await writeFile(
      join(dir, "_global_dispatch_rate_limit.json"),
      JSON.stringify({ timestamps: [Date.now()], updatedAt: new Date().toISOString() }),
      "utf-8",
    );
    await writeFile(join(dir, "_future_housekeeping.json"), JSON.stringify({ state: "ok" }), "utf-8");
    const created = await createGoal(
      dir,
      { label: "with_housekeeping", description: "d", acceptanceCriteria: ["c"] },
      defaults,
    );
    const listed = await listGoals(dir);
    expect(listed.map((g) => g.id)).toEqual([created.id]);
    await expect(readGoalByLabel(dir, "with_housekeeping")).resolves.toMatchObject({ id: created.id });
  });

  it("rebuildGoalIndex excludes housekeeping _*.json files", async () => {
    dir = await makeTempDir();
    const created = await createGoal(
      dir,
      { label: "idx_housekeeping", description: "d", acceptanceCriteria: ["c"] },
      defaults,
    );
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

  it("readGoalByLabel falls back when index points to a malformed goal entry", async () => {
    dir = await makeTempDir();
    const healthy = await createGoal(
      dir,
      { label: "idx_fallback", description: "d", acceptanceCriteria: ["c"] },
      defaults,
    );
    const now = new Date().toISOString();
    await writeFile(
      join(dir, "_index.json"),
      JSON.stringify(
        {
          updatedAt: now,
          goals: [{ id: "malformed", label: "idx_fallback", status: "active", priority: "normal", createdAt: now }],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(join(dir, "malformed.json"), JSON.stringify({ id: "malformed" }), "utf-8");
    await expect(readGoalByLabel(dir, "idx_fallback")).resolves.toMatchObject({ id: healthy.id });
  });

  it("createGoal succeeds with _global_dispatch_rate_limit.json when stale index entries are malformed", async () => {
    dir = await makeTempDir();
    const now = new Date().toISOString();
    await writeFile(
      join(dir, "_global_dispatch_rate_limit.json"),
      JSON.stringify({ timestamps: [Date.now()], updatedAt: now }),
      "utf-8",
    );
    await writeFile(
      join(dir, "_index.json"),
      JSON.stringify(
        {
          updatedAt: now,
          goals: [
            { id: "malformed", label: "hybrid-memory-cron-qa", status: "active", priority: "high", createdAt: now },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(join(dir, "malformed.json"), JSON.stringify({ id: "malformed" }), "utf-8");

    await expect(
      createGoal(dir, { label: "hybrid-memory-cron-qa", description: "d", acceptanceCriteria: ["ship"] }, defaults),
    ).resolves.toMatchObject({ label: "hybrid-memory-cron-qa" });
  });

  it("listGoals and rebuildGoalIndex skip malformed goal json without label", async () => {
    dir = await makeTempDir();
    const healthy = await createGoal(
      dir,
      { label: "healthy_malformed", description: "d", acceptanceCriteria: ["c"] },
      defaults,
    );
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
