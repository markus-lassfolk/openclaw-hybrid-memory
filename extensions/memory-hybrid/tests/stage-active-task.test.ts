import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { hybridConfigSchema } from "../config.js";
import { registerActiveTaskInjection } from "../lifecycle/stage-active-task.js";
import type { LifecycleContext } from "../lifecycle/types.js";
import { readActiveTaskFile } from "../services/active-task.js";
import { resetStartupMemoryAttributionForTests } from "../services/startup-memory-attribution.js";
import { createMockPluginApi } from "./harness/mock-plugin-api.js";

function parseCfg(overrides: Record<string, unknown>) {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
    },
    activeTask: {
      enabled: true,
      ledger: "markdown",
      filePath: "ACTIVE-TASKS.md",
      taskHygiene: {
        longRunningRegistration: {
          mode: "suggest",
        },
      },
    },
    ...overrides,
  });
}

describe("stage-active-task long-running registration", () => {
  let workspaceRoot: string;
  let activeTaskPath: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "stage-active-task-"));
    activeTaskPath = join(workspaceRoot, "ACTIVE-TASKS.md");
  });

  afterEach(async () => {
    resetStartupMemoryAttributionForTests();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("prepends suggested payload for PR queue workflows", async () => {
    const cfg = parseCfg({});
    const ctx = { cfg } as LifecycleContext;
    const api = createMockPluginApi();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const apiWithLogger = { ...api, logger, context: {} } as unknown as ClawdbotPluginApi;

    registerActiveTaskInjection(apiWithLogger, ctx, activeTaskPath, workspaceRoot);

    const result = await api.emitFirstResult(
      "before_agent_start",
      {
        messages: [{ role: "user", content: "Process PR queue for markus-lassfolk/openclaw-hybrid-memory." }],
      },
      { sessionKey: "agent:forge:main" },
    );

    const prep = (result as { prependContext?: string } | undefined)?.prependContext ?? "";
    expect(prep).toContain("<active-task-registration>");
    expect(prep).toContain("wf-markus-lassfolk-openclaw-hybrid-memory-pr-queue");
    await expect(access(activeTaskPath, fsConstants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("auto-registers deployment task for main session when policy is auto_main_private", async () => {
    const cfg = parseCfg({
      activeTask: {
        enabled: true,
        ledger: "markdown",
        filePath: "ACTIVE-TASKS.md",
        taskHygiene: {
          longRunningRegistration: {
            mode: "auto_main_private",
          },
        },
      },
    });
    const ctx = { cfg } as LifecycleContext;
    const api = createMockPluginApi();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const apiWithLogger = { ...api, logger, context: {} } as unknown as ClawdbotPluginApi;

    registerActiveTaskInjection(apiWithLogger, ctx, activeTaskPath, workspaceRoot);

    const result = await api.emitFirstResult(
      "before_agent_start",
      {
        messages: [{ role: "user", content: "Monitor deployment to production and keep going until stable." }],
      },
      { sessionKey: "agent:main:main" },
    );

    const prep = (result as { prependContext?: string } | undefined)?.prependContext ?? "";
    expect(prep).toContain("<active-task-registration>");
    expect(prep).toContain("<active-tasks>");
    const parsed = await readActiveTaskFile(activeTaskPath, 24 * 60);
    expect(parsed?.active.some((t) => t.label.includes("deploy-production"))).toBe(true);
    const raw = await readFile(activeTaskPath, "utf8");
    expect(raw).toContain("Deployment workflow (production)");
  });

  it("does not auto-register deployment task for subagent sessions in auto_main_private mode", async () => {
    const cfg = parseCfg({
      activeTask: {
        enabled: true,
        ledger: "markdown",
        filePath: "ACTIVE-TASKS.md",
        taskHygiene: {
          longRunningRegistration: {
            mode: "auto_main_private",
          },
        },
      },
    });
    const ctx = { cfg } as LifecycleContext;
    const api = createMockPluginApi();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const apiWithLogger = { ...api, logger, context: {} } as unknown as ClawdbotPluginApi;

    registerActiveTaskInjection(apiWithLogger, ctx, activeTaskPath, workspaceRoot);

    const result = await api.emitFirstResult(
      "before_agent_start",
      {
        messages: [{ role: "user", content: "Monitor deployment to production and keep going until stable." }],
      },
      { sessionKey: "agent:main:subagent:worker-1" },
    );

    const prep = (result as { prependContext?: string } | undefined)?.prependContext ?? "";
    expect(prep).toContain("<active-task-registration>");
    expect(prep).toContain("Auto-registration policy only applies to main/private sessions");
    expect(prep).not.toContain("<active-tasks>");
    await expect(access(activeTaskPath, fsConstants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("logs facts-ledger selection diagnostics for active-task injection", async () => {
    const cfg = parseCfg({
      activeTask: {
        enabled: true,
        ledger: "facts",
        filePath: "ACTIVE-TASKS.md",
        staleThreshold: "60m",
        taskHygiene: {
          longRunningRegistration: {
            mode: "suggest",
          },
        },
      },
    });
    const factsDb = new FactsDB(join(workspaceRoot, "facts.db"));
    const ctx = { cfg, factsDb } as LifecycleContext;
    const api = createMockPluginApi();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const apiWithLogger = { ...api, logger, context: {} } as unknown as ClawdbotPluginApi;

    try {
      const freshUpdated = new Date().toISOString();
      const staleUpdated = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      for (const [entity, title, updated] of [
        ["fresh-task", "Fresh task", freshUpdated],
        ["stale-task", "Stale task", staleUpdated],
      ] as const) {
        factsDb.store({
          category: "project",
          importance: 0.7,
          source: "active-task",
          decayClass: "permanent",
          entity,
          key: "title",
          value: title,
          text: `Task [${entity}] title: ${title}`,
        });
        factsDb.store({
          category: "project",
          importance: 0.7,
          source: "active-task",
          decayClass: "permanent",
          entity,
          key: "status",
          value: "in_progress",
          text: `Task [${entity}] status: in_progress`,
        });
        factsDb.store({
          category: "project",
          importance: 0.7,
          source: "active-task",
          decayClass: "permanent",
          entity,
          key: "task_updated",
          value: updated,
          text: `Task [${entity}] task_updated: ${updated}`,
        });
      }

      registerActiveTaskInjection(apiWithLogger, ctx, activeTaskPath, workspaceRoot);

      const result = await api.emitFirstResult(
        "before_agent_start",
        {
          messages: [{ role: "user", content: "Continue work on fresh-task." }],
        },
        { sessionKey: "agent:forge:main" },
      );

      const prep = (result as { prependContext?: string } | undefined)?.prependContext ?? "";
      expect(prep).toContain("<active-tasks>");
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("memory-hybrid: active-task selection rowsFetched=6"),
      );
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("groupedEntities=2"));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("activeCandidates=2"));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("staleSkipped=1"));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("injected=1"));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("elapsedMs="));
    } finally {
      factsDb.close();
    }
  });

  it("emits first active-task projection memory attribution only once", async () => {
    const cfg = parseCfg({});
    const ctx = { cfg } as LifecycleContext;
    const api = createMockPluginApi();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const apiWithLogger = { ...api, logger, context: {} } as unknown as ClawdbotPluginApi;

    registerActiveTaskInjection(apiWithLogger, ctx, activeTaskPath, workspaceRoot);

    await api.emitFirstResult(
      "before_agent_start",
      {
        messages: [{ role: "user", content: "status?" }],
      },
      { sessionKey: "agent:forge:main" },
    );
    await api.emitFirstResult(
      "before_agent_start",
      {
        messages: [{ role: "user", content: "status again?" }],
      },
      { sessionKey: "agent:forge:main" },
    );

    const startupLogs = logger.info.mock.calls
      .reduce<unknown[]>((acc, args) => {
        acc.push(...args);
        return acc;
      }, [])
      .filter((value): value is string => typeof value === "string")
      .filter((msg) => msg.includes("startup-memory-checkpoint") && msg.includes("subsystem=active-task"));

    expect(startupLogs).toHaveLength(1);
    expect(startupLogs[0]).toContain("operation=first-projection");
  });
});
