/**
 * Integration-style tests for goal stewardship lifecycle hooks using a mock plugin API.
 * No OpenClaw core required — exercises registerGoalStewardshipInjection + registerGoalSubagentHandlers.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
});
