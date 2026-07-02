import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGoalCommands } from "../cli/goals.js";
import { hybridConfigSchema } from "../config.js";
import { createGoal, readGoal, resolveGoalsDir, updateGoal } from "../services/goal-registry.js";
import { setEnv } from "../utils/env-manager.js";

function makeCfg() {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
    },
    goalStewardship: {
      enabled: true,
      goalsDir: "state/goals-test",
      heartbeatPatterns: ["^cron heartbeat"],
      heartbeatStewardship: true,
      watchdogHealthCheck: true,
    },
  });
}

describe("goals config CLI", () => {
  const origArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...origArgv];
    vi.restoreAllMocks();
  });

  it("prints human-readable config by default", async () => {
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerGoalCommands(program, { cfg: makeCfg() });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["goals", "config"], { from: "user" });
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Goal stewardship — enabled");
    } finally {
      log.mockRestore();
    }
  });

  it("supports --json for automation", async () => {
    const prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    setEnv("OPENCLAW_WORKSPACE", "/tmp/openclaw-goals-config-test");
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerGoalCommands(program, { cfg: makeCfg() });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);
    try {
      await program.parseAsync(["goals", "config", "--json"], { from: "user" });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledOnce();
      const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(parsed.enabled).toBe(true);
      expect(parsed.goalsDir).toBe("state/goals-test");
      expect(parsed.resolvedGoalsDir).toBe("/tmp/openclaw-goals-config-test/state/goals-test");
      expect(parsed.heartbeatPatterns).toEqual(["^cron heartbeat"]);
      expect(parsed.heartbeatStewardship).toBe(true);
      expect(parsed.triageSuggestHeavyDirective).toBe(true);
      expect(parsed.globalLimits.maxActiveGoals).toBeGreaterThan(0);
      expect(parsed.defaults.maxDispatches).toBeGreaterThan(0);
    } finally {
      log.mockRestore();
      exitSpy.mockRestore();
      setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    }
  });

  it("does not force process.exit after --json output (issue #1234/#1268)", async () => {
    const prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    setEnv("OPENCLAW_WORKSPACE", "/tmp/openclaw-goals-config-test");
    process.argv = ["node", "openclaw", "hybrid-mem", "goals", "config", "--json"];

    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerGoalCommands(program, { cfg: makeCfg() });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);

    try {
      await program.parseAsync(["goals", "config", "--json"], { from: "user" });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
      const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(parsed.enabled).toBe(true);
    } finally {
      log.mockRestore();
      exitSpy.mockRestore();
      setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    }
  });

  it("reset-budget clears circuit-breaker state, not just dispatch/assessment counters", async () => {
    const prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    const workspace = await mkdtemp(join(tmpdir(), "goals-reset-budget-"));
    setEnv("OPENCLAW_WORKSPACE", workspace);
    try {
      const cfg = makeCfg();
      const dir = resolveGoalsDir(workspace, cfg.goalStewardship.goalsDir);
      const created = await createGoal(
        dir,
        { label: "tripped_goal", description: "d", acceptanceCriteria: ["a"] },
        {
          maxDispatches: 5,
          maxAssessments: 10,
          cooldownMinutes: 5,
          escalateAfterFailures: 3,
          priority: "normal",
        },
      );
      // Simulate a tripped circuit breaker: blocked, streak at/over the repeat limit, with a
      // fingerprint that would still match the next assessment if the blocker is unchanged.
      await updateGoal(
        dir,
        created.id,
        {
          status: "blocked",
          currentBlockers: ["still stuck"],
          dispatchCount: 3,
          assessmentCount: 4,
          consecutiveFailures: 2,
          lastBlockerFingerprint: "fp-still-stuck",
          sameBlockerStreak: 3,
          circuitBreakerLastProgressAssessmentCount: 1,
          escalationKind: "circuit_breaker",
          humanEscalationSummary: "Circuit breaker tripped after 3 repeats.",
        },
        { timestamp: new Date().toISOString(), action: "circuit-breaker-tripped", detail: "test setup", actor: "agent" },
      );

      const program = new Command("hybrid-mem");
      program.exitOverride();
      registerGoalCommands(program, { cfg });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await program.parseAsync(["goals", "reset-budget", created.id], { from: "user" });
      } finally {
        log.mockRestore();
      }

      const after = await readGoal(dir, created.id);
      expect(after?.status).toBe("active");
      expect(after?.dispatchCount).toBe(0);
      expect(after?.assessmentCount).toBe(0);
      expect(after?.consecutiveFailures).toBe(0);
      expect(after?.lastBlockerFingerprint).toBeNull();
      expect(after?.sameBlockerStreak).toBe(0);
      expect(after?.circuitBreakerLastProgressAssessmentCount).toBe(0);
      expect(after?.escalationKind).toBeNull();
      expect(after?.humanEscalationSummary).toBeNull();
    } finally {
      setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
