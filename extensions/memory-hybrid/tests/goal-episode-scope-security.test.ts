/**
 * Regression coverage for goal_complete/goal_abandon recording episodes with no scope (loop
 * iteration 9): unlike the sibling memory_record_episode tool, these had no caller-facing scope
 * param and called factsDb.recordEpisode with none of scope/scopeTarget/agentId/userId/sessionId
 * set — defaulting every completed/abandoned goal's episode to global scope regardless of which
 * tenant/agent owned the goal.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { createGoal } from "../services/goal-registry.js";
import { resolveGoalsDir } from "../services/goal-stewardship.js";
import { registerGoalTools } from "../tools/goal-tools.js";
import { setEnv } from "../utils/env-manager.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";

const defaults = {
  maxDispatches: 20,
  maxAssessments: 50,
  cooldownMinutes: 10,
  escalateAfterFailures: 3,
  priority: "normal" as const,
};

type ToolMap = Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>;

describe("goal_complete/goal_abandon episode scope (loop iteration 9 regression)", () => {
  let workspaceRoot: string;
  let goalsDir: string;
  let prevWorkspace: string | undefined;

  beforeEach(async () => {
    prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    workspaceRoot = await mkdtemp(join(tmpdir(), "gt-episode-scope-"));
    await mkdir(join(workspaceRoot, "state", "goals"), { recursive: true });
    setEnv("OPENCLAW_WORKSPACE", workspaceRoot);
    goalsDir = resolveGoalsDir(workspaceRoot, "state/goals");
  });

  afterEach(async () => {
    setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function registerTools(recordEpisode: ReturnType<typeof vi.fn>): ToolMap {
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools: ToolMap = new Map();
    const api: Pick<ClawdbotPluginApi, "registerTool"> = {
      registerTool(toolDefinition: {
        name: string;
        execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
      }) {
        tools.set(toolDefinition.name, { execute: toolDefinition.execute });
      },
    };
    registerGoalTools(
      {
        cfg,
        goalsDir,
        workspaceRoot,
        resolvedActiveTaskPath: join(workspaceRoot, "ACTIVE-TASKS.md"),
        factsDb: { recordEpisode } as never,
        vectorDb: null,
        embeddings: null,
        eventLog: null,
        memoryDir: join(workspaceRoot, "memory"),
        currentAgentIdRef: { value: "tenantA" },
        buildToolScopeFilter,
      },
      api as ClawdbotPluginApi,
    );
    return tools;
  }

  it("goal_complete records the episode scoped to the caller's own agent, not global", async () => {
    const g = await createGoal(goalsDir, { label: "c1", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const recordEpisode = vi.fn();
    const tools = registerTools(recordEpisode);
    const complete = tools.get("goal_complete");
    await complete?.execute("tc", { goal_id: g.id, reason: "done", confirmed: true });

    expect(recordEpisode).toHaveBeenCalledOnce();
    const call = recordEpisode.mock.calls[0][0] as { scope?: string; scopeTarget?: string; agentId?: string };
    expect(call.scope).toBe("agent");
    expect(call.scopeTarget).toBe("tenantA");
    expect(call.agentId).toBe("tenantA");
  });

  it("goal_abandon records the episode scoped to the caller's own agent, not global", async () => {
    const g = await createGoal(goalsDir, { label: "a1", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const recordEpisode = vi.fn();
    const tools = registerTools(recordEpisode);
    const abandon = tools.get("goal_abandon");
    await abandon?.execute("tc", { goal_id: g.id, reason: "no longer needed" });

    expect(recordEpisode).toHaveBeenCalledOnce();
    const call = recordEpisode.mock.calls[0][0] as { scope?: string; scopeTarget?: string; agentId?: string };
    expect(call.scope).toBe("agent");
    expect(call.scopeTarget).toBe("tenantA");
    expect(call.agentId).toBe("tenantA");
  });
});
