import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { hybridConfigSchema } from "../config.js";
import { registerActiveTaskInjection } from "../lifecycle/stage-active-task.js";
import { registerGoalStewardshipInjection } from "../lifecycle/stage-goal-stewardship.js";
import type { LifecycleContext } from "../lifecycle/types.js";
import { createGoal } from "../services/goal-registry.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { resolveGoalsDir } from "../services/goal-stewardship.js";
import { syncActiveTaskEntryToFacts } from "../services/task-ledger-facts.js";
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
      heartbeatRefreshActiveTask: true,
      watchdogHealthCheck: true,
    },
    activeTask: {
      enabled: true,
      ledger: "facts",
      autoCheckpoint: true,
      filePath: "ACTIVE-TASKS.md",
      injectionBudget: 2000,
      taskHygiene: {
        heartbeatEscalation: true,
        heartbeatNudgeMaxChars: 800,
        suggestGoalAfterTaskAgeDays: 7,
        longRunningRegistration: { mode: "off" },
      },
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

describe("heartbeat active-task + goal stewardship (facts ledger)", () => {
  let workspaceRoot: string;
  let goalsDir: string;
  let activeTaskPath: string;
  let factsDb: FactsDB;
  let ctx: LifecycleContext;
  let prevWorkspace: string | undefined;

  beforeEach(async () => {
    prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    workspaceRoot = await mkdtemp(join(tmpdir(), "heartbeat-facts-int-"));
    await mkdir(join(workspaceRoot, "state", "goals"), { recursive: true });
    setEnv("OPENCLAW_WORKSPACE", workspaceRoot);
    const cfg = parseCfg();
    goalsDir = resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir);
    activeTaskPath = join(workspaceRoot, "ACTIVE-TASKS.md");
    factsDb = new FactsDB(join(workspaceRoot, "facts.db"));
    const { vectorDb, embeddings } = activeTaskStubs();
    ctx = {
      cfg,
      factsDb,
      vectorDb,
      embeddings,
      openai: null,
      currentAgentIdRef: { value: "test-agent" },
    } as LifecycleContext;
  });

  afterEach(async () => {
    setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    factsDb.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("heartbeat renders facts projection with goals mirror on ACTIVE-TASKS.md", async () => {
    const api = createMockPluginApi();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const apiWithLogger = {
      ...api,
      logger,
      context: { sessionKey: "agent:main:main" },
    } as unknown as ClawdbotPluginApi;

    registerGoalStewardshipInjection(apiWithLogger, ctx, goalsDir, activeTaskPath);

    await createGoal(
      goalsDir,
      { label: "deploy-api", description: "Deploy API service", acceptanceCriteria: ["live"] },
      {
        maxDispatches: 20,
        maxAssessments: 50,
        cooldownMinutes: 1,
        escalateAfterFailures: 3,
        priority: "normal",
      },
    );

    const now = new Date().toISOString();
    await syncActiveTaskEntryToFacts(factsDb, ctx.vectorDb, ctx.embeddings, {
      label: "deploy-api-queue",
      description: "Process deploy-api PR queue",
      status: "In progress",
      started: now,
      updated: now,
    });

    await api.emitAll("before_agent_start", { messages: [{ role: "user", content: "Scheduled heartbeat ping" }] });

    const rendered = await readFile(activeTaskPath, "utf-8");
    expect(rendered).toContain("deploy-api-queue");
    expect(rendered).toContain("## Active Goals");
    expect(rendered).toContain("deploy-api");
    expect(rendered).toContain("Projection");
  });

  it("active-task injection includes goal-linked tasks on heartbeat", async () => {
    const api = createMockPluginApi();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const apiWithLogger = {
      ...api,
      logger,
      context: { sessionKey: "agent:main:main" },
    } as unknown as ClawdbotPluginApi;

    registerActiveTaskInjection(apiWithLogger, ctx, activeTaskPath, workspaceRoot);

    const goal = await createGoal(
      goalsDir,
      { label: "deploy-api", description: "Deploy API service", acceptanceCriteria: ["live"] },
      {
        maxDispatches: 20,
        maxAssessments: 50,
        cooldownMinutes: 1,
        escalateAfterFailures: 3,
        priority: "normal",
      },
    );

    const now = new Date().toISOString();
    await syncActiveTaskEntryToFacts(factsDb, ctx.vectorDb, ctx.embeddings, {
      label: "deploy-api-queue",
      description: "Process deploy-api PR queue",
      status: "In progress",
      relatedGoal: goal.id,
      started: now,
      updated: now,
    });

    const result = await api.emitFirstResult(
      "before_agent_start",
      { messages: [{ role: "user", content: "Scheduled heartbeat ping" }] },
      { sessionKey: "agent:main:main" },
    );

    const prep = (result as { prependContext?: string } | undefined)?.prependContext ?? "";
    expect(prep).toContain("<active-tasks>");
    expect(prep).toContain("deploy-api-queue");
    expect(prep).toContain("Related goal");
  });

  it("goal stewardship injection skips subagent sessions on heartbeat", async () => {
    const api = createMockPluginApi();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const apiWithLogger = {
      ...api,
      logger,
      context: { sessionKey: "agent:main:subagent:worker-1" },
    } as unknown as ClawdbotPluginApi;

    registerGoalStewardshipInjection(apiWithLogger, ctx, goalsDir, activeTaskPath);

    await createGoal(
      goalsDir,
      { label: "deploy-api", description: "Deploy API service", acceptanceCriteria: ["live"] },
      {
        maxDispatches: 20,
        maxAssessments: 50,
        cooldownMinutes: 1,
        escalateAfterFailures: 3,
        priority: "normal",
      },
    );

    const result = await api.emitFirstResult(
      "before_agent_start",
      { messages: [{ role: "user", content: "Scheduled heartbeat ping" }] },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    expect(result).toBeUndefined();
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("goal stewardship bundle"));
  });
});
