import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { registerCleanupHandlers } from "../lifecycle/stage-cleanup.js";
import type { LifecycleContext } from "../lifecycle/types.js";
import * as activeTaskModule from "../services/active-task.js";
import {
  readActiveTaskFile,
  readPendingSignals,
  writeActiveTaskFile,
  writeTaskSignal,
} from "../services/active-task.js";
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
      ledger: "markdown",
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

describe("stage-cleanup markdown ledger signal consumption", () => {
  let workspaceRoot: string;
  let activeTaskPath: string;
  let memoryDir: string;
  let ctx: LifecycleContext;
  let api: ReturnType<typeof createMockPluginApi>;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "stage-cleanup-markdown-"));
    activeTaskPath = join(workspaceRoot, "ACTIVE-TASKS.md");
    memoryDir = join(workspaceRoot, "memory");
    await mkdir(memoryDir, { recursive: true });
    const { vectorDb, embeddings } = activeTaskStubs();
    ctx = {
      cfg: parseCfg(),
      factsDb: null,
      vectorDb,
      embeddings,
      currentAgentIdRef: { value: "test-agent" },
      auditStore: null,
    } as unknown as LifecycleContext;
    api = createMockPluginApi();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const apiWithLogger = {
      ...api,
      logger,
      context: { sessionKey: "agent:main:main" },
    } as unknown as ClawdbotPluginApi;
    registerCleanupHandlers(apiWithLogger, ctx, {} as never, activeTaskPath, workspaceRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("deletes terminal task signals without requiring ACTIVE-TASKS.md write", async () => {
    const now = new Date().toISOString();
    await writeActiveTaskFile(
      activeTaskPath,
      [
        {
          label: "terminal-failed",
          description: "Already failed",
          status: "Failed",
          started: now,
          updated: now,
        },
      ],
      [],
    );
    await writeTaskSignal(
      "terminal-failed",
      {
        agent: "worker",
        taskRef: "terminal-failed",
        signal: "blocked",
        summary: "should not reopen",
        timestamp: now,
      },
      memoryDir,
    );

    await api.emitAll(
      "subagent_ended",
      {
        label: "unrelated-task",
        targetSessionKey: "agent:main:subagent:ghost",
        success: false,
        outcome: "error",
      },
      { sessionKey: "agent:main:main" },
    );

    expect(await readPendingSignals(memoryDir)).toHaveLength(0);
    const file = await readActiveTaskFile(activeTaskPath, 1440);
    const task = file?.active.find((t) => t.label === "terminal-failed");
    expect(task?.status).toBe("Failed");
    expect(task?.next ?? "").not.toContain("should not reopen");
  });

  it("does not clobber a concurrent write when subagent_spawned races another ACTIVE-TASKS.md writer (#48)", async () => {
    const now = new Date().toISOString();
    await writeActiveTaskFile(
      activeTaskPath,
      [{ label: "task-a", description: "d", status: "Waiting", started: now, updated: now }],
      [],
    );

    // Simulate a concurrent writer (e.g. a second subagent_spawned/subagent_ended handler)
    // committing a change to a *different* task between this handler's pre-write read and its
    // optimistic write attempt — the exact race window the fix closes.
    const realReadWithMtime = activeTaskModule.readActiveTaskFileWithMtime;
    const spy = vi.spyOn(activeTaskModule, "readActiveTaskFileWithMtime");
    spy.mockImplementationOnce(async (path, staleMinutes) => {
      const stale = await realReadWithMtime(path, staleMinutes);
      const fresh = await realReadWithMtime(path, staleMinutes);
      await writeActiveTaskFile(
        path,
        [
          ...(fresh?.active ?? []),
          { label: "task-b", description: "concurrent", status: "In progress", started: now, updated: now },
        ],
        fresh?.completed ?? [],
      );
      return stale;
    });

    await api.emitAll(
      "subagent_spawned",
      { label: "task-a", childSessionKey: "agent:main:subagent:x" },
      { sessionKey: "agent:main:main" },
    );

    const file = await readActiveTaskFile(activeTaskPath, 1440);
    // This handler's own update must have landed...
    expect(file?.active.find((t) => t.label === "task-a")?.status).toBe("In progress");
    // ...and the concurrent writer's task must NOT have been clobbered.
    expect(file?.active.find((t) => t.label === "task-b")).toBeDefined();
  });

  it("does not clobber a concurrent write when subagent_ended races another ACTIVE-TASKS.md writer (#48)", async () => {
    const now = new Date().toISOString();
    await writeActiveTaskFile(
      activeTaskPath,
      [
        {
          label: "task-a",
          description: "d",
          status: "In progress",
          subagent: "agent:main:subagent:x",
          started: now,
          updated: now,
        },
      ],
      [],
    );

    const realReadWithMtime = activeTaskModule.readActiveTaskFileWithMtime;
    const spy = vi.spyOn(activeTaskModule, "readActiveTaskFileWithMtime");
    let injected = false;
    spy.mockImplementation(async (path, staleMinutes) => {
      const stale = await realReadWithMtime(path, staleMinutes);
      if (!injected) {
        injected = true;
        const fresh = await realReadWithMtime(path, staleMinutes);
        await writeActiveTaskFile(
          path,
          [
            ...(fresh?.active ?? []),
            { label: "task-b", description: "concurrent", status: "In progress", started: now, updated: now },
          ],
          fresh?.completed ?? [],
        );
      }
      return stale;
    });

    await api.emitAll(
      "subagent_ended",
      { label: "task-a", targetSessionKey: "agent:main:subagent:x", success: true, outcome: "ok" },
      { sessionKey: "agent:main:main" },
    );
    spy.mockRestore();

    const file = await readActiveTaskFile(activeTaskPath, 1440);
    // task-a completed and moved to the completed section.
    expect(file?.active.find((t) => t.label === "task-a")).toBeUndefined();
    expect(file?.completed.find((t) => t.label === "task-a")?.status).toBe("Done");
    // The concurrent writer's task-b must survive in the active section.
    expect(file?.active.find((t) => t.label === "task-b")).toBeDefined();
  });
});
