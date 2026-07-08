/**
 * loop iteration 93 regression: loadTaskLedgerFromFacts/loadTaskLedgerFromFactsWithMetrics must be
 * called with a scopeFilter derived from the caller's identity at every lifecycle-stage call site,
 * matching the already-correct pattern in services/goal-context-injection.ts and
 * services/active-task-tools-loader.ts (see the SECURITY comments on those two call sites).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { hybridConfigSchema } from "../config.js";
import { registerActiveTaskInjection } from "../lifecycle/stage-active-task.js";
import { registerCleanupHandlers } from "../lifecycle/stage-cleanup.js";
import { registerGoalSubagentHandlers } from "../lifecycle/stage-goal-subagent.js";
import type { LifecycleContext } from "../lifecycle/types.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { createGoal, resolveGoalsDir } from "../services/goal-registry.js";
import { resetStartupMemoryAttributionForTests } from "../services/startup-memory-attribution.js";
import { loadTaskLedgerFromFacts, loadTaskLedgerFromFactsWithMetrics } from "../services/task-ledger-facts.js";
import { createMockPluginApi } from "./harness/mock-plugin-api.js";

vi.mock("../services/task-ledger-facts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-ledger-facts.js")>();
  return {
    ...actual,
    loadTaskLedgerFromFacts: vi.fn(actual.loadTaskLedgerFromFacts),
    loadTaskLedgerFromFactsWithMetrics: vi.fn(actual.loadTaskLedgerFromFactsWithMetrics),
  };
});

function parseCfg(overrides: Record<string, unknown> = {}) {
  return hybridConfigSchema.parse({
    embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
    activeTask: {
      enabled: true,
      ledger: "facts",
      autoCheckpoint: true,
      filePath: "ACTIVE-TASKS.md",
      taskHygiene: { longRunningRegistration: { mode: "off" } },
    },
    goalStewardship: { enabled: true, goalsDir: "state/goals" },
    ...overrides,
  });
}

const SUB_AGENT_SCOPE = { userId: null, agentId: "sub-agent-x", sessionId: null };

describe("task-ledger-facts scope threading (loop iteration 93 regression)", () => {
  let workspaceRoot: string;
  let factsDb: FactsDB;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "task-ledger-scope-"));
    await mkdir(join(workspaceRoot, "state", "goals"), { recursive: true });
    factsDb = new FactsDB(join(workspaceRoot, "facts.db"));
    vi.mocked(loadTaskLedgerFromFacts).mockClear();
    vi.mocked(loadTaskLedgerFromFactsWithMetrics).mockClear();
  });

  afterEach(async () => {
    resetStartupMemoryAttributionForTests();
    factsDb.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("stage-active-task.ts threads the sub-agent's scopeFilter into loadTaskLedgerFromFactsWithMetrics", async () => {
    const cfg = parseCfg();
    const ctx = { cfg, factsDb, currentAgentIdRef: { value: "sub-agent-x" } } as LifecycleContext;
    const api = createMockPluginApi();
    const apiWithLogger = {
      ...api,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      context: {},
    } as unknown as ClawdbotPluginApi;

    registerActiveTaskInjection(apiWithLogger, ctx, join(workspaceRoot, "ACTIVE-TASKS.md"), workspaceRoot);
    await api.emitFirstResult("before_agent_start", { messages: [{ role: "user", content: "status?" }] }, {});

    expect(loadTaskLedgerFromFactsWithMetrics).toHaveBeenCalledWith(factsDb, undefined, SUB_AGENT_SCOPE);
  });

  it("stage-cleanup.ts threads the sub-agent's scopeFilter into loadTaskLedgerFromFacts on subagent_spawned and subagent_ended", async () => {
    const cfg = parseCfg();
    const vectorDb = { hasDuplicate: async () => true, store: async () => {} } as unknown as VectorDB;
    const embeddings = {
      modelName: "test-model",
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
    } as unknown as EmbeddingProvider;
    const ctx = {
      cfg,
      factsDb,
      vectorDb,
      embeddings,
      currentAgentIdRef: { value: "sub-agent-x" },
      auditStore: null,
    } as LifecycleContext;
    const api = createMockPluginApi();
    const apiWithLogger = {
      ...api,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      context: {},
    } as unknown as ClawdbotPluginApi;

    registerCleanupHandlers(apiWithLogger, ctx, {} as never, join(workspaceRoot, "ACTIVE-TASKS.md"), workspaceRoot);

    await api.emitAll("subagent_spawned", {
      label: "cross-tenant-check",
      childSessionKey: "agent:main:subagent:t1",
      task: "Do the thing",
    });
    expect(loadTaskLedgerFromFacts).toHaveBeenCalledWith(factsDb, undefined, SUB_AGENT_SCOPE);

    vi.mocked(loadTaskLedgerFromFacts).mockClear();
    await api.emitAll("subagent_ended", {
      label: "cross-tenant-check",
      targetSessionKey: "agent:main:subagent:t1",
      status: "success",
    });
    for (const call of vi.mocked(loadTaskLedgerFromFacts).mock.calls) {
      expect(call).toEqual([factsDb, undefined, SUB_AGENT_SCOPE]);
    }
    expect(vi.mocked(loadTaskLedgerFromFacts).mock.calls.length).toBeGreaterThan(0);
  });

  it("stage-goal-subagent.ts threads the sub-agent's scopeFilter into loadTaskLedgerFromFacts on subagent_spawned", async () => {
    const cfg = parseCfg();
    const ctx = {
      cfg,
      factsDb,
      currentAgentIdRef: { value: "sub-agent-x" },
    } as LifecycleContext;
    const api = createMockPluginApi();
    const apiWithLogger = {
      ...api,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      context: {},
    } as unknown as ClawdbotPluginApi;

    const goalsDir = resolveGoalsDir(workspaceRoot, cfg.goalStewardship.goalsDir);
    const goal = await createGoal(
      goalsDir,
      { label: "deploy-api", description: "Deploy API", acceptanceCriteria: ["live"] },
      { maxDispatches: 20, maxAssessments: 50, cooldownMinutes: 10, escalateAfterFailures: 3, priority: "normal" },
    );
    registerGoalSubagentHandlers(apiWithLogger, ctx, goalsDir);

    await api.emitAll("subagent_spawned", {
      goalId: goal.id,
      label: "goal-linked-task",
      childSessionKey: "agent:main:subagent:t2",
      task: "Do the goal thing",
    });

    expect(loadTaskLedgerFromFacts).toHaveBeenCalledWith(factsDb, undefined, SUB_AGENT_SCOPE);
  });
});
