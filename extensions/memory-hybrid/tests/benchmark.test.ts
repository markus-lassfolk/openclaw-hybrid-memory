import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBenchmarkCommands } from "../cli/benchmark.js";

const mocks = vi.hoisted(() => ({
  formatBenchmarkResult: vi.fn(
    (result: { feature: string; latency: { p50: number } }) =>
      `Feature: ${result.feature}, p50: ${result.latency.p50}ms`,
  ),
  formatBenchmarkResults: vi.fn((results: Array<{ feature: string }>) =>
    results.map((r) => `- ${r.feature}`).join("\n"),
  ),
  runBenchmark: vi.fn(async (feature: string) => ({
    feature,
    latency: { p50: 10, p95: 20, p99: 30, samples: 100 },
  })),
  runAllBenchmarks: vi.fn(async () => [
    { feature: "episodes", latency: { p50: 10, p95: 20, p99: 30, samples: 100 } },
    { feature: "frequency-autosave", latency: { p50: 15, p95: 25, p99: 35, samples: 100 } },
  ]),
}));

vi.mock("../benchmark/shadow-eval.js", () => ({
  formatBenchmarkResult: mocks.formatBenchmarkResult,
  formatBenchmarkResults: mocks.formatBenchmarkResults,
  runBenchmark: mocks.runBenchmark,
  runAllBenchmarks: mocks.runAllBenchmarks,
}));

describe("benchmark CLI", () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `benchmark-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    dbPath = join(testDir, "test.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS llm_cost_log (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        cost_usd REAL,
        tokens_input INTEGER,
        tokens_output INTEGER
      );
    `);
    db.close();

    vi.clearAllMocks();
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function makeProgram(sqlitePath: string): Command {
    const program = new Command("hybrid-mem");
    program.exitOverride();
    registerBenchmarkCommands(program, { cfg: { sqlitePath } } as never);
    return program;
  }

  it("runs all benchmarks by default", async () => {
    const program = makeProgram(dbPath);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["benchmark", "run"], { from: "user" });

      expect(mocks.runAllBenchmarks).toHaveBeenCalledTimes(1);
      expect(mocks.runAllBenchmarks).toHaveBeenCalledWith(
        { dbPath },
        expect.objectContaining({ format: "text", iterations: 100 }),
      );
      expect(mocks.runBenchmark).not.toHaveBeenCalled();
      expect(mocks.formatBenchmarkResults).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("runs a specific feature when --feature is provided", async () => {
    const program = makeProgram(dbPath);

    await program.parseAsync(["benchmark", "run", "--feature", "episodes", "--format", "json", "--iterations", "25"], {
      from: "user",
    });

    expect(mocks.runBenchmark).toHaveBeenCalledTimes(1);
    expect(mocks.runBenchmark).toHaveBeenCalledWith(
      "episodes",
      { dbPath },
      expect.objectContaining({ format: "json", iterations: 25 }),
    );
    expect(mocks.runAllBenchmarks).not.toHaveBeenCalled();
  });

  it("fails with a clear error when database is missing", async () => {
    const missingDb = join(testDir, "does-not-exist.db");
    const program = makeProgram(missingDb);

    await expect(program.parseAsync(["benchmark", "run"], { from: "user" })).rejects.toThrow(/Database not found at:/);
  });
});
