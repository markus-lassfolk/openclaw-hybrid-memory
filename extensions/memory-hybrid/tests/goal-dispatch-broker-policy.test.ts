import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ToolResult = { content?: Array<{ text?: string }>; details?: Record<string, unknown> };
type ToolExecute = (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
type RegisteredTools = Map<string, { execute: ToolExecute }>;
import { hybridConfigSchema } from "../config.js";
import { createGoal, terminateGoal } from "../services/goal-registry.js";
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
      canonical: { repository: "example/repo", prNumber: 77, branch: "fix/dispatch", remoteHead: "sha77" },
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
  let tools: RegisteredTools;
  type SubagentRunParams = {
    sessionKey: string;
    message: string;
    idempotencyKey: string;
    deliver: boolean;
  };
  let api: {
    registerTool(definition: { name: string; execute: ToolExecute }): void;
    runtime: { subagent: { run: typeof run } };
  };
  const run = vi.fn(async (_params: SubagentRunParams) => ({ runId: "run-1" }));

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "goal-dispatch-broker-"));
    goalsDir = join(workspaceRoot, "state", "goals");
    await mkdir(goalsDir, { recursive: true });
    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    tools = new Map<string, { execute: ToolExecute }>();
    api = {
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
  const base = (goalId: string, agent = "governance-reader", runtime: "subagent" | "acp" = "acp") => ({
    goal_id: goalId,
    agent_id: agent,
    runtime,
    task: "read",
    session_key: "session",
  });

  it("accepts an explicitly declared allowed non-managed read-only class", async () => {
    const g = await goal();
    const result = await dispatch("test", {
      ...base(g.id),
      task_class: "governance_readonly",
      read_only: true,
      branch: "supplied-branch",
      write_scope: ["supplied/scope"],
      creates_pr: false,
      creates_branch: false,
    });
    expect(result.details).toMatchObject({ ok: true, launched: false });
    expect(result.details?.dispatch_request).toMatchObject({
      task_class: "governance_readonly",
      branch: "supplied-branch",
      write_scope: ["supplied/scope"],
      creates_pr: false,
      creates_branch: false,
    });
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
        repository: "example/repo",
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

  it("launches an authorized managed request through the injected request-scoped runtime and records it", async () => {
    const g = await goal();
    const result = await dispatch("test", {
      ...base(g.id, "legacy-reader", "subagent"),
      read_only: true,
    });
    expect(run).toHaveBeenCalledWith({
      sessionKey: expect.stringMatching(/^agent:legacy-reader:subagent:[0-9a-f-]{36}$/),
      message: "read",
      idempotencyKey: expect.any(String),
      deliver: false,
    });
    expect(result.details).toMatchObject({
      ok: true,
      run_id: "run-1",
      session_key: expect.stringMatching(/^agent:legacy-reader:subagent:[0-9a-f-]{36}$/),
    });
    const runtimeParams = run.mock.calls[0]?.[0] as { sessionKey: string } | undefined;
    expect(runtimeParams?.sessionKey).toBe(result.details?.session_key);
    const ledger = JSON.parse(
      await (await import("node:fs/promises")).readFile(join(goalsDir, "dispatch-broker", "ledger.json"), "utf8"),
    );
    expect(ledger.dispatches[result.details?.dispatch_id as string]).toMatchObject({
      status: "launched",
      runId: "run-1",
    });
  });

  it("creates a target-agent child and ignores an untrusted caller session key", async () => {
    const g = await goal();
    const result = await dispatch("test", {
      ...base(g.id, "legacy-reader", "subagent"),
      session_key: "agent:main:main",
      read_only: true,
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringMatching(/^agent:legacy-reader:subagent:[0-9a-f-]{36}$/),
      }),
    );
    expect(result.details?.session_key).not.toBe("agent:main:main");
    const ledger = JSON.parse(
      await (await import("node:fs/promises")).readFile(join(goalsDir, "dispatch-broker", "ledger.json"), "utf8"),
    );
    expect(ledger.dispatches[result.details?.dispatch_id as string]).toMatchObject({
      targetAgent: "legacy-reader",
      sessionId: result.details?.session_key,
      status: "launched",
      runId: "run-1",
    });
  });

  it("releases instead of recording a launch when the runtime returns no accepted run id", async () => {
    api.runtime.subagent.run = vi.fn(async () => ({}) as { runId: string });
    const g = await goal();
    const result = await dispatch("test", {
      ...base(g.id, "legacy-reader", "subagent"),
      read_only: true,
    });

    expect(result.details).toEqual({ error: "launch_unaccepted" });
    const ledger = JSON.parse(
      await (await import("node:fs/promises")).readFile(join(goalsDir, "dispatch-broker", "ledger.json"), "utf8"),
    );
    expect(Object.values(ledger.dispatches)).toContainEqual(
      expect.objectContaining({ status: "released", reason: "launch_unaccepted" }),
    );
  });

  // The plugin must fail closed rather than provide a global fallback when the host request binding is absent.
  it("reports a missing request-scoped runtime binding and releases its reservation", async () => {
    api.runtime.subagent.run = vi.fn(async () => {
      const error = Object.assign(
        new Error("Plugin runtime subagent methods are only available during a gateway request."),
        {
          code: "OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE",
        },
      );
      throw error;
    });
    const g = await goal();
    const result = await dispatch("test", {
      ...base(g.id, "legacy-reader", "subagent"),
      read_only: true,
    });
    expect(result.details).toEqual({ error: "subagent_runtime_request_scope_unavailable" });
    expect(result.content?.[0]?.text).toContain("host-provided request-scoped subagent runtime");
    expect(result.content?.[0]?.text).toContain("E2E child completion is unverified");
    const ledger = JSON.parse(
      await (await import("node:fs/promises")).readFile(join(goalsDir, "dispatch-broker", "ledger.json"), "utf8"),
    );
    expect(Object.values(ledger.dispatches)).toContainEqual(
      expect.objectContaining({ status: "released", reason: "launch_failed" }),
    );
  });

  it.each(["completed", "abandoned"] as const)(
    "rejects a stale wake for a %s goal without launching",
    async (status) => {
      const g = await goal();
      await terminateGoal(goalsDir, g.id, status, "terminal before stale wake", "user");

      const result = await dispatch("stale-wake", {
        ...base(g.id, "legacy-reader", "subagent"),
        read_only: true,
      });

      expect(result.details).toMatchObject({ error: "goal_terminal", goal_id: g.id, status });
      expect(run).not.toHaveBeenCalled();
      expect((await import("node:fs")).existsSync(join(goalsDir, "dispatch-broker", "ledger.json"))).toBe(false);
    },
  );

  it("never invokes the runtime when policy denies the request", async () => {
    const g = await goal();
    const result = await dispatch("test", {
      ...base(g.id, "writer", "subagent"),
      task_class: "governance_readonly",
      read_only: true,
    });
    expect(result.details?.error).toBe("dispatch_policy_denied");
    expect(run).not.toHaveBeenCalled();
  });
});
