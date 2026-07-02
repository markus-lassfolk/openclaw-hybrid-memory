/**
 * goal_assess computed its updateGoal() patch (assessmentCount, dispatchCount, blockers,
 * circuit-breaker state) from the goal snapshot read *before* acquiring updateGoal's lock, then
 * passed it as a plain object. updateGoal's own lock only serializes *when* each update commits,
 * not what data drove its contents — so a plain-object patch built from a pre-lock read can
 * silently clobber a concurrent writer's fresh state on commit.
 *
 * This test simulates the race deterministically: it mocks resolveGoalIdResult (the pre-lock
 * read goal_assess's handler performs) to first apply a "concurrent writer's" update — bumping
 * assessmentCount directly, as another goal_assess call's own updateGoal() would have — and then
 * return the STALE (pre-concurrent-write) goal snapshot, exactly matching the real race window.
 * With the fix (goal_assess passes a function-form patch that re-reads fresh state inside the
 * lock), the concurrent writer's assessmentCount is preserved and correctly incremented. Without
 * it, the plain-object patch computed from the stale snapshot overwrites the concurrent writer's
 * value.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { createGoal, readGoal } from "../services/goal-registry.js";
import * as goalStewardship from "../services/goal-stewardship.js";
import { registerGoalTools } from "../tools/goal-tools.js";
import { setEnv } from "../utils/env-manager.js";

const defaults = {
  maxDispatches: 5,
  maxAssessments: 10,
  cooldownMinutes: 5,
  escalateAfterFailures: 3,
  priority: "normal" as const,
};

describe("goal_assess stale-patch write race", () => {
  let workspaceRoot: string;
  let goalsDir: string;
  let prevWorkspace: string | undefined;

  beforeEach(async () => {
    prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    workspaceRoot = await mkdtemp(join(tmpdir(), "gt-race-"));
    await mkdir(join(workspaceRoot, "state", "goals"), { recursive: true });
    setEnv("OPENCLAW_WORKSPACE", workspaceRoot);
    goalsDir = goalStewardship.resolveGoalsDir(workspaceRoot, "state/goals");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("does not clobber a concurrent writer's assessmentCount (function-form patch re-reads fresh state)", async () => {
    const g = await createGoal(
      goalsDir,
      { label: "race-goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );
    expect(g.assessmentCount).toBe(0);

    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
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
    const assess = tools.get("goal_assess");
    expect(assess).toBeDefined();

    // Simulate a concurrent goal_assess call's own updateGoal() landing between this call's
    // pre-lock read and its updateGoal() call — the real race window the bug lived in.
    const resolveSpy = vi.spyOn(goalStewardship, "resolveGoalIdResult");
    resolveSpy.mockImplementationOnce(async (dir, idOrLabel) => {
      const staleResult = await goalStewardship.resolveGoalIdResult(dir, idOrLabel);
      // The "concurrent writer" — bumps assessmentCount directly, exactly as another
      // goal_assess call's updateGoal() would once its own transaction commits.
      await goalStewardship.updateGoal(
        goalsDir,
        g.id,
        { assessmentCount: 5 },
        { timestamp: new Date().toISOString(), action: "assessed", detail: "concurrent call", actor: "steward" },
      );
      return staleResult;
    });

    const result = (await assess?.execute("tc", {
      goal_id: g.id,
      assessment: "made progress",
      next_action: "continue",
    })) as { details?: { goal?: { assessmentCount?: number } } };

    // Fresh-relative: must be the concurrent writer's 5, plus this call's own +1 — never 1
    // (which is what goal.assessmentCount(=0 from the stale snapshot) + 1 would incorrectly give).
    expect(result.details?.goal?.assessmentCount).toBe(6);
    const onDisk = await readGoal(goalsDir, g.id);
    expect(onDisk?.assessmentCount).toBe(6);
    // Both assessments must be present in history — a clobbered write would show only one.
    expect(onDisk?.history?.filter((h) => h.action === "assessed").length).toBe(2);
  });

  it("still trips the circuit breaker and blocks the goal on repeated identical blockers", async () => {
    const g = await createGoal(
      goalsDir,
      { label: "cb-goal", description: "d", acceptanceCriteria: ["a"] },
      defaults,
    );

    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      goalStewardship: {
        enabled: true,
        goalsDir: "state/goals",
        circuitBreaker: { enabled: true, sameBlockerRepeatLimit: 2 },
      },
    });
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
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
    const assess = tools.get("goal_assess");
    expect(assess).toBeDefined();

    const args = {
      goal_id: g.id,
      assessment: "still stuck",
      next_action: "retry",
      blockers: ["same blocker every time"],
    };
    const first = (await assess?.execute("tc", args)) as { details?: { error?: string } };
    expect(first.details?.error).toBeUndefined();
    const second = (await assess?.execute("tc", args)) as { details?: { error?: string } };
    expect(second.details?.error).toBeUndefined();
    const third = (await assess?.execute("tc", args)) as {
      content?: Array<{ text?: string }>;
      details?: { circuitBreaker?: string; goal?: { status?: string } };
    };

    expect(third.details?.circuitBreaker).toBe("same_blocker_streak");
    expect(third.details?.goal?.status).toBe("blocked");
    expect(third.content?.[0]?.text).toContain("Circuit breaker");

    const onDisk = await readGoal(goalsDir, g.id);
    expect(onDisk?.status).toBe("blocked");
    expect(onDisk?.escalationKind).toBe("circuit_breaker");
    expect(onDisk?.humanEscalationSummary).toBeTruthy();
    expect(onDisk?.history?.some((h) => h.action === "circuit_breaker")).toBe(true);
  });

  it("does not clobber a concurrent blocker when the assessment budget is already exhausted (#36)", async () => {
    const g = await createGoal(
      goalsDir,
      { label: "budget-race-goal", description: "d", acceptanceCriteria: ["a"], maxAssessments: 1 },
      { ...defaults, maxAssessments: 1 },
    );
    await goalStewardship.updateGoal(
      goalsDir,
      g.id,
      { assessmentCount: 1 },
      { timestamp: new Date().toISOString(), action: "test", detail: "fill", actor: "user" },
    );

    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
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
    const assess = tools.get("goal_assess");
    expect(assess).toBeDefined();

    // Simulate a concurrent writer (e.g. the watchdog) appending a different blocker between
    // this call's pre-lock read and its own updateGoal() call for the budget-exhausted branch.
    const resolveSpy = vi.spyOn(goalStewardship, "resolveGoalIdResult");
    resolveSpy.mockImplementationOnce(async (dir, idOrLabel) => {
      const staleResult = await goalStewardship.resolveGoalIdResult(dir, idOrLabel);
      await goalStewardship.updateGoal(
        goalsDir,
        g.id,
        (fresh) => ({
          currentBlockers: fresh.currentBlockers.includes("concurrent-blocker")
            ? fresh.currentBlockers
            : [...fresh.currentBlockers, "concurrent-blocker"],
        }),
        { timestamp: new Date().toISOString(), action: "assessed", detail: "concurrent update", actor: "steward" },
      );
      return staleResult;
    });

    const result = (await assess?.execute("tc", {
      goal_id: g.id,
      assessment: "made progress",
      next_action: "continue",
    })) as { details?: { error?: string } };
    expect(result.details?.error).toBe("budget");

    const onDisk = await readGoal(goalsDir, g.id);
    expect(onDisk?.status).toBe("blocked");
    // Both the concurrent writer's blocker AND this call's budget-exhausted blocker must survive.
    expect(onDisk?.currentBlockers).toContain("concurrent-blocker");
    expect(onDisk?.currentBlockers.some((b) => b.includes("Assessment budget exhausted"))).toBe(true);
  });

  it("does not let assessmentCount overshoot maxAssessments across two calls racing past the pre-lock check (#38)", async () => {
    const g = await createGoal(
      goalsDir,
      { label: "assess-overshoot-goal", description: "d", acceptanceCriteria: ["a"], maxAssessments: 1 },
      { ...defaults, maxAssessments: 1 },
    );

    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
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
    const assess = tools.get("goal_assess");
    expect(assess).toBeDefined();

    // Simulate two overlapping goal_assess calls: this call's pre-lock resolveGoalIdResult
    // returns a snapshot with assessmentCount still 0 (below the cap of 1), but a "concurrent"
    // call has already committed assessmentCount=1 by the time this call's own updateGoal() runs
    // — the exact race window the pre-fix code never re-checked inside the lock.
    const resolveSpy = vi.spyOn(goalStewardship, "resolveGoalIdResult");
    resolveSpy.mockImplementationOnce(async (dir, idOrLabel) => {
      const staleResult = await goalStewardship.resolveGoalIdResult(dir, idOrLabel);
      await goalStewardship.updateGoal(goalsDir, g.id, { assessmentCount: 1 }, {
        timestamp: new Date().toISOString(),
        action: "assessed",
        detail: "concurrent call",
        actor: "steward",
      });
      return staleResult;
    });

    const result = (await assess?.execute("tc", {
      goal_id: g.id,
      assessment: "made progress",
      next_action: "continue",
    })) as { details?: { error?: string } };
    expect(result.details?.error).toBe("budget");

    const onDisk = await readGoal(goalsDir, g.id);
    // Must stay at the concurrent writer's 1 — never incremented to 2, which is what would
    // happen if this call's increment were computed without re-checking the cap against fresh
    // state inside the lock.
    expect(onDisk?.assessmentCount).toBe(1);
    expect(onDisk?.status).toBe("blocked");
  });

  it("does not let dispatchCount overshoot maxDispatches across two calls racing past the pre-lock check (#38)", async () => {
    const g = await createGoal(
      goalsDir,
      { label: "dispatch-overshoot-goal", description: "d", acceptanceCriteria: ["a"], maxDispatches: 1 },
      { ...defaults, maxDispatches: 1 },
    );

    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough-to-pass", model: "text-embedding-3-small" },
      goalStewardship: { enabled: true, goalsDir: "state/goals" },
    });
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
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
    const assess = tools.get("goal_assess");
    expect(assess).toBeDefined();

    // Same race, but for the dispatch budget: this call's pre-lock snapshot sees dispatchCount
    // still 0 (below the cap of 1), while a concurrent call has already committed dispatchCount=1
    // by the time this call's own updateGoal() runs.
    const resolveSpy = vi.spyOn(goalStewardship, "resolveGoalIdResult");
    resolveSpy.mockImplementationOnce(async (dir, idOrLabel) => {
      const staleResult = await goalStewardship.resolveGoalIdResult(dir, idOrLabel);
      await goalStewardship.updateGoal(goalsDir, g.id, { dispatchCount: 1 }, {
        timestamp: new Date().toISOString(),
        action: "assessed",
        detail: "concurrent dispatch",
        actor: "steward",
      });
      return staleResult;
    });

    const result = (await assess?.execute("tc", {
      goal_id: g.id,
      assessment: "made progress",
      next_action: "continue",
      dispatched: true,
    })) as { details?: { error?: string } };
    expect(result.details?.error).toBe("dispatch_budget");

    const onDisk = await readGoal(goalsDir, g.id);
    // Must stay at the concurrent writer's 1 — never incremented to 2.
    expect(onDisk?.dispatchCount).toBe(1);
    // The whole call is rejected (matching pre-fix all-or-nothing behavior): no assessment text
    // or history entry recorded for this rejected attempt.
    expect(onDisk?.assessmentCount).toBe(0);
  });
});
