/**
 * goal_update, goal_complete, and goal_abandon previously had no top-level try/catch around their
 * execute() bodies, unlike goal_register and goal_assess in the same file. Any unexpected throw
 * from updateGoal()/terminateGoal() (disk I/O errors, lock timeouts, JSON corruption, etc.) would
 * propagate out of execute() uncaught instead of returning the graceful
 * `{ content, details: { error } }` shape every other goal tool uses, and would skip the
 * capturePluginError() telemetry hook those other tools rely on for visibility into failures.
 *
 * These tests force each tool's underlying updateGoal()/terminateGoal() call to throw and confirm
 * execute() resolves (never rejects) with a graceful error response, and that capturePluginError
 * is invoked.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import * as errorReporter from "../services/error-reporter.js";
import { createGoal } from "../services/goal-registry.js";
import * as goalStewardship from "../services/goal-stewardship.js";
import { registerGoalTools } from "../tools/goal-tools.js";
import { setEnv } from "../utils/env-manager.js";

const defaults = {
  maxDispatches: 20,
  maxAssessments: 50,
  cooldownMinutes: 10,
  escalateAfterFailures: 3,
  priority: "normal" as const,
};

type ToolMap = Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>;

describe("goal_update/goal_complete/goal_abandon top-level error handling (#41)", () => {
  let workspaceRoot: string;
  let goalsDir: string;
  let prevWorkspace: string | undefined;

  beforeEach(async () => {
    prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    workspaceRoot = await mkdtemp(join(tmpdir(), "gt-err-"));
    await mkdir(join(workspaceRoot, "state", "goals"), { recursive: true });
    setEnv("OPENCLAW_WORKSPACE", workspaceRoot);
    goalsDir = goalStewardship.resolveGoalsDir(workspaceRoot, "state/goals");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function registerTools(): ToolMap {
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
        factsDb: null,
        vectorDb: null,
        embeddings: null,
        eventLog: null,
        memoryDir: join(workspaceRoot, "memory"),
      },
      api as ClawdbotPluginApi,
    );
    return tools;
  }

  it("goal_update returns a graceful error instead of throwing when updateGoal throws", async () => {
    const g = await createGoal(goalsDir, { label: "u1", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const tools = registerTools();
    const captureSpy = vi.spyOn(errorReporter, "capturePluginError").mockImplementation(() => undefined);
    vi.spyOn(goalStewardship, "updateGoal").mockRejectedValueOnce(new Error("disk full"));

    const update = tools.get("goal_update");
    expect(update).toBeDefined();
    const result = (await update?.execute("tc", { goal_id: g.id, note: "x" })) as { details?: { error?: string } };
    expect(result.details?.error).toContain("disk full");
    expect(captureSpy).toHaveBeenCalled();
  });

  it("goal_complete returns a graceful error instead of throwing when terminateGoal throws", async () => {
    const g = await createGoal(goalsDir, { label: "c1", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const tools = registerTools();
    const captureSpy = vi.spyOn(errorReporter, "capturePluginError").mockImplementation(() => undefined);
    vi.spyOn(goalStewardship, "terminateGoal").mockRejectedValueOnce(new Error("lock timeout"));

    const complete = tools.get("goal_complete");
    expect(complete).toBeDefined();
    const result = (await complete?.execute("tc", {
      goal_id: g.id,
      reason: "done",
      confirmed: true,
    })) as { details?: { error?: string } };
    expect(result.details?.error).toContain("lock timeout");
    expect(captureSpy).toHaveBeenCalled();
  });

  it("goal_abandon returns a graceful error instead of throwing when terminateGoal throws", async () => {
    const g = await createGoal(goalsDir, { label: "a1", description: "d", acceptanceCriteria: ["a"] }, defaults);
    const tools = registerTools();
    const captureSpy = vi.spyOn(errorReporter, "capturePluginError").mockImplementation(() => undefined);
    vi.spyOn(goalStewardship, "terminateGoal").mockRejectedValueOnce(new Error("permission denied"));

    const abandon = tools.get("goal_abandon");
    expect(abandon).toBeDefined();
    const result = (await abandon?.execute("tc", { goal_id: g.id, reason: "nvm" })) as {
      details?: { error?: string };
    };
    expect(result.details?.error).toContain("permission denied");
    expect(captureSpy).toHaveBeenCalled();
  });
});
