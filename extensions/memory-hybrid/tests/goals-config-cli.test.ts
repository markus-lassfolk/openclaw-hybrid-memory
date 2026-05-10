import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerGoalCommands } from "../cli/goals.js";
import { hybridConfigSchema } from "../config.js";
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
    try {
      await program.parseAsync(["goals", "config", "--json"], { from: "user" });
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
      setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    }
  });
});
