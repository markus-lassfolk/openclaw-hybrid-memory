import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import { registerCleanupHandlers } from "../lifecycle/stage-cleanup.js";
import type { LifecycleContext } from "../lifecycle/types.js";
import { readPendingSignals, writeTaskSignal } from "../services/active-task.js";
import { loadTaskLedgerFromFacts } from "../services/task-ledger-facts.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { VectorDB } from "../backends/vector-db.js";
import { createMockPluginApi } from "./harness/mock-plugin-api.js";

function parseCfg() {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
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

describe("stage-cleanup facts ledger subagent hooks", () => {
  let workspaceRoot: string;
  let factsPath: string;
  let factsDb: FactsDB;
  let ctx: LifecycleContext;
  let api: ReturnType<typeof createMockPluginApi>;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "stage-cleanup-facts-"));
    factsPath = join(workspaceRoot, "facts.db");
    factsDb = new FactsDB(factsPath);
    const { vectorDb, embeddings } = activeTaskStubs();
    ctx = {
      cfg: parseCfg(),
      factsDb,
      vectorDb,
      embeddings,
      currentAgentIdRef: { value: "test-agent" },
      auditStore: null,
    } as LifecycleContext;
    api = createMockPluginApi();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const apiWithLogger = {
      ...api,
      logger,
      context: { sessionKey: "agent:main:subagent:worker-1" },
    } as unknown as ClawdbotPluginApi;
    registerCleanupHandlers(apiWithLogger, ctx, {} as never, join(workspaceRoot, "ACTIVE-TASKS.md"), workspaceRoot);
  });

  afterEach(async () => {
    factsDb.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("subagent_spawned writes facts ledger rows from sub-agent sessions", async () => {
    await api.emitAll(
      "subagent_spawned",
      {
        label: "facts-sub-task",
        childSessionKey: "agent:main:subagent:child-1",
        task: "Run isolated subagent work",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const { active } = loadTaskLedgerFromFacts(factsDb);
    expect(active.some((t) => t.label === "facts-sub-task" && t.status === "In progress")).toBe(true);
    expect(active.find((t) => t.label === "facts-sub-task")?.subagent).toBe("agent:main:subagent:child-1");
  });

  it("subagent_ended marks facts ledger task Done from sub-agent sessions", async () => {
    await api.emitAll(
      "subagent_spawned",
      {
        label: "facts-done-task",
        childSessionKey: "agent:main:subagent:child-done",
        task: "Completable subagent work",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    await api.emitAll(
      "subagent_ended",
      {
        label: "facts-done-task",
        targetSessionKey: "agent:main:subagent:child-done",
        success: true,
        outcome: "success",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const { active, completed } = loadTaskLedgerFromFacts(factsDb);
    expect(active.some((t) => t.label === "facts-done-task")).toBe(false);
    expect(completed.some((t) => t.label === "facts-done-task" && t.status === "Done")).toBe(true);
  });

  it("consumes writeTaskSignal updates from sub-agent sessions when ledger is facts", async () => {
    const memoryDir = join(workspaceRoot, "memory");
    await mkdir(memoryDir, { recursive: true });
    const now = new Date().toISOString();

    factsDb.store({
      category: "project",
      importance: 0.7,
      source: "active-task",
      decayClass: "permanent",
      entity: "signal-task",
      key: "title",
      value: "Awaiting subagent signal",
      text: "Task [signal-task] title: Awaiting subagent signal",
    });
    factsDb.store({
      category: "project",
      importance: 0.7,
      source: "active-task",
      decayClass: "permanent",
      entity: "signal-task",
      key: "status",
      value: "in_progress",
      text: "Task [signal-task] status: in_progress",
    });
    factsDb.store({
      category: "project",
      importance: 0.7,
      source: "active-task",
      decayClass: "permanent",
      entity: "signal-task",
      key: "task_updated",
      value: now,
      text: `Task [signal-task] task_updated: ${now}`,
    });
    factsDb.store({
      category: "project",
      importance: 0.7,
      source: "active-task",
      decayClass: "permanent",
      entity: "signal-task",
      key: "started",
      value: now,
      text: `Task [signal-task] started: ${now}`,
    });

    await writeTaskSignal(
      "signal-task",
      {
        agent: "worker-1",
        taskRef: "signal-task",
        signal: "update",
        summary: "Subagent progress checkpoint",
        timestamp: now,
      },
      memoryDir,
    );

    await api.emitAll(
      "subagent_ended",
      {
        label: "nonexistent-task",
        targetSessionKey: "agent:main:subagent:missing",
        success: false,
        outcome: "failed",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const { active } = loadTaskLedgerFromFacts(factsDb);
    const task = active.find((t) => t.label === "signal-task");
    expect(task?.next).toContain("[Signal: update]");
    expect(task?.next).toContain("Subagent progress checkpoint");
    expect(await readPendingSignals(memoryDir)).toHaveLength(0);
  });

  it("subagent_ended applies blocked signals before auto-complete and keeps task active", async () => {
    const memoryDir = join(workspaceRoot, "memory");
    await mkdir(memoryDir, { recursive: true });
    const now = new Date().toISOString();

    await api.emitAll(
      "subagent_spawned",
      {
        label: "blocked-before-end",
        childSessionKey: "agent:main:subagent:blocked-child",
        task: "Work that gets blocked",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    await writeTaskSignal(
      "blocked-before-end",
      {
        agent: "worker-1",
        taskRef: "blocked-before-end",
        signal: "blocked",
        summary: "Waiting on external approval",
        timestamp: now,
      },
      memoryDir,
    );

    await api.emitAll(
      "subagent_ended",
      {
        label: "blocked-before-end",
        targetSessionKey: "agent:main:subagent:blocked-child",
        success: true,
        outcome: "success",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const { active, completed } = loadTaskLedgerFromFacts(factsDb);
    expect(completed.some((t) => t.label === "blocked-before-end")).toBe(false);
    const task = active.find((t) => t.label === "blocked-before-end");
    expect(task?.status).toBe("Stalled");
    expect(task?.next).toContain("[Signal: blocked]");
    expect(await readPendingSignals(memoryDir)).toHaveLength(0);
  });

  it("subagent_spawned skips auto-checkpoint when session metadata is missing", async () => {
    await api.emitAll(
      "subagent_spawned",
      {
        label: "missing-session-task",
        task: "Dispatch without session key",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const { active } = loadTaskLedgerFromFacts(factsDb);
    expect(active.some((t) => t.label === "missing-session-task")).toBe(false);
  });

  it("subagent_spawned reopens Failed tasks when session metadata is present", async () => {
    const now = new Date().toISOString();
    for (const [key, value] of [
      ["title", "Previously failed"],
      ["status", "failed"],
      ["task_updated", now],
      ["started", now],
    ] as const) {
      factsDb.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "failed-retry-task",
        key,
        value,
        text: `Task [failed-retry-task] ${key}: ${value}`,
      });
    }

    await api.emitAll(
      "subagent_spawned",
      {
        label: "failed-retry-task",
        childSessionKey: "agent:main:subagent:retry-child",
        task: "Retry after failure",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const { active } = loadTaskLedgerFromFacts(factsDb);
    const task = active.find((t) => t.label === "failed-retry-task");
    expect(task?.status).toBe("In progress");
    expect(task?.subagent).toBe("agent:main:subagent:retry-child");
  });

  it("subagent_spawned clears stale handoff when reopening Failed tasks", async () => {
    const now = new Date().toISOString();
    const handoff = JSON.stringify({
      schema: "octave/task-handoff@v1",
      artifactId: "artifact-failed",
      signal: "update",
      agent: "worker",
      timestamp: now,
      checksum: "deadbeef",
    });
    for (const [key, value] of [
      ["title", "Previously failed"],
      ["status", "failed"],
      ["task_updated", now],
      ["started", now],
      ["handoff", handoff],
    ] as const) {
      factsDb.store({
        category: "project",
        importance: 0.7,
        source: "active-task",
        decayClass: "permanent",
        entity: "failed-handoff-task",
        key,
        value,
        text: `Task [failed-handoff-task] ${key}: ${value}`,
      });
    }

    await api.emitAll(
      "subagent_spawned",
      {
        label: "failed-handoff-task",
        childSessionKey: "agent:main:subagent:retry-handoff",
        task: "Retry after failure",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const { active } = loadTaskLedgerFromFacts(factsDb);
    const task = active.find((t) => t.label === "failed-handoff-task");
    expect(task?.status).toBe("In progress");
    expect(task?.handoff).toBeUndefined();
  });

  it("clears related_session when subagent_ended marks task Done", async () => {
    await api.emitAll(
      "subagent_spawned",
      {
        label: "done-clears-session",
        childSessionKey: "agent:main:subagent:done-child",
        task: "Completable work",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    await api.emitAll(
      "subagent_ended",
      {
        label: "done-clears-session",
        targetSessionKey: "agent:main:subagent:done-child",
        success: true,
        outcome: "success",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const { completed } = loadTaskLedgerFromFacts(factsDb);
    const task = completed.find((t) => t.label === "done-clears-session");
    expect(task?.status).toBe("Done");
    expect(task?.subagent).toBeUndefined();
  });

  it("clears related_session when subagent_ended marks task Failed", async () => {
    await api.emitAll(
      "subagent_spawned",
      {
        label: "failed-clears-session",
        childSessionKey: "agent:main:subagent:failed-child",
        task: "Failing work",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const failedAt = new Date().toISOString();
    const handoff = JSON.stringify({
      schema: "octave/task-handoff@v1",
      artifactId: "failed-artifact",
      signal: "update",
      agent: "worker",
      timestamp: failedAt,
      checksum: "abc123",
    });
    factsDb.store({
      category: "project",
      importance: 0.7,
      source: "active-task",
      decayClass: "permanent",
      entity: "failed-clears-session",
      key: "handoff",
      value: handoff,
      text: `Task [failed-clears-session] handoff: ${handoff}`,
    });

    await api.emitAll(
      "subagent_ended",
      {
        label: "failed-clears-session",
        targetSessionKey: "agent:main:subagent:failed-child",
        success: false,
        outcome: "error",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const { active } = loadTaskLedgerFromFacts(factsDb);
    const task = active.find((t) => t.label === "failed-clears-session");
    expect(task?.status).toBe("Failed");
    expect(task?.subagent).toBeUndefined();
    expect(task?.handoff).toBeUndefined();
  });

  it("subagent_ended does not auto-complete when success is ambiguous", async () => {
    await api.emitAll(
      "subagent_spawned",
      {
        label: "ambiguous-end-task",
        childSessionKey: "agent:main:subagent:ambiguous",
        task: "Unclear outcome work",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    await api.emitAll(
      "subagent_ended",
      {
        label: "ambiguous-end-task",
        targetSessionKey: "agent:main:subagent:ambiguous",
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const { active, completed } = loadTaskLedgerFromFacts(factsDb);
    expect(completed.some((t) => t.label === "ambiguous-end-task")).toBe(false);
    expect(active.some((t) => t.label === "ambiguous-end-task" && t.status === "Failed")).toBe(true);
  });
});
