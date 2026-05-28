/**
 * Integration-style tests for goal stewardship lifecycle hooks using a mock plugin API.
 * No OpenClaw core required — exercises registerGoalStewardshipInjection + registerGoalSubagentHandlers.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { registerGoalStewardshipInjection } from "../lifecycle/stage-goal-stewardship.js";
import { registerGoalSubagentHandlers } from "../lifecycle/stage-goal-subagent.js";
import type { LifecycleContext } from "../lifecycle/types.js";
import { createGoal, listGoals, readGoal, updateGoal } from "../services/goal-registry.js";
import { resolveGoalsDir } from "../services/goal-stewardship.js";
import { setEnv } from "../utils/env-manager.js";
import { createMockPluginApi } from "./harness/mock-plugin-api.js";

function parseCfg() {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
    },
    goalStewardship: {
      enabled: true,
      goalsDir: "state/goals",
      heartbeatStewardship: true,
      watchdogHealthCheck: true,
    },
  });
}

function minimalLifecycleContext(cfg: ReturnType<typeof parseCfg>): LifecycleContext {
  return { cfg } as LifecycleContext;
}

const defaults = {
  maxDispatches: 20,
  maxAssessments: 50,
  cooldownMinutes: 10,
  escalateAfterFailures: 3,
  priority: "normal" as const,
};

describe("goal stewardship integration (mock plugin API)", () => {
  let workspaceRoot: string;
  let goalsDir: string;
  let prevWorkspace: string | undefined;

  beforeEach(async () => {
    prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    workspaceRoot = await mkdtemp(join(tmpdir(), "gs-int-"));
    await mkdir(join(workspaceRoot, "state", "goals"), { recursive: true });
    setEnv("OPENCLAW_WORKSPACE", workspaceRoot);
    const cfg = parseCfg();
    goalsDir = resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir);
  });

  afterEach(async () => {
    setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("before_agent_start injects stewardship block on heartbeat when goal is past cooldown", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalStewardshipInjection(api as unknown as ClawdbotPluginApi, ctx, goalsDir, undefined);

    await createGoal(
      goalsDir,
      {
        label: "integration_goal",
        description: "test",
        acceptanceCriteria: ["criterion one"],
        cooldownMinutes: 1,
      },
      { ...defaults, cooldownMinutes: 1 },
    );
    const goals = await listGoals(goalsDir);
    const g0 = goals[0];
    expect(g0).toBeDefined();
    if (!g0) throw new Error("fixture: expected one goal");
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await updateGoal(
      goalsDir,
      g0.id,
      { lastAssessedAt: old },
      { timestamp: new Date().toISOString(), action: "test", detail: "cooldown", actor: "user" },
    );

    const event = {
      messages: [{ role: "user", content: "Scheduled heartbeat ping" }],
    };
    const result = await api.emitFirstResult("before_agent_start", event);
    expect(result && typeof result === "object" && "prependContext" in result).toBe(true);
    const prep = (result as { prependContext?: string }).prependContext ?? "";
    expect(prep).toContain("<goal-stewardship-bundle>");
    expect(prep).toContain("<goal-stewardship>");
    expect(prep).toContain("integration_goal");
  });

  it("before_agent_start returns undefined without heartbeat keyword", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalStewardshipInjection(api as unknown as ClawdbotPluginApi, ctx, goalsDir, undefined);

    await createGoal(goalsDir, { label: "g2", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const goals = await listGoals(goalsDir);
    const g0 = goals[0];
    expect(g0).toBeDefined();
    if (!g0) throw new Error("fixture: expected one goal");
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await updateGoal(
      goalsDir,
      g0.id,
      { lastAssessedAt: old },
      { timestamp: new Date().toISOString(), action: "test", detail: "cooldown", actor: "user" },
    );

    const event = {
      messages: [{ role: "user", content: "normal user message" }],
    };
    const result = await api.emitFirstResult("before_agent_start", event);
    expect(result).toBeUndefined();
  });

  it("subagent_spawned + subagent_ended link task and move goal toward verifying", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalSubagentHandlers(api as unknown as ClawdbotPluginApi, ctx, goalsDir);

    const g = await createGoal(
      goalsDir,
      { label: "deploy", description: "deploy app", acceptanceCriteria: ["live"] },
      defaults,
    );

    await api.emitAll("subagent_spawned", {
      goalId: g.id,
      label: "task-a",
      childSessionKey: "session-child-1",
    });

    const afterSpawn = await readGoal(goalsDir, g.id);
    expect(afterSpawn?.linkedTasks.some((t) => t.label === "task-a")).toBe(true);

    await api.emitAll("subagent_ended", {
      label: "task-a",
      targetSessionKey: "session-child-1",
      success: true,
      outcome: "success",
    });

    const afterEnd = await readGoal(goalsDir, g.id);
    expect(afterEnd?.status).toBe("verifying");
    const task = afterEnd?.linkedTasks.find((t) => t.label === "task-a");
    expect(task?.status).toBe("completed");
  });

  it("subagent_spawned marks goal blocked when dispatch metadata is missing", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalSubagentHandlers(api as unknown as ClawdbotPluginApi, ctx, goalsDir);

    const g = await createGoal(
      goalsDir,
      { label: "deploy-metadata", description: "deploy app", acceptanceCriteria: ["live"] },
      defaults,
    );

    await api.emitAll("subagent_spawned", {
      goalId: g.id,
      label: "task-missing-meta",
    });

    const afterSpawn = await readGoal(goalsDir, g.id);
    expect(afterSpawn?.status).toBe("blocked");
    expect(afterSpawn?.lastOutcome).toContain("missing ACP session metadata");
    expect(afterSpawn?.currentBlockers.some((b) => b.includes("missing ACP session metadata"))).toBe(true);
    const task = afterSpawn?.linkedTasks.find((t) => t.label === "task-missing-meta");
    expect(task?.status).toBe("failed");
    expect(task?.dispatchFailureReason).toContain("missing ACP session metadata");
  });

  it("subagent_spawned runId-only metadata is treated as dispatch failure", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalSubagentHandlers(api as unknown as ClawdbotPluginApi, ctx, goalsDir);

    const g = await createGoal(
      goalsDir,
      { label: "deploy-runid-only", description: "deploy app", acceptanceCriteria: ["live"] },
      defaults,
    );

    await api.emitAll("subagent_spawned", {
      goalId: g.id,
      label: "task-runid-only",
      runId: "run-123",
    });

    const afterSpawn = await readGoal(goalsDir, g.id);
    expect(afterSpawn?.status).toBe("blocked");
    expect(afterSpawn?.lastOutcome).toContain("runId-only dispatch cannot be correlated");
    const task = afterSpawn?.linkedTasks.find((t) => t.label === "task-runid-only");
    expect(task?.status).toBe("failed");
    expect(task?.sessionKey).toBeNull();
    expect(task?.runId).toBe("run-123");
    expect(afterSpawn?.linkedTasks.some((t) => t.status === "in_progress" || t.status === "In progress")).toBe(false);
  });

  it("subagent relink update preserves existing dispatchFailureReason when omitted", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalSubagentHandlers(api as unknown as ClawdbotPluginApi, ctx, goalsDir);

    const g = await createGoal(
      goalsDir,
      { label: "deploy-preserve-failure", description: "deploy app", acceptanceCriteria: ["live"] },
      defaults,
    );
    const now = new Date().toISOString();
    await updateGoal(
      goalsDir,
      g.id,
      {
        linkedTasks: [
          {
            label: "task-relink",
            sessionKey: null,
            runId: null,
            dispatchFailureReason: "previous dispatch diagnostics",
            status: "failed",
            linkedAt: now,
            updatedAt: now,
          },
        ],
      },
      { timestamp: now, action: "test", detail: "seed previous failure", actor: "user" },
    );

    await api.emitAll("subagent_spawned", {
      goalId: g.id,
      label: "task-relink",
      childSessionKey: "session-child-keep-reason",
    });

    const afterRelink = await readGoal(goalsDir, g.id);
    const task = afterRelink?.linkedTasks.find((t) => t.label === "task-relink");
    expect(task?.status).toBe("in_progress");
    expect(task?.sessionKey).toBe("session-child-keep-reason");
    expect(task?.dispatchFailureReason).toBe("previous dispatch diagnostics");
  });

  it("subagent_spawned picks the longest matching goal-label prefix", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalSubagentHandlers(api as unknown as ClawdbotPluginApi, ctx, goalsDir);

    const shorter = await createGoal(
      goalsDir,
      { label: "deploy", description: "deploy", acceptanceCriteria: ["ok"] },
      defaults,
    );
    const longer = await createGoal(
      goalsDir,
      { label: "deploy-a", description: "deploy variant", acceptanceCriteria: ["ok"] },
      defaults,
    );

    await api.emitAll("subagent_spawned", {
      label: "deploy-a/task-1",
      childSessionKey: "session-deploy-a",
    });

    const shorterAfter = await readGoal(goalsDir, shorter.id);
    const longerAfter = await readGoal(goalsDir, longer.id);
    expect(shorterAfter?.linkedTasks.some((t) => t.sessionKey === "session-deploy-a")).toBe(false);
    expect(longerAfter?.linkedTasks.some((t) => t.sessionKey === "session-deploy-a")).toBe(true);
  });

  it("subagent_ended skips ambiguous label-only matches across multiple goals", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalSubagentHandlers(api as unknown as ClawdbotPluginApi, ctx, goalsDir);

    const g1 = await createGoal(
      goalsDir,
      { label: "deploy-a", description: "deploy a", acceptanceCriteria: ["ok"] },
      defaults,
    );
    const g2 = await createGoal(
      goalsDir,
      { label: "deploy-b", description: "deploy b", acceptanceCriteria: ["ok"] },
      defaults,
    );
    const now = new Date().toISOString();
    await updateGoal(
      goalsDir,
      g1.id,
      {
        linkedTasks: [
          { label: "shared-task", sessionKey: null, runId: null, status: "in_progress", linkedAt: now, updatedAt: now },
        ],
      },
      { timestamp: now, action: "test", detail: "seed linked task", actor: "user" },
    );
    await updateGoal(
      goalsDir,
      g2.id,
      {
        linkedTasks: [
          { label: "shared-task", sessionKey: null, runId: null, status: "in_progress", linkedAt: now, updatedAt: now },
        ],
      },
      { timestamp: now, action: "test", detail: "seed linked task", actor: "user" },
    );

    await api.emitAll("subagent_ended", {
      label: "shared-task",
      success: true,
      outcome: "success",
    });

    const after1 = await readGoal(goalsDir, g1.id);
    const after2 = await readGoal(goalsDir, g2.id);
    expect(after1?.linkedTasks.find((t) => t.label === "shared-task")?.status).toBe("in_progress");
    expect(after2?.linkedTasks.find((t) => t.label === "shared-task")?.status).toBe("in_progress");
  });

  it("subagent_ended ignores goals with missing linkedTasks arrays", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalSubagentHandlers(api as unknown as ClawdbotPluginApi, ctx, goalsDir);

    const g = await createGoal(
      goalsDir,
      { label: "missing-linked-tasks", description: "legacy goal shape", acceptanceCriteria: ["ok"] },
      defaults,
    );
    const goalPath = join(goalsDir, `${g.id}.json`);
    const rawGoal = JSON.parse(await readFile(goalPath, "utf-8")) as Record<string, unknown>;
    delete rawGoal.linkedTasks;
    await writeFile(goalPath, JSON.stringify(rawGoal, null, 2), "utf-8");

    await expect(
      api.emitAll("subagent_ended", {
        label: "legacy-task",
        targetSessionKey: "legacy-session",
        success: true,
        outcome: "success",
      }),
    ).resolves.toBeUndefined();

    const afterEnd = await readGoal(goalsDir, g.id);
    expect(afterEnd?.status).toBe("active");
    expect(afterEnd?.linkedTasks).toEqual([]);
  });

  it("before_agent_start returns undefined when no active goals exist", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalStewardshipInjection(api as unknown as ClawdbotPluginApi, ctx, goalsDir, undefined);

    const event = {
      messages: [{ role: "user", content: "Scheduled heartbeat ping" }],
    };
    const result = await api.emitFirstResult("before_agent_start", event);
    expect(result).toBeUndefined();
  });

  it("before_agent_start skips goal within cooldown", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalStewardshipInjection(api as unknown as ClawdbotPluginApi, ctx, goalsDir, undefined);

    await createGoal(
      goalsDir,
      {
        label: "cooldown_goal",
        description: "test",
        acceptanceCriteria: ["criterion one"],
        cooldownMinutes: 10,
      },
      { ...defaults, cooldownMinutes: 10 },
    );
    const goals = await listGoals(goalsDir);
    const g0 = goals[0];
    expect(g0).toBeDefined();
    if (!g0) throw new Error("fixture: expected one goal");
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    await updateGoal(
      goalsDir,
      g0.id,
      { lastAssessedAt: twoMinutesAgo },
      { timestamp: new Date().toISOString(), action: "test", detail: "within cooldown", actor: "user" },
    );

    const event = {
      messages: [{ role: "user", content: "Scheduled heartbeat ping" }],
    };
    const result = await api.emitFirstResult("before_agent_start", event);
    expect(result).toBeUndefined();
  });

  it("subagent_ended failure increments consecutiveFailures", async () => {
    const cfg = parseCfg();
    const ctx = minimalLifecycleContext(cfg);
    const api = createMockPluginApi();
    registerGoalSubagentHandlers(api as unknown as ClawdbotPluginApi, ctx, goalsDir);

    const g = await createGoal(
      goalsDir,
      { label: "fail-goal", description: "test failures", acceptanceCriteria: ["done"] },
      defaults,
    );
    expect(g.consecutiveFailures).toBe(0);

    await api.emitAll("subagent_spawned", {
      goalId: g.id,
      label: "task-fail",
      childSessionKey: "session-child-fail",
    });

    await api.emitAll("subagent_ended", {
      label: "task-fail",
      targetSessionKey: "session-child-fail",
      success: false,
      outcome: "failure",
    });

    const after = await readGoal(goalsDir, g.id);
    expect(after?.consecutiveFailures).toBe(1);
  });
});
