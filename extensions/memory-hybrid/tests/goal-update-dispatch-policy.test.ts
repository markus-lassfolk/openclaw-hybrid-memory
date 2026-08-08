import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { createGoal, readGoal, terminateGoal } from "../services/goal-registry.js";
import { evaluateGoalDispatch, type GoalDispatchPolicy } from "../services/goal-dispatch-authorization.js";
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
  it("preserves a legacy persisted policy, denies its write dispatch with remediation, and safely replaces it", async () => {
    const g = await goal();
    const legacyPolicy = {
      version: 1,
      classes: {
        writer: {
          allowedAgents: ["writer"],
          readOnly: false,
          canonical: { prNumber: 2252, branch: "fix/goal", remoteHead: "abc123" },
          writeScope: ["extensions/memory-hybrid"],
          forbidNewPr: true,
          forbidNewBranch: true,
        },
      },
    };
    await writeFile(join(goalsDir, `${g.id}.json`), JSON.stringify({ ...g, dispatchPolicy: legacyPolicy }, null, 2));
    const loaded = await readGoal(goalsDir, g.id);
    expect(loaded?.dispatchPolicy).toEqual(legacyPolicy);
    expect(
      evaluateGoalDispatch(loaded?.dispatchPolicy, {
        taskClass: "writer",
        requestedAgent: "writer",
        actualAgent: "writer",
        readOnly: false,
      }).reason,
    ).toContain("missing canonical.repository");

    const replacement: GoalDispatchPolicy = {
      version: 1,
      classes: {
        writer: {
          ...legacyPolicy.classes.writer,
          canonical: { ...legacyPolicy.classes.writer.canonical, repository: "owner/repository" },
        },
      },
    };
    const result = await update("test", { goal_id: g.id, dispatch_policy: replacement });
    expect(result.details?.goal).toMatchObject({ dispatchPolicy: replacement });
    expect((await readGoal(goalsDir, g.id))?.dispatchPolicy).toEqual(replacement);
  });

  it("returns non-destructive remediation for a legacy write policy submitted to goal_update", async () => {
    const g = await goal();
    const legacyPolicy = {
      version: 1,
      classes: {
        writer: {
          allowedAgents: ["writer"],
          readOnly: false,
          canonical: { prNumber: 2252, branch: "fix/goal", remoteHead: "abc123" },
          writeScope: ["extensions/memory-hybrid"],
          forbidNewPr: true,
          forbidNewBranch: true,
        },
      },
    };
    const result = await update("test", { goal_id: g.id, dispatch_policy: legacyPolicy });
    expect(result.details).toMatchObject({ error: "legacy_dispatch_policy_requires_repository" });
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
  it("accepts matching snake aliases, rejects conflicting aliases, and preserves unrelated goal fields", async () => {
    const g = await createGoal(
      goalsDir,
      { label: "snake-operational", description: "original", acceptanceCriteria: ["criterion"] },
      defaults,
    );
    const linkedTasks = [
      {
        label: "worker",
        sessionKey: "session",
        status: "done",
        linkedAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:01:00.000Z",
      },
    ];
    const result = await update("test", {
      goal_id: g.id,
      next_action: "retry safely",
      nextAction: "retry safely",
      last_outcome: "checked",
      lastOutcome: "checked",
      linked_tasks: linkedTasks,
      linkedTasks: structuredClone(linkedTasks),
    });
    expect(result.details?.goal).toMatchObject({
      nextAction: "retry safely",
      lastOutcome: "checked",
      linkedTasks,
      description: "original",
      acceptanceCriteria: ["criterion"],
      priority: g.priority,
    });
    const conflict = await update("test", {
      goal_id: g.id,
      next_action: "one",
      nextAction: "two",
    });
    expect(conflict.details?.error).toContain("next_action and its camel-case alias conflict");
    expect((await readGoal(goalsDir, g.id))?.nextAction).toBe("retry safely");
  });
});
