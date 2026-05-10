import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { registerActiveTaskInjection } from "../lifecycle/stage-active-task.js";
import type { LifecycleContext } from "../lifecycle/types.js";
import { readActiveTaskFile } from "../services/active-task.js";
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
});
