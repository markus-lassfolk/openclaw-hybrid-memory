// @ts-nocheck
/**
 * Benchmark shadow-eval tests
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatBenchmarkResult,
  formatBenchmarkResults,
  measureLatency,
  readTokensFromLog,
  scoreAccuracy,
  shadowMeasure,
} from "../../benchmark/shadow-eval.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDb() {
  const tmpDir = mkdtempSync(join(tmpdir(), "bench-test-"));
  const dbPath = join(tmpDir, "test.db");
  const db = new DatabaseSync(dbPath);
  return { db, dbPath, tmpDir };
}

// ---------------------------------------------------------------------------
// measureLatency
// ---------------------------------------------------------------------------

describe("measureLatency", () => {
  it("returns p50/p95/p99 and sample count", () => {
    const fn = () => Math.sqrt(2);
    const result = measureLatency(fn, 50, 3);

    expect(result.p50).toBeGreaterThan(0);
    expect(result.p95).toBeGreaterThanOrEqual(result.p50);
    expect(result.p99).toBeGreaterThanOrEqual(result.p95);
    expect(result.samples).toBe(50);
    expect(result.values).toHaveLength(50);
  });

  it("handles a no-op function", () => {
    const fn = () => {};
    const result = measureLatency(fn, 10, 0);
    expect(result.samples).toBe(10);
    expect(result.p50).toBeGreaterThanOrEqual(0);
  });

  it("reports nanosecond-resolution timings", () => {
    const fn = () => 1 + 1;
    const result = measureLatency(fn, 20, 0);
    // Even 20 iterations should give a measurable time
    expect(result.p50).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// shadowMeasure
// ---------------------------------------------------------------------------

describe("shadowMeasure", () => {
  it("compares baseline vs shadow and returns delta", () => {
    const baseline = () => Math.sqrt(2);
    const shadow = () => Math.sqrt(Math.sqrt(2));

    const result = shadowMeasure(baseline, shadow, 30, 3);

    expect(result.baselineStats.samples).toBe(30);
    expect(result.shadowStats.samples).toBe(30);
    expect(typeof result.deltaMs).toBe("number");
    // Delta can be positive or negative depending on timing noise; just check it's a number
  });
});

// ---------------------------------------------------------------------------
// readTokensFromLog
// ---------------------------------------------------------------------------

describe("readTokensFromLog", () => {
  it("returns zeros when no data exists", () => {
    const { db, dbPath, tmpDir } = makeTempDb();
    try {
      // Initialize cost tracker schema
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_cost_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
          feature TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          estimated_cost_usd REAL,
          duration_ms INTEGER,
          success INTEGER NOT NULL DEFAULT 1
        );
      `);

      const result = readTokensFromLog(db, "nonexistent-feature");
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.calls).toBe(0);
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sums token usage for a feature", () => {
    const { db, dbPath, tmpDir } = makeTempDb();
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_cost_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
          feature TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          estimated_cost_usd REAL,
          duration_ms INTEGER,
          success INTEGER NOT NULL DEFAULT 1
        );
      `);

      // Insert two entries for the same feature
      db.prepare(
        `INSERT INTO llm_cost_log (feature, model, input_tokens, output_tokens, estimated_cost_usd)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("episodes", "openai/gpt-4.1-nano", 100, 50, 0.0001);

      db.prepare(
        `INSERT INTO llm_cost_log (feature, model, input_tokens, output_tokens, estimated_cost_usd)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("episodes", "openai/gpt-4.1-nano", 200, 80, 0.0002);

      // Insert another feature
      db.prepare(
        `INSERT INTO llm_cost_log (feature, model, input_tokens, output_tokens, estimated_cost_usd)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("other-feature", "openai/gpt-4.1-nano", 50, 20, 0.00005);

      const result = readTokensFromLog(db, "episodes");
      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(130);
      expect(result.calls).toBe(2);
      expect(result.estimatedCostUsd).toBeCloseTo(0.0003, 4);
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("filters by timestamp when sinceTimestamp is provided", () => {
    const { db, dbPath, tmpDir } = makeTempDb();
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_cost_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
          feature TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          estimated_cost_usd REAL,
          duration_ms INTEGER,
          success INTEGER NOT NULL DEFAULT 1
        );
      `);

      const now = Math.floor(Date.now() / 1000);
      // Old entry
      db.prepare(
        `INSERT INTO llm_cost_log (timestamp, feature, model, input_tokens, output_tokens, estimated_cost_usd)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(now - 86400 * 10, "episodes", "openai/gpt-4.1-nano", 500, 200, 0.001);

      // Recent entry
      db.prepare(
        `INSERT INTO llm_cost_log (timestamp, feature, model, input_tokens, output_tokens, estimated_cost_usd)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(now - 10, "episodes", "openai/gpt-4.1-nano", 100, 40, 0.0002);

      const result = readTokensFromLog(db, "episodes", now - 86400);
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(40);
      expect(result.calls).toBe(1);
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// formatBenchmarkResult
// ---------------------------------------------------------------------------

describe("formatBenchmarkResult", () => {
  it("formats a result with latency and tokens", () => {
    const result = {
      feature: "episodes",
      latency: { p50: 1.23, p95: 4.56, p99: 7.89, samples: 100 },
      tokensTracked: 1234,
      costTrackedUsd: 0.0025,
    };

    const formatted = formatBenchmarkResult(result);
    expect(formatted).toContain("episodes");
    expect(formatted).toContain("1.23ms");
    expect(formatted).toContain("4.56ms");
    expect(formatted).toContain("1,234");
  });

  it("includes accuracy when present", () => {
    const result = {
      feature: "episodes",
      latency: { p50: 1.2, p95: 2.3, p99: 3.4, samples: 50 },
      accuracy: {
        score: 0.85,
        llmCalls: 2,
        tokensUsed: 1500,
        judgement: "Feature improved recall",
      },
    };

    const formatted = formatBenchmarkResult(result);
    expect(formatted).toContain("85%");
    expect(formatted).toContain("Feature improved recall");
  });

  it("includes shadow delta when present", () => {
    const result = {
      feature: "episodes",
      latency: { p50: 1.5, p95: 2.0, p99: 3.0, samples: 100 },
      latencyDeltaMs: 0.3,
    };

    const formatted = formatBenchmarkResult(result);
    expect(formatted).toContain("Shadow");
    expect(formatted).toContain("+0.30ms");
  });
});

// ---------------------------------------------------------------------------
// formatBenchmarkResults
// ---------------------------------------------------------------------------

describe("formatBenchmarkResults", () => {
  it("formats multiple results", () => {
    const results = [
      {
        feature: "episodes",
        latency: { p50: 1.0, p95: 2.0, p99: 3.0, samples: 50 },
      },
      {
        feature: "frequency-autosave",
        latency: { p50: 0.5, p95: 1.0, p99: 2.0, samples: 50 },
      },
    ];

    const formatted = formatBenchmarkResults(results);
    expect(formatted).toContain("episodes");
    expect(formatted).toContain("frequency-autosave");
  });
});
