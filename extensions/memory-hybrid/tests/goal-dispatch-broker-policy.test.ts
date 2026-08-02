import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ToolResult = { details?: Record<string, unknown> };
type ToolExecute = (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
import { hybridConfigSchema } from "../config.js";
import { createGoal } from "../services/goal-registry.js";
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
const policy: GoalDispatchPolicy = {
  version: 1,
  classes: {
    managed: { allowedAgents: ["legacy-reader"], readOnly: true },
    governance_readonly: { allowedAgents: ["governance-reader"], readOnly: true },
    canonical_write: {
      allowedAgents: ["writer"],
      readOnly: false,
      canonical: { prNumber: 77, branch: "fix/dispatch", remoteHead: "sha77" },
      writeScope: ["extensions/memory-hybrid"],
      forbidNewPr: true,
      forbidNewBranch: true,
    },
  },
};

describe("goal_dispatch broker policy selection", () => {
  let workspaceRoot: string;
  let goalsDir: string;
  let dispatch: ToolExecute;
  const run = vi.fn(async () => ({ runId: "run-1" }));

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "goal-dispatch-broker-"));
    goalsDir = join(workspaceRoot, "state", "goals");
    await mkdir(goalsDir, { recursive: true });
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: ToolExecute }>();
    const api = {
      registerTool(definition: { name: string; execute: ToolExecute }) {
        tools.set(definition.name, { execute: definition.execute });
      },
      runtime: { subagent: { run } },
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
    const registered = tools.get("goal_dispatch");
    if (!registered) throw new Error("fixture: goal_dispatch was not registered");
    dispatch = registered.execute;
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function goal() {
    return createGoal(
      goalsDir,
      {
        label: `dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        description: "d",
        acceptanceCriteria: ["a"],
        dispatchPolicy: policy,
      },
      defaults,
    );
  }
  const base = (goalId: string, agent = "governance-reader") => ({
    goal_id: goalId,
    agent_id: agent,
    runtime: "acp",
    task: "read",
    session_key: "session",
  });

  it("accepts an explicitly declared allowed non-managed read-only class", async () => {
    const g = await goal();
    const result = await dispatch("test", { ...base(g.id), task_class: "governance_readonly", read_only: true });
    expect(result.details).toMatchObject({ ok: true, launched: false });
  });

  it("denies an undeclared class, wrong agent, read/write mismatch, and out-of-scope write", async () => {
    const g = await goal();
    for (const params of [
      { ...base(g.id), task_class: "not_declared", read_only: true },
      { ...base(g.id, "writer"), task_class: "governance_readonly", read_only: true },
      { ...base(g.id), task_class: "governance_readonly", read_only: false },
      {
        ...base(g.id, "writer"),
        task_class: "canonical_write",
        read_only: false,
        pr_number: 77,
        branch: "fix/dispatch",
        live_remote_head: "sha77",
        write_scope: ["outside"],
        creates_pr: false,
        creates_branch: false,
      },
    ]) {
      const result = await dispatch("test", params);
      expect(result.details?.error).toBe("dispatch_policy_denied");
    }
  });

  it("keeps legacy managed selection only when its full policy is explicitly satisfied", async () => {
    const g = await goal();
    const allowed = await dispatch("test", { ...base(g.id, "legacy-reader"), read_only: true });
    expect(allowed.details?.ok).toBe(true);
    const denied = await dispatch("test", base(g.id, "legacy-reader"));
    expect(denied.details).toMatchObject({ error: "dispatch_policy_denied", task_class: "managed" });
  });
});
