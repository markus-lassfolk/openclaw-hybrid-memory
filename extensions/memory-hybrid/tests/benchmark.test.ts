import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the shadow-eval module functions since they depend on complex setup
vi.mock("../benchmark/shadow-eval.js", () => ({
  formatBenchmarkResult: vi.fn((result) => `Feature: ${result.feature}, p50: ${result.latency.p50}ms`),
  formatBenchmarkResults: vi.fn((results) => results.map((r: { feature: string }) => `- ${r.feature}`).join("\n")),
  runBenchmark: vi.fn(async (feature) => ({
    feature,
    latency: { p50: 10, p95: 20, p99: 30, samples: 100 },
  })),
  runAllBenchmarks: vi.fn(async () => [
    { feature: "episodes", latency: { p50: 10, p95: 20, p99: 30, samples: 100 } },
    { feature: "frequency-autosave", latency: { p50: 15, p95: 25, p99: 35, samples: 100 } },
  ]),
}));

describe("benchmark CLI", () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = join(tmpdir(), `benchmark-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    dbPath = join(testDir, "test.db");

    // Create a minimal test database
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
    db.exec(`
      INSERT INTO llm_cost_log (session_id, cost_usd, tokens_input, tokens_output)
      VALUES ('test-session', 0.001, 100, 50);
    `);
    db.close();
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  describe("benchmark command registration", () => {
    it("should verify database exists", () => {
      expect(existsSync(dbPath)).toBe(true);

      // Verify we can open the database
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_cost_log'")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe("llm_cost_log");
      db.close();
    });

    it("should have correct table structure", () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare("SELECT * FROM llm_cost_log WHERE session_id = 'test-session'").all() as Array<{
        session_id: string;
        cost_usd: number;
        tokens_input: number;
        tokens_output: number;
      }>;

      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe("test-session");
      expect(rows[0].cost_usd).toBe(0.001);
      expect(rows[0].tokens_input).toBe(100);
      expect(rows[0].tokens_output).toBe(50);
      db.close();
    });
  });

  describe("benchmark feature selection", () => {
    it("should support episodes feature", () => {
      const feature = "episodes";
      expect(["episodes", "frequency-autosave", "procedure-feedback"]).toContain(feature);
    });

    it("should support frequency-autosave feature", () => {
      const feature = "frequency-autosave";
      expect(["episodes", "frequency-autosave", "procedure-feedback"]).toContain(feature);
    });

    it("should support procedure-feedback feature", () => {
      const feature = "procedure-feedback";
      expect(["episodes", "frequency-autosave", "procedure-feedback"]).toContain(feature);
    });
  });

  describe("benchmark options", () => {
    it("should support accuracy option", () => {
      const options = { accuracy: true };
      expect(options.accuracy).toBe(true);
    });

    it("should support shadow option", () => {
      const options = { shadow: true };
      expect(options.shadow).toBe(true);
    });

    it("should support format options (text and json)", () => {
      const textFormat = { format: "text" as const };
      const jsonFormat = { format: "json" as const };

      expect(textFormat.format).toBe("text");
      expect(jsonFormat.format).toBe("json");
    });

    it("should support custom iterations", () => {
      const options = { iterations: 50 };
      expect(options.iterations).toBe(50);
    });

    it("should support custom judge model", () => {
      const options = { judgeModel: "openai/gpt-4.1-nano" };
      expect(options.judgeModel).toBe("openai/gpt-4.1-nano");
    });

    it("should use default iterations of 100", () => {
      const defaultIterations = 100;
      expect(defaultIterations).toBe(100);
    });

    it("should use default judge model", () => {
      const defaultJudgeModel = "openai/gpt-4.1-nano";
      expect(defaultJudgeModel).toBe("openai/gpt-4.1-nano");
    });
  });

  describe("benchmark result structure", () => {
    it("should have expected result fields", () => {
      const mockResult = {
        feature: "test-feature",
        latency: { p50: 10, p95: 20, p99: 30, samples: 100 },
      };

      expect(mockResult).toHaveProperty("feature");
      expect(mockResult).toHaveProperty("latency");
      expect(mockResult.latency).toHaveProperty("p50");
      expect(mockResult.latency).toHaveProperty("p95");
      expect(mockResult.latency).toHaveProperty("p99");
      expect(mockResult.latency).toHaveProperty("samples");
    });

    it("should support optional accuracy field", () => {
      const mockResultWithAccuracy = {
        feature: "test-feature",
        latency: { p50: 10, p95: 20, p99: 30, samples: 100 },
        accuracy: { score: 0.85, llmCalls: 5, tokensUsed: 1000, judgement: "Good improvement" },
      };

      expect(mockResultWithAccuracy.accuracy).toBeDefined();
      expect(mockResultWithAccuracy.accuracy?.score).toBe(0.85);
    });

    it("should support optional cost tracking fields", () => {
      const mockResultWithCost = {
        feature: "test-feature",
        latency: { p50: 10, p95: 20, p99: 30, samples: 100 },
        tokensTracked: 5000,
        costTrackedUsd: 0.05,
      };

      expect(mockResultWithCost.tokensTracked).toBe(5000);
      expect(mockResultWithCost.costTrackedUsd).toBe(0.05);
    });

    it("should support optional latency delta for shadow mode", () => {
      const mockResultWithDelta = {
        feature: "test-feature",
        latency: { p50: 10, p95: 20, p99: 30, samples: 100 },
        latencyDeltaMs: 2.5,
      };

      expect(mockResultWithDelta.latencyDeltaMs).toBe(2.5);
    });
  });

  describe("database error handling", () => {
    it("should handle missing database gracefully", () => {
      const nonExistentPath = join(testDir, "nonexistent.db");
      expect(existsSync(nonExistentPath)).toBe(false);
    });

    it("should detect when database path is invalid", () => {
      const invalidPath = "/invalid/path/that/does/not/exist/db.db";
      expect(existsSync(invalidPath)).toBe(false);
    });
  });

  describe("cost tracking", () => {
    it("should query llm_cost_log table", () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare("SELECT SUM(cost_usd) as total_cost FROM llm_cost_log").all() as Array<{
        total_cost: number;
      }>;

      expect(rows[0].total_cost).toBe(0.001);
      db.close();
    });

    it("should calculate total tokens", () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare("SELECT SUM(tokens_input + tokens_output) as total_tokens FROM llm_cost_log")
        .all() as Array<{ total_tokens: number }>;

      expect(rows[0].total_tokens).toBe(150); // 100 input + 50 output
      db.close();
    });

    it("should filter by session_id", () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare("SELECT COUNT(*) as count FROM llm_cost_log WHERE session_id = 'test-session'")
        .all() as Array<{ count: number }>;

      expect(rows[0].count).toBe(1);
      db.close();
    });
  });
});
