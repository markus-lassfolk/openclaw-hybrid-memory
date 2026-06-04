import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { hybridConfigSchema } from "../config.js";
import { registerCleanupHandlers } from "../lifecycle/stage-cleanup.js";
import { registerGoalSubagentHandlers } from "../lifecycle/stage-goal-subagent.js";
import type { LifecycleContext } from "../lifecycle/types.js";
import { createGoal } from "../services/goal-registry.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { resolveGoalsDir } from "../services/goal-stewardship.js";
import { loadTaskLedgerFromFacts } from "../services/task-ledger-facts.js";
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
    activeTask: {
      enabled: true,
      ledger: "facts",
      autoCheckpoint: true,
      filePath: "ACTIVE-TASKS.md",
    },
  });
}

function activeTaskStubs(): { vectorDb: VectorDB; embeddings: EmbeddingProvider } {
  return {
    vectorDb: {
      hasDuplicate: async () => true,
      store: async () => {},
    } as unknown as VectorDB,
    embeddings: {
      modelName: "test-model",
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    } as unknown as EmbeddingProvider,
  };
}

describe("stage-goal-subagent facts ledger linking", () => {
  let workspaceRoot: string;
  let goalsDir: string;
  let factsDb: FactsDB;
  let ctx: LifecycleContext;
  let api: ReturnType<typeof createMockPluginApi>;
  let prevWorkspace: string | undefined;

  beforeEach(async () => {
    prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    workspaceRoot = await mkdtemp(join(tmpdir(), "goal-subagent-facts-"));
    await mkdir(join(workspaceRoot, "state", "goals"), { recursive: true });
    setEnv("OPENCLAW_WORKSPACE", workspaceRoot);
    const cfg = parseCfg();
    goalsDir = resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir);
    factsDb = new FactsDB(join(workspaceRoot, "facts.db"));
    const { vectorDb, embeddings } = activeTaskStubs();
    ctx = {
      cfg,
      factsDb,
      vectorDb,
      embeddings,
      currentAgentIdRef: { value: "test-agent" },
      auditStore: null,
    } as LifecycleContext;
    api = createMockPluginApi();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const apiWithLogger = { ...api, logger, context: {} } as unknown as ClawdbotPluginApi;
    registerGoalSubagentHandlers(apiWithLogger, ctx, goalsDir);
    registerCleanupHandlers(
      apiWithLogger,
      ctx,
      {} as never,
      join(workspaceRoot, "ACTIVE-TASKS.md"),
      workspaceRoot,
    );
  });

  afterEach(async () => {
    setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    factsDb.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("writes related_goal to facts ledger when subagent_spawned resolves a goal", async () => {
    const goal = await createGoal(
      goalsDir,
      { label: "deploy-api", description: "Deploy API", acceptanceCriteria: ["live"] },
      {
        maxDispatches: 20,
        maxAssessments: 50,
        cooldownMinutes: 10,
        escalateAfterFailures: 3,
        priority: "normal",
      },
    );

    await api.emitAll("subagent_spawned", {
      goalId: goal.id,
      label: "deploy-api-run-tests",
      childSessionKey: "agent:main:subagent:tests-1",
      task: "Run deploy-api test suite",
    });

    const { active } = loadTaskLedgerFromFacts(factsDb);
    const task = active.find((t) => t.label === "deploy-api-run-tests");
    expect(task?.relatedGoal).toBe(goal.id);
    expect(task?.subagent).toBe("agent:main:subagent:tests-1");

    const row = factsDb
      .listFactsByCategory("project", 50)
      .find((f) => f.entity === "deploy-api-run-tests" && f.key === "related_goal");
    expect(row?.value).toBe(goal.id);
  });

  it("writes related_goal and failed status when dispatch metadata is missing", async () => {
    const goal = await createGoal(
      goalsDir,
      { label: "deploy-metadata", description: "Deploy API", acceptanceCriteria: ["live"] },
      {
        maxDispatches: 20,
        maxAssessments: 50,
        cooldownMinutes: 10,
        escalateAfterFailures: 3,
        priority: "normal",
      },
    );

    await api.emitAll("subagent_spawned", {
      goalId: goal.id,
      label: "deploy-metadata-task",
      task: "Missing session metadata",
    });

    const { active } = loadTaskLedgerFromFacts(factsDb);
    const task = active.find((t) => t.label === "deploy-metadata-task");
    expect(task?.relatedGoal).toBe(goal.id);
    expect(task?.status).toBe("Failed");
    expect(task?.next).toContain("missing ACP session metadata");
    expect(task?.subagent).toBeUndefined();
  });

  it("clears stale subagent when dispatch metadata is missing on retry", async () => {
    const goal = await createGoal(
      goalsDir,
      { label: "retry-dispatch", description: "Deploy API", acceptanceCriteria: ["live"] },
      {
        maxDispatches: 20,
        maxAssessments: 50,
        cooldownMinutes: 10,
        escalateAfterFailures: 3,
        priority: "normal",
      },
    );

    await api.emitAll("subagent_spawned", {
      goalId: goal.id,
      label: "retry-dispatch-task",
      childSessionKey: "agent:main:subagent:stale-1",
      task: "First dispatch",
    });

    await api.emitAll("subagent_spawned", {
      goalId: goal.id,
      label: "retry-dispatch-task",
      task: "Retry without session metadata",
    });

    const { active } = loadTaskLedgerFromFacts(factsDb);
    const task = active.find((t) => t.label === "retry-dispatch-task");
    expect(task?.status).toBe("Failed");
    expect(task?.subagent).toBeUndefined();
  });

  it("reopens Failed task as In progress on successful re-dispatch", async () => {
    const goal = await createGoal(
      goalsDir,
      { label: "retry-open", description: "Deploy API", acceptanceCriteria: ["live"] },
      {
        maxDispatches: 20,
        maxAssessments: 50,
        cooldownMinutes: 10,
        escalateAfterFailures: 3,
        priority: "normal",
      },
    );

    await api.emitAll("subagent_spawned", {
      goalId: goal.id,
      label: "retry-open-task",
      task: "Missing session metadata",
    });

    await api.emitAll("subagent_spawned", {
      goalId: goal.id,
      label: "retry-open-task",
      childSessionKey: "agent:main:subagent:retry-2",
      task: "Retry with session",
    });

    const { active } = loadTaskLedgerFromFacts(factsDb);
    const task = active.find((t) => t.label === "retry-open-task");
    expect(task?.status).toBe("In progress");
    expect(task?.subagent).toBe("agent:main:subagent:retry-2");
    expect(task?.relatedGoal).toBe(goal.id);
  });

  it("clears stale failure next on successful re-dispatch", async () => {
    const goal = await createGoal(
      goalsDir,
      { label: "retry-next", description: "Deploy API", acceptanceCriteria: ["live"] },
      {
        maxDispatches: 20,
        maxAssessments: 50,
        cooldownMinutes: 10,
        escalateAfterFailures: 3,
        priority: "normal",
      },
    );

    await api.emitAll("subagent_spawned", {
      goalId: goal.id,
      label: "retry-next-task",
      task: "Missing session metadata",
    });

    await api.emitAll("subagent_spawned", {
      goalId: goal.id,
      label: "retry-next-task",
      childSessionKey: "agent:main:subagent:retry-next-2",
      task: "Retry with session",
    });

    const { active } = loadTaskLedgerFromFacts(factsDb);
    const task = active.find((t) => t.label === "retry-next-task");
    expect(task?.status).toBe("In progress");
    expect(task?.next ?? "").not.toContain("missing ACP session metadata");
  });
});
