/**
 * Tests for tool effectiveness scoring (Issue #263 — Phase 3).
 *
 * Covers:
 *   - aggregateTraceRows: basic scoring, minCalls filter, redundancy calc
 *   - compositeScore formula
 *   - generateRecommendations: low scorers, redundancy, low success
 *   - ToolEffectivenessStore: upsert, getAll, getByTool, applyDecay, count
 *   - formatToolEffectivenessReport: output format
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateTraceRows,
  generateRecommendations,
  formatToolEffectivenessReport,
  generateToolHint,
  generateMonthlyReport,
  ToolEffectivenessStore,
  type ToolMetrics,
} from "../services/tool-effectiveness.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(dir: string): ToolEffectivenessStore {
  return new ToolEffectivenessStore(join(dir, "effectiveness.db"));
}

function makeMetrics(overrides: Partial<ToolMetrics> = {}): ToolMetrics {
  return {
    tool: "test_tool",
    context: "general",
    totalCalls: 10,
    successCalls: 8,
    failureCalls: 2,
    unknownCalls: 0,
    successRate: 0.8,
    avgDurationMs: 500,
    avgCallsPerSession: 1.5,
    redundancyScore: 0.125,
    compositeScore: 0.7,
    lastUpdated: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

type TraceRow = {
  tool_sequence: string;
  outcome: string;
  duration_ms: number;
  session_id: string;
};

function makeTrace(tools: string[], outcome: string, sessionId = "s1", durationMs = 1000): TraceRow {
  return {
    tool_sequence: JSON.stringify(tools),
    outcome,
    duration_ms: durationMs,
    session_id: sessionId,
  };
}

// ---------------------------------------------------------------------------
// aggregateTraceRows
// ---------------------------------------------------------------------------

describe("aggregateTraceRows", () => {
  it("returns empty array for empty input", () => {
    expect(aggregateTraceRows([], 3)).toHaveLength(0);
  });

  it("filters out tools below minCalls threshold", () => {
    const rows = [
      makeTrace(["exec", "read"], "success"),
      makeTrace(["exec"], "success"),
      makeTrace(["exec"], "success"),
    ];
    // exec has 3 calls across 3 traces, read has 1 call
    const result = aggregateTraceRows(rows, 3);
    const tools = result.map((m) => m.tool);
    expect(tools).toContain("exec");
    expect(tools).not.toContain("read");
  });

  it("computes success rate correctly", () => {
    const rows = [
      makeTrace(["my_tool"], "success"),
      makeTrace(["my_tool"], "success"),
      makeTrace(["my_tool"], "failure"),
      makeTrace(["my_tool"], "success"),
    ];
    const result = aggregateTraceRows(rows, 1);
    const tool = result.find((m) => m.tool === "my_tool");
    expect(tool).toBeDefined();
    expect(tool?.successCalls).toBe(3);
    expect(tool?.failureCalls).toBe(1);
    expect(tool?.successRate).toBeCloseTo(0.75, 2);
  });

  it("computes compositeScore in [0, 1]", () => {
    const rows = Array.from({ length: 10 }, () => makeTrace(["tool_a"], "success"));
    const result = aggregateTraceRows(rows, 3);
    const tool = result.find((m) => m.tool === "tool_a");
    expect(tool).toBeDefined();
    expect(tool?.compositeScore).toBeGreaterThanOrEqual(0);
    expect(tool?.compositeScore).toBeLessThanOrEqual(1);
  });

  it("handles tools called multiple times in one trace", () => {
    const rows = [
      makeTrace(["exec", "exec", "exec", "read"], "success", "s1"),
      makeTrace(["exec", "read"], "success", "s2"),
      makeTrace(["exec", "exec"], "failure", "s3"),
    ];
    const result = aggregateTraceRows(rows, 1);
    const execMetric = result.find((m) => m.tool === "exec");
    expect(execMetric).toBeDefined();
    expect(execMetric?.totalCalls).toBeGreaterThan(4); // 3 + 1 + 2 = 6
  });

  it("computes redundancy score between 0 and 1", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeTrace(["repeat_tool", "repeat_tool", "repeat_tool"], "success", `s${i}`),
    );
    const result = aggregateTraceRows(rows, 3);
    const tool = result.find((m) => m.tool === "repeat_tool");
    expect(tool).toBeDefined();
    expect(tool?.redundancyScore).toBeGreaterThan(0);
    expect(tool?.redundancyScore).toBeLessThanOrEqual(1);
  });

  it("handles malformed JSON in tool_sequence gracefully", () => {
    const rows = [
      { tool_sequence: "not-json", outcome: "success", duration_ms: 500, session_id: "s1" },
      makeTrace(["good_tool"], "success"),
      makeTrace(["good_tool"], "success"),
      makeTrace(["good_tool"], "success"),
    ];
    expect(() => aggregateTraceRows(rows, 3)).not.toThrow();
    const result = aggregateTraceRows(rows, 3);
    const tool = result.find((m) => m.tool === "good_tool");
    expect(tool).toBeDefined();
  });

  it("returns results sorted by compositeScore DESC", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => makeTrace(["always_fail"], "failure")),
      ...Array.from({ length: 5 }, () => makeTrace(["always_succeed"], "success")),
    ];
    const result = aggregateTraceRows(rows, 3);
    if (result.length >= 2) {
      for (let i = 0; i < result.length - 1; i++) {
        expect(result[i]?.compositeScore).toBeGreaterThanOrEqual(result[i + 1]?.compositeScore);
      }
    }
  });

  it("composite formula: successRate 50% + duration 30% + low-redundancy 20%", () => {
    // Perfect tool: 100% success, fastest, 1 call per session
    const rows = [
      makeTrace(["perfect"], "success", "s1", 1),
      makeTrace(["perfect"], "success", "s2", 1),
      makeTrace(["perfect"], "success", "s3", 1),
    ];
    const result = aggregateTraceRows(rows, 1);
    const perfect = result.find((m) => m.tool === "perfect");
    expect(perfect).toBeDefined();
    // Score should be high (0.5 success + 0 duration + 0.2 non-redundancy = 0.7 min)
    expect(perfect?.compositeScore).toBeGreaterThanOrEqual(0.7);
  });
});

// ---------------------------------------------------------------------------
// generateRecommendations
// ---------------------------------------------------------------------------

describe("generateRecommendations", () => {
  it("returns recommendation for low-score tools", () => {
    const metrics: ToolMetrics[] = [
      makeMetrics({ tool: "bad_tool", compositeScore: 0.1, totalCalls: 10, successRate: 0.2 }),
    ];
    const recs = generateRecommendations(metrics, 0.3);
    expect(recs.some((r) => r.toLowerCase().includes("bad_tool"))).toBe(true);
  });

  it("returns recommendation for high-redundancy tools", () => {
    const metrics: ToolMetrics[] = [
      makeMetrics({ tool: "redundant_tool", redundancyScore: 0.9, avgCallsPerSession: 5, totalCalls: 10 }),
    ];
    const recs = generateRecommendations(metrics, 0.3);
    expect(recs.some((r) => r.toLowerCase().includes("redundant"))).toBe(true);
  });

  it("returns recommendation for low-success tools", () => {
    const metrics: ToolMetrics[] = [
      makeMetrics({ tool: "failing_tool", successRate: 0.2, totalCalls: 10, compositeScore: 0.4 }),
    ];
    const recs = generateRecommendations(metrics, 0.3);
    expect(recs.some((r) => r.toLowerCase().includes("failing_tool"))).toBe(true);
  });

  it("returns best tool recommendation when all healthy", () => {
    const metrics: ToolMetrics[] = [makeMetrics({ tool: "great_tool", compositeScore: 0.95, successRate: 0.99 })];
    const recs = generateRecommendations(metrics, 0.3);
    expect(recs.some((r) => r.toLowerCase().includes("great_tool"))).toBe(true);
  });

  it("returns empty array for empty metrics", () => {
    const recs = generateRecommendations([], 0.3);
    expect(recs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ToolEffectivenessStore
// ---------------------------------------------------------------------------

describe("ToolEffectivenessStore", () => {
  let tmpDir: string;
  let store: ToolEffectivenessStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tool-eff-test-"));
    store = makeStore(tmpDir);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("count returns 0 for empty store", () => {
    expect(store.count()).toBe(0);
  });

  it("upsert stores a metric", () => {
    store.upsert(makeMetrics({ tool: "my_tool" }));
    expect(store.count()).toBe(1);
  });

  it("getByTool returns correct metric", () => {
    store.upsert(makeMetrics({ tool: "alpha_tool", compositeScore: 0.8 }));
    const result = store.getByTool("alpha_tool");
    expect(result).not.toBeNull();
    expect(result?.tool).toBe("alpha_tool");
    expect(result?.compositeScore).toBeCloseTo(0.8, 2);
  });

  it("getByTool returns null for unknown tool", () => {
    expect(store.getByTool("nonexistent")).toBeNull();
  });

  it("upsert overwrites existing metric", () => {
    store.upsert(makeMetrics({ tool: "my_tool", compositeScore: 0.5 }));
    store.upsert(makeMetrics({ tool: "my_tool", compositeScore: 0.9 }));
    expect(store.count()).toBe(1);
    expect(store.getByTool("my_tool")?.compositeScore).toBeCloseTo(0.9, 2);
  });

  it("getAll returns sorted by compositeScore DESC", () => {
    store.upsert(makeMetrics({ tool: "low", compositeScore: 0.2 }));
    store.upsert(makeMetrics({ tool: "high", compositeScore: 0.9 }));
    store.upsert(makeMetrics({ tool: "mid", compositeScore: 0.6 }));
    const all = store.getAll();
    expect(all[0]?.tool).toBe("high");
    expect(all[2]?.tool).toBe("low");
  });

  it("applyDecay reduces all composite scores", () => {
    store.upsert(makeMetrics({ tool: "decaying", compositeScore: 1.0 }));
    store.applyDecay(0.5);
    const result = store.getByTool("decaying");
    expect(result?.compositeScore).toBeCloseTo(0.5, 3);
  });

  it("applyDecay with factor 1.0 leaves scores unchanged", () => {
    store.upsert(makeMetrics({ tool: "stable", compositeScore: 0.7 }));
    store.applyDecay(1.0);
    expect(store.getByTool("stable")?.compositeScore).toBeCloseTo(0.7, 3);
  });

  it("successRate is computed correctly from raw counts", () => {
    store.upsert(makeMetrics({ tool: "sr_tool", totalCalls: 10, successCalls: 7, compositeScore: 0.5 }));
    const result = store.getByTool("sr_tool");
    expect(result?.successRate).toBeCloseTo(0.7, 2);
  });
});

// ---------------------------------------------------------------------------
// formatToolEffectivenessReport
// ---------------------------------------------------------------------------

describe("formatToolEffectivenessReport", () => {
  it("returns no-data message when toolsScored is 0", () => {
    const output = formatToolEffectivenessReport({
      computedAt: Math.floor(Date.now() / 1000),
      toolsScored: 0,
      topTools: [],
      lowScoreTools: [],
      allScores: [],
      recommendations: [],
    });
    expect(output).toContain("No tool effectiveness data");
  });

  it("includes tool names in output", () => {
    const tool = makeMetrics({ tool: "my_important_tool", compositeScore: 0.85 });
    const output = formatToolEffectivenessReport({
      computedAt: Math.floor(Date.now() / 1000),
      toolsScored: 1,
      topTools: [tool],
      lowScoreTools: [],
      allScores: [tool],
      recommendations: ["Best performing tool: my_important_tool"],
    });
    expect(output).toContain("my_important_tool");
  });

  it("includes low-score section when tools are flagged", () => {
    const goodTool = makeMetrics({ tool: "good_tool", compositeScore: 0.9 });
    const badTool = makeMetrics({ tool: "bad_tool", compositeScore: 0.1 });
    const output = formatToolEffectivenessReport({
      computedAt: Math.floor(Date.now() / 1000),
      toolsScored: 2,
      topTools: [goodTool, badTool],
      lowScoreTools: [badTool],
      allScores: [goodTool, badTool],
      recommendations: ["Low-scoring tools may need review: bad_tool"],
    });
    expect(output).toContain("⚠");
    expect(output).toContain("bad_tool");
  });

  it("includes recommendations when present", () => {
    const tool = makeMetrics({ tool: "tool_x", compositeScore: 0.5 });
    const output = formatToolEffectivenessReport({
      computedAt: Math.floor(Date.now() / 1000),
      toolsScored: 1,
      topTools: [tool],
      lowScoreTools: [],
      allScores: [tool],
      recommendations: ["• Consider batching tool calls"],
    });
    expect(output).toContain("Recommendations");
  });
});

// ---------------------------------------------------------------------------
// ToolEffectivenessStore — context column and recordToolOutcome / getToolEffectiveness
// ---------------------------------------------------------------------------

describe("ToolEffectivenessStore — context-aware", () => {
  let tmpDir: string;
  let store: ToolEffectivenessStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tool-eff-ctx-test-"));
    store = makeStore(tmpDir);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upsert stores context field", () => {
    store.upsert(makeMetrics({ tool: "exec", context: "home-assistant", compositeScore: 0.8 }));
    const rows = store.getToolEffectiveness("exec", "home-assistant");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.context).toBe("home-assistant");
  });

  it("same tool can have different scores per context", () => {
    store.upsert(makeMetrics({ tool: "exec", context: "general", compositeScore: 0.6 }));
    store.upsert(makeMetrics({ tool: "exec", context: "home-assistant", compositeScore: 0.9 }));
    const general = store.getToolEffectiveness("exec", "general");
    const ha = store.getToolEffectiveness("exec", "home-assistant");
    expect(general[0]?.compositeScore).toBeCloseTo(0.6, 2);
    expect(ha[0]?.compositeScore).toBeCloseTo(0.9, 2);
  });

  it("getToolEffectiveness without context returns all rows for tool", () => {
    store.upsert(makeMetrics({ tool: "browser", context: "general", compositeScore: 0.5 }));
    store.upsert(makeMetrics({ tool: "browser", context: "research", compositeScore: 0.7 }));
    const all = store.getToolEffectiveness("browser");
    expect(all).toHaveLength(2);
  });

  it("getToolEffectiveness returns empty array for unknown tool", () => {
    const rows = store.getToolEffectiveness("nonexistent", "general");
    expect(rows).toHaveLength(0);
  });

  it("recordToolOutcome increments counts correctly", () => {
    store.recordToolOutcome("exec", "success", "general", 100);
    store.recordToolOutcome("exec", "success", "general", 200);
    store.recordToolOutcome("exec", "failure", "general", 50);
    const rows = store.getToolEffectiveness("exec", "general");
    expect(rows).toHaveLength(1);
    const m = rows[0]!;
    expect(m.totalCalls).toBe(3);
    expect(m.successCalls).toBe(2);
    expect(m.failureCalls).toBe(1);
  });

  it("recordToolOutcome creates separate row per context", () => {
    store.recordToolOutcome("exec", "success", "general");
    store.recordToolOutcome("exec", "success", "coding");
    const all = store.getToolEffectiveness("exec");
    expect(all).toHaveLength(2);
    const contexts = all.map((r) => r.context).sort();
    expect(contexts).toEqual(["coding", "general"]);
  });
});

// ---------------------------------------------------------------------------
// generateToolHint
// ---------------------------------------------------------------------------

describe("generateToolHint", () => {
  let tmpDir: string;
  let store: ToolEffectivenessStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tool-hint-test-"));
    store = makeStore(tmpDir);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty string when no data", () => {
    const hint = generateToolHint(store, "home-assistant");
    expect(hint).toBe("");
  });

  it("returns empty string when only one tool qualifies", () => {
    store.upsert(makeMetrics({ tool: "exec", context: "home-assistant", totalCalls: 10, compositeScore: 0.8 }));
    const hint = generateToolHint(store, "home-assistant", 5, 0.3);
    expect(hint).toBe("");
  });

  it("returns empty string when score spread is below threshold", () => {
    store.upsert(makeMetrics({ tool: "exec", context: "home-assistant", totalCalls: 10, compositeScore: 0.7 }));
    store.upsert(makeMetrics({ tool: "browser", context: "home-assistant", totalCalls: 8, compositeScore: 0.65 }));
    // Spread = 0.05, threshold = 0.3
    const hint = generateToolHint(store, "home-assistant", 5, 0.3);
    expect(hint).toBe("");
  });

  it("returns hint when two tools have sufficient spread", () => {
    store.upsert(makeMetrics({ tool: "exec", context: "home-assistant", totalCalls: 23, compositeScore: 0.8 }));
    store.upsert(makeMetrics({ tool: "browser", context: "home-assistant", totalCalls: 8, compositeScore: 0.3 }));
    const hint = generateToolHint(store, "home-assistant", 5, 0.3);
    expect(hint).not.toBe("");
    expect(hint).toContain("home-assistant");
    expect(hint).toContain("exec");
    expect(hint).toContain("Prefer exec");
    expect(hint).toContain("tool-hint");
  });

  it("respects minUses filter — excludes tools below threshold", () => {
    store.upsert(makeMetrics({ tool: "exec", context: "general", totalCalls: 20, compositeScore: 0.9 }));
    store.upsert(makeMetrics({ tool: "browser", context: "general", totalCalls: 2, compositeScore: 0.1 }));
    // browser has only 2 uses, minUses=5 → should be excluded → only 1 tool → empty
    const hint = generateToolHint(store, "general", 5, 0.3);
    expect(hint).toBe("");
  });

  it("ignores tools from other contexts", () => {
    store.upsert(makeMetrics({ tool: "exec", context: "coding", totalCalls: 20, compositeScore: 0.9 }));
    store.upsert(makeMetrics({ tool: "browser", context: "coding", totalCalls: 10, compositeScore: 0.3 }));
    // Query for "home-assistant" context — should see nothing
    const hint = generateToolHint(store, "home-assistant", 5, 0.3);
    expect(hint).toBe("");
  });
});

// ---------------------------------------------------------------------------
// generateMonthlyReport
// ---------------------------------------------------------------------------

describe("generateMonthlyReport", () => {
  let tmpDir: string;
  let store: ToolEffectivenessStore;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "monthly-report-test-"));
    store = makeStore(tmpDir);
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    try {
      factsDb.close?.();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not store fact when no tool data", async () => {
    await generateMonthlyReport(store, factsDb);
    const facts = factsDb.getByCategory("pattern");
    const reports = facts.filter((f) => f.tags?.includes("monthly-report"));
    expect(reports).toHaveLength(0);
  });

  it("stores a pattern fact with correct tags when tools are scored", async () => {
    store.upsert(makeMetrics({ tool: "exec", context: "general", compositeScore: 0.85, totalCalls: 50 }));
    store.upsert(makeMetrics({ tool: "browser", context: "general", compositeScore: 0.4, totalCalls: 20 }));

    await generateMonthlyReport(store, factsDb);

    const facts = factsDb.getByCategory("pattern");
    const reports = facts.filter((f) => f.tags?.includes("monthly-report"));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.tags).toContain("tool-effectiveness");
    expect(reports[0]?.tags).toContain("monthly-report");
    expect(reports[0]?.importance).toBeCloseTo(0.7, 2);
  });

  it("includes top tools in the stored fact text", async () => {
    store.upsert(makeMetrics({ tool: "exec", context: "general", compositeScore: 0.9, totalCalls: 30 }));
    store.upsert(makeMetrics({ tool: "read", context: "general", compositeScore: 0.7, totalCalls: 15 }));

    await generateMonthlyReport(store, factsDb);

    const facts = factsDb.getByCategory("pattern");
    const report = facts.find((f) => f.tags?.includes("monthly-report"));
    expect(report).toBeDefined();
    expect(report?.text).toContain("exec");
  });
});
