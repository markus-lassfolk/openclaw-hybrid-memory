import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerGoalCommands } from "../cli/goals.js";
import { hybridConfigSchema } from "../config.js";
import * as goalStewardship from "../services/goal-stewardship.js";
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

describe("goals --json stream contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("goals list --json writes parseable JSON payload to stdout and keeps diagnostics on stderr", async () => {
    const prevWorkspace = process.env.OPENCLAW_WORKSPACE;
    setEnv("OPENCLAW_WORKSPACE", "/tmp/openclaw-goals-json-streams-test");

    const listGoalsSpy = vi.spyOn(goalStewardship, "listGoals").mockImplementation(async () => {
      console.error("memory-hybrid: bootstrap diagnostic");
      return [
        {
          id: "goal-1",
          label: "ship-json-contract",
          status: "active",
        } as unknown as Awaited<ReturnType<typeof goalStewardship.listGoals>>[number],
      ];
    });

    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerGoalCommands(program, { cfg: makeCfg() });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation((msg) => {
      stderrChunks.push(String(msg));
    });

    try {
      await program.parseAsync(["goals", "list", "--json"], { from: "user" });
      expect(listGoalsSpy).toHaveBeenCalledOnce();

      const stdout = stdoutChunks.join("").trim();
      expect(stdout.length).toBeGreaterThan(0);
      const parsed = JSON.parse(stdout) as Array<{ label?: string }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.label).toBe("ship-json-contract");

      const stderr = stderrChunks.join("\n");
      expect(stderr).toContain("memory-hybrid: bootstrap diagnostic");
      expect(stderr).not.toContain("ship-json-contract");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      setEnv("OPENCLAW_WORKSPACE", prevWorkspace);
    }
  });
});
