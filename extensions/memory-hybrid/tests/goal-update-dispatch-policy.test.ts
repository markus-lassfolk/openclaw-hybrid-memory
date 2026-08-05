import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { createGoal, readGoal, terminateGoal } from "../services/goal-registry.js";
import type { GoalDispatchPolicy } from "../services/goal-dispatch-authorization.js";
import { registerGoalTools } from "../tools/goal-tools.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";

const defaults = {
  maxDispatches: 5,
  maxAssessments: 10,
  cooldownMinutes: 5,
  escalateAfterFailures: 3,
  priority: "normal" as const,
};
const policy: GoalDispatchPolicy = { version: 1, classes: { reader: { allowedAgents: ["reader"], readOnly: true } } };
type Execute = (id: string, params: Record<string, unknown>) => Promise<{ details?: Record<string, unknown> }>;

describe("goal_update dispatch_policy", () => {
  let workspaceRoot: string;
  let goalsDir: string;
  let update: Execute;
  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "goal-update-policy-"));
    goalsDir = join(workspaceRoot, "state", "goals");
    await mkdir(goalsDir, { recursive: true });
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: Execute }>();
    const api = {
      registerTool(definition: { name: string; execute: Execute }) {
        tools.set(definition.name, { execute: definition.execute });
      },
    };
    registerGoalTools(
      {
        cfg,
        goalsDir,
        workspaceRoot,
        resolvedActiveTaskPath: join(workspaceRoot, "ACTIVE-TASKS.md"),
        factsDb: null,
        vectorDb: null,
        embeddings: null,
        eventLog: null,
        memoryDir: join(workspaceRoot, "memory"),
        currentAgentIdRef: { value: null },
        buildToolScopeFilter,
      },
      api as unknown as ClawdbotPluginApi,
    );
    update = tools.get("goal_update")!.execute;
  });
  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  const goal = () =>
    createGoal(
      goalsDir,
      {
        label: `policy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        description: "d",
        acceptanceCriteria: ["a"],
      },
      defaults,
    );

  it("persists a valid dispatch policy", async () => {
    const g = await goal();
    expect((await update("test", { goal_id: g.id, dispatch_policy: policy })).details?.goal).toMatchObject({
      dispatchPolicy: policy,
    });
    expect((await readGoal(goalsDir, g.id))?.dispatchPolicy).toEqual(policy);
  });
  it("rejects an invalid dispatch policy without changing the goal", async () => {
    const g = await goal();
    const result = await update("test", { goal_id: g.id, dispatch_policy: { version: 1, classes: {} } });
    expect(result.details).toMatchObject({ error: "invalid_dispatch_policy" });
    expect((await readGoal(goalsDir, g.id))?.dispatchPolicy).toBeUndefined();
  });
  it("does not update policy on a terminal goal", async () => {
    const g = await goal();
    await terminateGoal(goalsDir, g.id, "completed", "done", "agent");
    expect((await update("test", { goal_id: g.id, dispatch_policy: policy })).details).toMatchObject({
      error: "terminal",
    });
    expect((await readGoal(goalsDir, g.id))?.dispatchPolicy).toBeUndefined();
  });
});

describe("goal_update complete persisted patch", () => {
  let workspaceRoot: string;
  let goalsDir: string;
  let update: Execute;
  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "goal-update-complete-"));
    goalsDir = join(workspaceRoot, "state", "goals");
    await mkdir(goalsDir, { recursive: true });
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: Execute }>();
    const api = {
      registerTool(definition: { name: string; execute: Execute }) {
        tools.set(definition.name, definition);
      },
    };
    registerGoalTools(
      {
        cfg,
        goalsDir,
        workspaceRoot,
        resolvedActiveTaskPath: join(workspaceRoot, "ACTIVE-TASKS.md"),
        factsDb: null,
        vectorDb: null,
        embeddings: null,
        eventLog: null,
        memoryDir: join(workspaceRoot, "memory"),
        currentAgentIdRef: { value: null },
        buildToolScopeFilter,
      },
      api as unknown as ClawdbotPluginApi,
    );
    update = tools.get("goal_update")!.execute;
  });
  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("persists camel-case policy and nullable/non-string operational fields through read-back", async () => {
    const g = await createGoal(
      goalsDir,
      { label: "complete-patch", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );
    const linkedTasks = [
      {
        label: "dispatch-worker",
        sessionKey: null,
        runId: "run-1",
        dispatchFailureReason: null,
        status: "failed",
        linkedAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:01:00.000Z",
      },
    ];
    const fullPolicy: GoalDispatchPolicy = {
      version: 1,
      classes: {
        furnace: {
          allowedAgents: ["furnace"],
          readOnly: false,
          canonical: {
            repository: "markus-lassfolk/openclaw-hybrid-memory",
            prNumber: 1,
            branch: "fix/goal",
            remoteHead: "abc123",
          },
          writeScope: ["extensions/memory-hybrid"],
          forbidNewPr: true,
          forbidNewBranch: true,
        },
      },
    };
    const result = await update("test", {
      goal_id: g.id,
      dispatchPolicy: fullPolicy,
      nextAction: null,
      lastOutcome: "worker failed",
      evidence: null,
      linkedTasks,
    });
    expect(result.details?.goal).toMatchObject({
      dispatchPolicy: fullPolicy,
      nextAction: null,
      lastOutcome: "worker failed",
      evidence: null,
      linkedTasks,
    });
    expect(await readGoal(goalsDir, g.id)).toMatchObject({
      dispatchPolicy: fullPolicy,
      nextAction: null,
      lastOutcome: "worker failed",
      evidence: null,
      linkedTasks,
    });
  });
});
