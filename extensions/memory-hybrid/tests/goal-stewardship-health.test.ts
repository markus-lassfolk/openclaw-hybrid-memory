import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GoalStewardshipConfig } from "../config/types/index.js";
import { runGoalHealthCheck } from "../services/goal-health.js";
import { createGoal, readGoal, updateGoal } from "../services/goal-registry.js";

const defaults = {
  maxDispatches: 20,
  maxAssessments: 50,
  cooldownMinutes: 10,
  escalateAfterFailures: 3,
  priority: "normal" as const,
};

function baseCfg(over: Partial<GoalStewardshipConfig> = {}): GoalStewardshipConfig {
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
    ...over,
  };
}

describe("runGoalHealthCheck", () => {
  let goalsDir: string | undefined;
  let workspaceRoot: string | undefined;

  afterEach(async () => {
    if (goalsDir) await rm(goalsDir, { recursive: true, force: true });
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    goalsDir = undefined;
    workspaceRoot = undefined;
  });

  it("returns no updates when stewardship is disabled", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    await createGoal(goalsDir, { label: "x", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg({ enabled: false }),
      workspaceRoot,
      logger: {},
    });
    expect(r.goalsChecked).toBe(0);
    expect(r.goalsUpdated).toBe(0);
  });

  it("returns no updates when watchdogHealthCheck is false", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    await createGoal(goalsDir, { label: "x", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg({ watchdogHealthCheck: false }),
      workspaceRoot,
      logger: {},
    });
    expect(r.goalsChecked).toBe(0);
  });

  it("blocks goal when dispatch budget is exhausted", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      {
        label: "budget_goal",
        description: "d",
        acceptanceCriteria: ["a"],
        maxDispatches: 1,
      },
      { ...defaults, maxDispatches: 1 },
    );
    await updateGoal(
      goalsDir,
      g.id,
      { dispatchCount: 1 },
      { timestamp: new Date().toISOString(), action: "test", detail: "fill", actor: "user" },
    );
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg(),
      workspaceRoot,
      logger: {},
    });
    expect(r.goalsChecked).toBeGreaterThanOrEqual(1);
    expect(r.actions.some((a) => a.action === "blocked")).toBe(true);
    const after = await readGoal(goalsDir, g.id);
    expect(after?.status).toBe("blocked");
  });

  it("marks goal stalled when idle past stale threshold", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const g = await createGoal(
      goalsDir,
      {
        label: "stale_goal",
        description: "d",
        acceptanceCriteria: ["a"],
        cooldownMinutes: 5,
      },
      { ...defaults, cooldownMinutes: 5 },
    );
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await updateGoal(
      goalsDir,
      g.id,
      { lastAssessedAt: old },
      { timestamp: new Date().toISOString(), action: "test", detail: "old activity", actor: "user" },
    );
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg(),
      workspaceRoot,
      logger: {},
    });
    expect(r.actions.some((a) => a.action === "stalled")).toBe(true);
    const after = await readGoal(goalsDir, g.id);
    expect(after?.status).toBe("stalled");
  });

  it("sets verifying when file_exists verification passes", async () => {
    goalsDir = await mkdtemp(join(tmpdir(), "gh-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "ws-"));
    const marker = join(workspaceRoot, "proof.txt");
    await writeFile(marker, "ok", "utf-8");
    await createGoal(
      goalsDir,
      {
        label: "verify_goal",
        description: "d",
        acceptanceCriteria: ["a"],
        verification: { type: "file_exists", target: "proof.txt" },
      },
      defaults,
    );
    const r = await runGoalHealthCheck({
      goalsDir,
      cfg: baseCfg(),
      workspaceRoot,
      logger: {},
    });
    expect(r.actions.some((a) => a.action === "verifying")).toBe(true);
  });
});
