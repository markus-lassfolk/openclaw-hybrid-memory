/**
 * Registry/store coverage for primitives that goal tools call (no full plugin API mock).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import * as goalRegistry from "../services/goal-registry.js";
import {
  createGoal,
  listActiveGoals,
  readGoal,
  resolveGoalId,
  terminateGoal,
  updateGoal,
} from "../services/goal-registry.js";
import { resolveGoalsDir } from "../services/goal-stewardship.js";
import { registerGoalTools } from "../tools/goal-tools.js";
import { setEnv } from "../utils/env-manager.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";

const defaults = {
  maxDispatches: 5,
  maxAssessments: 10,
  cooldownMinutes: 5,
  escalateAfterFailures: 3,
  priority: "normal" as const,
};

describe("goal tools registry primitives", () => {
  let workspaceRoot: string;
  let goalsDir: string;
  let prevWorkspace: string | undefined;

  beforeEach(async () => {
    prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    workspaceRoot = await mkdtemp(join(tmpdir(), "gt-reg-"));
    await mkdir(join(workspaceRoot, "state", "goals"), { recursive: true });
    setEnv("OPENCLAW_WORKSPACE", workspaceRoot);
    goalsDir = resolveGoalsDir(workspaceRoot, "state/goals");
  });

  afterEach(async () => {
    setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("resolveGoalId resolves by label", async () => {
    const g = await createGoal(goalsDir, { label: "my-goal", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const resolved = await resolveGoalId(goalsDir, "my-goal");
    expect(resolved?.id).toBe(g.id);
    expect(resolved?.label).toBe("my-goal");
  });

  it("resolveGoalId returns null for missing", async () => {
    const resolved = await resolveGoalId(goalsDir, "no-such-goal-id-or-label");
    expect(resolved).toBeNull();
  });

  it("resolveGoalId returns null for undefined ref (#1981)", async () => {
    expect(await resolveGoalId(goalsDir, undefined)).toBeNull();
  });

  it("terminateGoal with completed sets correct status", async () => {
    const g = await createGoal(goalsDir, { label: "finish", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const after = await terminateGoal(goalsDir, g.id, "completed", "all criteria met", "user");
    expect(after.status).toBe("completed");
    expect((await readGoal(goalsDir, g.id))?.status).toBe("completed");
  });

  it("terminateGoal with abandoned sets correct status", async () => {
    const g = await createGoal(goalsDir, { label: "drop", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const after = await terminateGoal(goalsDir, g.id, "abandoned", "no longer pursuing", "user");
    expect(after.status).toBe("abandoned");
    expect((await readGoal(goalsDir, g.id))?.status).toBe("abandoned");
  });

  it("createGoal rejects when max active goals reached", async () => {
    await createGoal(goalsDir, { label: "one", description: "d", acceptanceCriteria: ["a"] }, defaults);
    await createGoal(goalsDir, { label: "two", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const active = await listActiveGoals(goalsDir);
    expect(active.length).toBe(2);
    const maxActiveGoals = 2;
    expect(active.length >= maxActiveGoals).toBe(true);
  });

  it("createGoal rejects invalid label", async () => {
    await expect(
      createGoal(goalsDir, { label: "bad label spaces", description: "d", acceptanceCriteria: ["a"] }, defaults),
    ).rejects.toThrow(/label/);
  });

  it("goal_assess budget check: updateGoal refuses when assessmentCount >= maxAssessments", async () => {
    const g = await createGoal(
      goalsDir,
      {
        label: "budget-goal",
        description: "d",
        acceptanceCriteria: ["a"],
        maxAssessments: 1,
      },
      { ...defaults, maxAssessments: 1 },
    );
    await updateGoal(
      goalsDir,
      g.id,
      { assessmentCount: 1 },
      { timestamp: new Date().toISOString(), action: "test", detail: "at cap", actor: "user" },
    );
    const after = await readGoal(goalsDir, g.id);
    expect(after).toBeDefined();
    if (!after) throw new Error("fixture: goal missing");
    expect(after.assessmentCount >= after.maxAssessments).toBe(true);
  });

  it("goal_register succeeds when goals dir contains _global_dispatch_rate_limit.json", async () => {
    await writeFile(
      join(goalsDir, "_global_dispatch_rate_limit.json"),
      JSON.stringify({ timestamps: [Date.now()], updatedAt: new Date().toISOString() }),
      "utf-8",
    );

    const cfg = hybridConfigSchema.parse({
      embedding: {
        apiKey: "sk-test-key-that-is-long-enough-to-pass",
        model: "text-embedding-3-small",
      },
      goalStewardship: {
        enabled: true,
        goalsDir: "state/goals",
      },
    });

    type RegisteredGoalTool = {
      name: string;
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    const tools = new Map<string, { execute: RegisteredGoalTool["execute"] }>();
    const api: Pick<ClawdbotPluginApi, "registerTool"> = {
      registerTool(toolDefinition: RegisteredGoalTool) {
        tools.set(toolDefinition.name, { execute: toolDefinition.execute });
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
      api as ClawdbotPluginApi,
    );

    const goalRegister = tools.get("goal_register");
    expect(goalRegister).toBeDefined();
    const result = (await goalRegister?.execute("test-call-id", {
      label: "global_rate_file_present",
      description: "register despite housekeeping file",
      acceptance_criteria: ["Plugin persists goal JSON under state/goals with matching label"],
      confirmed: true,
    })) as { details?: { goal?: { label?: string } } };
    expect(result?.details?.goal?.label).toBe("global_rate_file_present");
  });

  it("goal_register rejects vague criteria until confirmed", async () => {
    const cfg = hybridConfigSchema.parse({
      embedding: {
        apiKey: "sk-test-key-that-is-long-enough-to-pass",
        model: "text-embedding-3-small",
      },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
    const api: Pick<ClawdbotPluginApi, "registerTool"> = {
      registerTool(toolDefinition: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) {
        tools.set(toolDefinition.name, { execute: toolDefinition.execute });
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
      api as ClawdbotPluginApi,
    );
    const goalRegister = tools.get("goal_register");
    const vague = (await goalRegister?.execute("tc", {
      label: "vague-goal",
      description: "fix it",
      acceptance_criteria: ["done"],
    })) as { details?: { error?: string } };
    expect(vague?.details?.error).toBe("goal_criteria_unclear");

    const ok = (await goalRegister?.execute("tc", {
      label: "clear-goal",
      description: "Fix CI on main branch and restore green required checks.",
      acceptance_criteria: [
        "Required CI workflow on main branch completes with exit 0",
        "Previously failing test suite passes locally with documented command",
      ],
      confirmed: true,
    })) as { details?: { goal?: { label?: string } } };
    expect(ok?.details?.goal?.label).toBe("clear-goal");
  });

  it("goal_list and goal_get expose registry goals", async () => {
    await createGoal(
      goalsDir,
      {
        label: "list-me",
        description: "List and get test goal with verifiable completion.",
        acceptanceCriteria: ["Operator can run goal_list and see this label"],
      },
      defaults,
    );
    const cfg = hybridConfigSchema.parse({
      embedding: {
        apiKey: "sk-test-key-that-is-long-enough-to-pass",
        model: "text-embedding-3-small",
      },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
    const api: Pick<ClawdbotPluginApi, "registerTool"> = {
      registerTool(toolDefinition: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) {
        tools.set(toolDefinition.name, { execute: toolDefinition.execute });
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
      api as ClawdbotPluginApi,
    );
    const list = (await tools.get("goal_list")?.execute("tc", {})) as { details?: { count?: number } };
    expect(list?.details?.count).toBeGreaterThanOrEqual(1);
    const got = (await tools.get("goal_get")?.execute("tc", { goal_id: "list-me" })) as {
      details?: { goal?: { label?: string } };
    };
    expect(got?.details?.goal?.label).toBe("list-me");
  });

  it("goal_assess returns structured errors for missing params and corrupt goals (#1981)", async () => {
    const corruptId = "822b1268-5093-4f70-8585-20bb09b4fd2b";
    await writeFile(join(goalsDir, `${corruptId}.json`), '{"label":"broken","description":"unterminated', "utf-8");

    const cfg = hybridConfigSchema.parse({
      embedding: {
        apiKey: "sk-test-key-that-is-long-enough-to-pass",
        model: "text-embedding-3-small",
      },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
    const api: Pick<ClawdbotPluginApi, "registerTool"> = {
      registerTool(toolDefinition: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) {
        tools.set(toolDefinition.name, { execute: toolDefinition.execute });
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
      api as ClawdbotPluginApi,
    );
    const assess = tools.get("goal_assess");
    expect(assess).toBeDefined();

    const missingId = (await assess!.execute("tc", {
      assessment: "progress",
      next_action: "continue",
    })) as { content?: Array<{ text?: string }>; details?: { error?: string } };
    expect(missingId.details?.error).toBe("invalid_ref");
    expect(missingId.content?.[0]?.text).toContain("goal_id is required");

    const corrupt = (await assess!.execute("tc", {
      goal_id: corruptId,
      assessment: "blocked on corrupt registry",
      next_action: "repair goal JSON",
    })) as { content?: Array<{ text?: string }>; details?: { error?: string } };
    expect(corrupt.details?.error).toBe("corrupt");
    expect(corrupt.content?.[0]?.text).toContain("Goal state could not be loaded");
  });

  it("goal_assess does not mutate or reopen a goal terminated between the pre-lock read and the lock (TOCTOU, loop iteration 27 regression)", async () => {
    const g = await createGoal(
      goalsDir,
      { label: "assess_race", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );

    const cfg = hybridConfigSchema.parse({
      embedding: {
        apiKey: "sk-test-key-that-is-long-enough-to-pass",
        model: "text-embedding-3-small",
      },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
    const api: Pick<ClawdbotPluginApi, "registerTool"> = {
      registerTool(toolDefinition: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) {
        tools.set(toolDefinition.name, { execute: toolDefinition.execute });
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
      api as ClawdbotPluginApi,
    );
    const assess = tools.get("goal_assess");
    expect(assess).toBeDefined();

    // Simulate a concurrent goal_complete landing in the race window between goal_assess's
    // pre-lock resolveGoalIdResult() read and updateGoal's own lock being acquired: the spy
    // returns the STALE (still-active) snapshot, exactly matching the real race window, after a
    // genuine concurrent termination has already completed the goal.
    const resolveSpy = vi.spyOn(goalRegistry, "resolveGoalIdResult");
    resolveSpy.mockImplementationOnce(async (dir, ref) => {
      const stale = await goalRegistry.resolveGoalIdResult(dir, ref);
      await goalRegistry.terminateGoal(dir, g.id, "completed", "shipped concurrently", "agent");
      return stale;
    });

    try {
      const result = (await assess?.execute("tc", {
        goal_id: g.id,
        assessment: "still working on it",
        next_action: "keep going",
      })) as { content?: Array<{ text?: string }>; details?: { error?: string } };
      expect(result.details?.error).toBe("terminal");

      const after = await readGoal(goalsDir, g.id);
      expect(after?.status).toBe("completed");
      expect(after?.assessmentCount).toBe(0);
      expect(after?.history.some((h) => h.action === "assessed")).toBe(false);
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("goal_update does not rewrite an already-terminal goal's description/acceptance criteria (loop iteration 28 regression)", async () => {
    const g = await createGoal(
      goalsDir,
      { label: "update_terminal", description: "original description", acceptanceCriteria: ["a"] },
      defaults,
    );
    await terminateGoal(goalsDir, g.id, "completed", "shipped it", "agent");

    const cfg = hybridConfigSchema.parse({
      embedding: {
        apiKey: "sk-test-key-that-is-long-enough-to-pass",
        model: "text-embedding-3-small",
      },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
    const api: Pick<ClawdbotPluginApi, "registerTool"> = {
      registerTool(toolDefinition: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) {
        tools.set(toolDefinition.name, { execute: toolDefinition.execute });
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
      api as ClawdbotPluginApi,
    );
    const update = tools.get("goal_update");
    expect(update).toBeDefined();

    const result = (await update?.execute("tc", {
      goal_id: g.id,
      description: "rewritten after completion",
      acceptance_criteria: ["rewritten criterion"],
      confirmed: true,
    })) as { details?: { error?: string } };
    expect(result.details?.error).toBe("terminal");

    const after = await readGoal(goalsDir, g.id);
    expect(after?.description).toBe("original description");
    expect(after?.acceptanceCriteria).toEqual(["a"]);
    expect(after?.history.some((h) => h.action === "updated")).toBe(false);
  });
});
