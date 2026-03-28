// @ts-nocheck
/**
 * Tests for the RRF scoring pipeline (Issue #152).
 *
 * Covers: RRF score calculation, multi-strategy fusion, post-RRF adjustments,
 * token budget packing, deduplication, edge cases, and large result sets.
 */

import { describe, expect, it } from "vitest";
import { _testing } from "../index.js";

const {
  fuseResults,
  applyPostRrfAdjustments,
  RRF_K_DEFAULT,
  packIntoBudget,
  serializeFactForContext,
  estimateTokenCount,
} = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRanked(factId: string, rank: number, source: "semantic" | "fts5" | "graph") {
  return { factId, rank, source };
}

function makeEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    text: `Fact text for ${id}`,
    category: "fact" as const,
    importance: 0.7,
    entity: null,
    key: null,
    value: null,
    source: "conversation",
    createdAt: 1_700_000_000,
    sourceDate: 1_700_000_000,
    decayClass: "stable" as const,
    expiresAt: null,
    lastConfirmedAt: 1_700_000_000,
    confidence: 1.0,
    recallCount: 0,
    lastAccessed: null,
    ...overrides,
  };
}

function makeMeta(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    confidence: 1.0,
    lastAccessed: null,
    recallCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RRF score calculation — single strategy
// ---------------------------------------------------------------------------

describe("fuseResults — single strategy", () => {
  it("single result from one strategy has score 1/(k+1)", () => {
    const strategy = new Map([["fts5", [makeRanked("fact-1", 1, "fts5")]]]);
    const fused = fuseResults(strategy);
    expect(fused).toHaveLength(1);
    expect(fused[0].factId).toBe("fact-1");
    expect(fused[0].rrfScore).toBeCloseTo(1 / (RRF_K_DEFAULT + 1));
    expect(fused[0].finalScore).toBeCloseTo(1 / (RRF_K_DEFAULT + 1));
  });

  it("multiple results from one strategy are ranked by score descending", () => {
    const strategy = new Map([
      ["fts5", [makeRanked("fact-1", 1, "fts5"), makeRanked("fact-2", 2, "fts5"), makeRanked("fact-3", 3, "fts5")]],
    ]);
    const fused = fuseResults(strategy);
    expect(fused).toHaveLength(3);
    // rank 1 > rank 2 > rank 3
    expect(fused[0].factId).toBe("fact-1");
    expect(fused[0].rrfScore).toBeGreaterThan(fused[1].rrfScore);
    expect(fused[1].rrfScore).toBeGreaterThan(fused[2].rrfScore);
  });
});

// ---------------------------------------------------------------------------
// RRF score — multiple strategies
// ---------------------------------------------------------------------------

describe("fuseResults — multiple strategies", () => {
  it("fact in 2 of 3 strategies has higher score than fact in 1", () => {
    const strategy = new Map([
      ["semantic", [makeRanked("shared", 1, "semantic"), makeRanked("unique-a", 2, "semantic")]],
      ["fts5", [makeRanked("shared", 1, "fts5"), makeRanked("unique-b", 2, "fts5")]],
      ["graph", [makeRanked("unique-c", 1, "graph")]],
    ]);
    const fused = fuseResults(strategy);
    const shared = fused.find((r) => r.factId === "shared");
    const uniqueA = fused.find((r) => r.factId === "unique-a");
    expect(shared).toBeDefined();
    expect(uniqueA).toBeDefined();
    expect(shared?.rrfScore).toBeGreaterThan(uniqueA?.rrfScore);
  });

  it("fact in all 3 strategies accumulates scores from each", () => {
    const strategy = new Map([
      ["semantic", [makeRanked("triple", 1, "semantic")]],
      ["fts5", [makeRanked("triple", 1, "fts5")]],
      ["graph", [makeRanked("triple", 1, "graph")]],
    ]);
    const fused = fuseResults(strategy);
    expect(fused).toHaveLength(1);
    // Should be 3 * 1/(k+1)
    expect(fused[0].rrfScore).toBeCloseTo(3 / (RRF_K_DEFAULT + 1));
    expect(fused[0].sources).toHaveLength(3);
  });

  it("sources array records strategy and rank for each contributing strategy", () => {
    const strategy = new Map([
      ["semantic", [makeRanked("fact-1", 2, "semantic")]],
      ["fts5", [makeRanked("fact-1", 5, "fts5")]],
    ]);
    const fused = fuseResults(strategy);
    expect(fused[0].sources).toHaveLength(2);
    const semSrc = fused[0].sources.find((s) => s.strategy === "semantic");
    const ftsSrc = fused[0].sources.find((s) => s.strategy === "fts5");
    expect(semSrc?.rank).toBe(2);
    expect(ftsSrc?.rank).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// k parameter
// ---------------------------------------------------------------------------

describe("fuseResults — k parameter", () => {
  it("higher k reduces score differences between ranks", () => {
    const k10Strategy = new Map([["fts5", [makeRanked("a", 1, "fts5"), makeRanked("b", 10, "fts5")]]]);
    const k100Strategy = new Map([["fts5", [makeRanked("a", 1, "fts5"), makeRanked("b", 10, "fts5")]]]);
    const fused10 = fuseResults(k10Strategy, 10);
    const fused100 = fuseResults(k100Strategy, 100);

    const score10a = fused10.find((r) => r.factId === "a")?.rrfScore;
    const score10b = fused10.find((r) => r.factId === "b")?.rrfScore;
    const score100a = fused100.find((r) => r.factId === "a")?.rrfScore;
    const score100b = fused100.find((r) => r.factId === "b")?.rrfScore;

    const ratio10 = score10a / score10b;
    const ratio100 = score100a / score100b;
    // With k=10, rank difference is larger; with k=100, scores are more similar
    expect(ratio10).toBeGreaterThan(ratio100);
  });

  it("k=60 is the default", () => {
    const strategy = new Map([["fts5", [makeRanked("x", 1, "fts5")]]]);
    const fused = fuseResults(strategy);
    expect(fused[0].rrfScore).toBeCloseTo(1 / (60 + 1));
  });
});

// ---------------------------------------------------------------------------
// Post-RRF adjustments
// ---------------------------------------------------------------------------

describe("applyPostRrfAdjustments — recency", () => {
  it("fact accessed today has near-neutral recency multiplier", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const strategy = new Map([["fts5", [makeRanked("recent", 1, "fts5")]]]);
    const fused = fuseResults(strategy);
    const meta = new Map([["recent", makeMeta("recent", { lastAccessed: nowSec })]]);
    applyPostRrfAdjustments(fused, meta as any, nowSec);
    // log(0+1) = 0, so multiplier = 1 + 0 * -0.01 = 1.0
    expect(fused[0].finalScore).toBeCloseTo(fused[0].rrfScore, 5);
  });

  it("older fact gets a smaller recency multiplier", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = nowSec - 30 * 86_400;

    const strategy = new Map([["fts5", [makeRanked("old", 1, "fts5"), makeRanked("fresh", 2, "fts5")]]]);
    const fused = fuseResults(strategy);
    const meta = new Map([
      ["old", makeMeta("old", { lastAccessed: thirtyDaysAgo, confidence: 1.0 })],
      ["fresh", makeMeta("fresh", { lastAccessed: nowSec, confidence: 1.0 })],
    ]);
    applyPostRrfAdjustments(fused, meta as any, nowSec);

    const oldResult = fused.find((r) => r.factId === "old")!;
    const freshResult = fused.find((r) => r.factId === "fresh")!;
    // Even though "old" had higher RRF score (rank 1), recency penalty should reduce it
    // relative to "fresh" (which has a larger relative RRF share after adjustment)
    // The penalty: log(31) * -0.01 ≈ -0.034
    const expectedMultiplier = 1 + Math.log(30 + 1) * -0.01;
    expect(oldResult.finalScore).toBeCloseTo(oldResult.rrfScore * expectedMultiplier, 5);
    expect(freshResult.finalScore).toBeCloseTo(freshResult.rrfScore, 5);
  });
});

describe("applyPostRrfAdjustments — confidence", () => {
  it("high-confidence fact scores higher than low-confidence", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const strategy = new Map([["fts5", [makeRanked("high-conf", 1, "fts5"), makeRanked("low-conf", 2, "fts5")]]]);
    const fused = fuseResults(strategy);
    const meta = new Map([
      ["high-conf", makeMeta("high-conf", { confidence: 0.95 })],
      ["low-conf", makeMeta("low-conf", { confidence: 0.3 })],
    ]);
    applyPostRrfAdjustments(fused, meta as any, nowSec);
    const high = fused.find((r) => r.factId === "high-conf")!;
    const low = fused.find((r) => r.factId === "low-conf")!;
    expect(high.finalScore).toBeGreaterThan(low.finalScore);
  });

  it("confidence multiplier applied correctly", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const strategy = new Map([["fts5", [makeRanked("fact", 1, "fts5")]]]);
    const fused = fuseResults(strategy);
    const rrfScore = fused[0].rrfScore;
    const meta = new Map([["fact", makeMeta("fact", { confidence: 0.6 })]]);
    applyPostRrfAdjustments(fused, meta as any, nowSec);
    // No recency penalty (lastAccessed null), confidence = 0.6, no freq boost
    expect(fused[0].finalScore).toBeCloseTo(rrfScore * 0.6, 5);
  });
});

describe("applyPostRrfAdjustments — access frequency", () => {
  it("frequently recalled fact gets a boost", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const strategy = new Map([["fts5", [makeRanked("hot", 1, "fts5"), makeRanked("cold", 2, "fts5")]]]);
    const fused = fuseResults(strategy);
    const meta = new Map([
      ["hot", makeMeta("hot", { recallCount: 10, confidence: 1.0 })],
      ["cold", makeMeta("cold", { recallCount: 0, confidence: 1.0 })],
    ]);
    applyPostRrfAdjustments(fused, meta as any, nowSec);
    const hot = fused.find((r) => r.factId === "hot")!;
    // hot: boost = 1 + min(10*0.02, 0.2) = 1.2
    expect(hot.finalScore).toBeCloseTo(hot.rrfScore * 1.2, 5);
  });

  it("access frequency boost is capped at 0.2 (20%)", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const strategy = new Map([["fts5", [makeRanked("very-hot", 1, "fts5")]]]);
    const fused = fuseResults(strategy);
    const rrfScore = fused[0].rrfScore;
    const meta = new Map([["very-hot", makeMeta("very-hot", { recallCount: 100, confidence: 1.0 })]]);
    applyPostRrfAdjustments(fused, meta as any, nowSec);
    // cap at +20% → multiplier = 1.2
    expect(fused[0].finalScore).toBeCloseTo(rrfScore * 1.2, 5);
  });
});

// ---------------------------------------------------------------------------
// Token budget packing
// ---------------------------------------------------------------------------

describe("packIntoBudget", () => {
  it("respects token budget limit", () => {
    const entries = Array.from({ length: 20 }, (_, i) => {
      const id = `fact-${i}`;
      return { factId: id, entry: makeEntry(id) };
    });
    // Budget of 10 tokens — very small
    const { packed, tokensUsed } = packIntoBudget(entries as any, 10);
    expect(tokensUsed).toBeLessThanOrEqual(10);
    // Some entries should be excluded
    expect(packed.length).toBeLessThan(20);
  });

  it("prioritizes highest-scored facts (entries in order, first is best)", () => {
    const entries = [
      { factId: "best", entry: makeEntry("best", { text: "Best result" }) },
      { factId: "second", entry: makeEntry("second", { text: "Second result" }) },
      { factId: "third", entry: makeEntry("third", { text: "Third result" }) },
    ];
    // Budget large enough for only 1 entry (each entry is roughly 25 chars / 4 ≈ 7 tokens for header + text)
    const { packed } = packIntoBudget(entries as any, 20);
    expect(packed.length).toBeGreaterThan(0);
    // First entry should be in packed (highest priority)
    expect(packed[0]).toContain("Best result");
  });

  it("returns all entries when budget is large enough", () => {
    const entries = [
      { factId: "a", entry: makeEntry("a") },
      { factId: "b", entry: makeEntry("b") },
    ];
    const { packed } = packIntoBudget(entries as any, 10_000);
    expect(packed).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("fuseResults — edge cases", () => {
  it("empty results from all strategies returns empty array", () => {
    const strategy = new Map<string, ReturnType<typeof makeRanked>[]>();
    const fused = fuseResults(strategy);
    expect(fused).toHaveLength(0);
  });

  it("empty list for one strategy is handled gracefully", () => {
    const strategy = new Map([
      ["semantic", [] as ReturnType<typeof makeRanked>[]],
      ["fts5", [makeRanked("fact-1", 1, "fts5")]],
    ]);
    const fused = fuseResults(strategy);
    expect(fused).toHaveLength(1);
    expect(fused[0].factId).toBe("fact-1");
  });

  it("deduplication: same factId from multiple strategies counted once in output", () => {
    const strategy = new Map([
      ["semantic", [makeRanked("dup", 1, "semantic")]],
      ["fts5", [makeRanked("dup", 1, "fts5")]],
    ]);
    const fused = fuseResults(strategy);
    // Only one entry for "dup" in output
    const dupResults = fused.filter((r) => r.factId === "dup");
    expect(dupResults).toHaveLength(1);
    // But score includes both contributions
    expect(dupResults[0].rrfScore).toBeCloseTo(2 / (RRF_K_DEFAULT + 1), 10);
  });

  it("graph walk stub (empty strategy) returns results from other strategies", () => {
    const strategy = new Map([
      ["fts5", [makeRanked("real-fact", 1, "fts5")]],
      ["graph", [] as ReturnType<typeof makeRanked>[]],
    ]);
    const fused = fuseResults(strategy);
    expect(fused).toHaveLength(1);
    expect(fused[0].factId).toBe("real-fact");
  });

  it("large result sets (100+ per strategy) fuse correctly", () => {
    const semanticResults = Array.from({ length: 100 }, (_, i) => makeRanked(`fact-${i}`, i + 1, "semantic"));
    const ftsResults = Array.from(
      { length: 100 },
      (_, i) => makeRanked(`fact-${i + 50}`, i + 1, "fts5"), // overlapping from 50–99
    );
    const strategy = new Map([
      ["semantic", semanticResults],
      ["fts5", ftsResults],
    ]);
    const fused = fuseResults(strategy);
    // 0–49 from semantic only, 50–99 from both, 100–149 from fts5 only = 150 unique
    expect(fused).toHaveLength(150);

    // Facts 50–99 appear in both — should have higher scores than those in one only
    const inBoth = fused.find((r) => r.factId === "fact-50");
    const onlySemantic = fused.find((r) => r.factId === "fact-0");
    expect(inBoth).toBeDefined();
    expect(onlySemantic).toBeDefined();
    expect(inBoth?.rrfScore).toBeGreaterThan(onlySemantic?.rrfScore);
  });
});

// ---------------------------------------------------------------------------
// serializeFactForContext
// ---------------------------------------------------------------------------

describe("serializeFactForContext", () => {
  it("includes entity, category, confidence, and stored date in header", () => {
    const entry = makeEntry("x", { entity: "Claude", confidence: 0.88, createdAt: 1_700_000_000 });
    const serialized = serializeFactForContext(entry as any);
    expect(serialized).toContain("entity: Claude");
    expect(serialized).toContain("category: fact");
    expect(serialized).toContain("confidence: 0.88");
    expect(serialized).toContain("stored:");
    expect(serialized).toContain(entry.text);
  });

  it("omits entity from header when null", () => {
    const entry = makeEntry("y", { entity: null });
    const serialized = serializeFactForContext(entry as any);
    expect(serialized).not.toContain("entity:");
  });
});

// ---------------------------------------------------------------------------
// estimateTokenCount
// ---------------------------------------------------------------------------

describe("estimateTokenCount", () => {
  it("estimates tokens as ceil(chars / 4)", () => {
    expect(estimateTokenCount("abcd")).toBe(1);
    expect(estimateTokenCount("abcde")).toBe(2);
    expect(estimateTokenCount("")).toBe(0);
    expect(estimateTokenCount("a".repeat(400))).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

describe("DEFAULT_RETRIEVAL_CONFIG", () => {
  it("has expected defaults", () => {
    const { DEFAULT_RETRIEVAL_CONFIG } = _testing;
    expect(DEFAULT_RETRIEVAL_CONFIG.rrf_k).toBe(60);
    expect(DEFAULT_RETRIEVAL_CONFIG.ambientBudgetTokens).toBe(2000);
    expect(DEFAULT_RETRIEVAL_CONFIG.explicitBudgetTokens).toBe(4000);
    expect(DEFAULT_RETRIEVAL_CONFIG.semanticTopK).toBe(20);
    expect(DEFAULT_RETRIEVAL_CONFIG.graphWalkDepth).toBe(2);
    expect(DEFAULT_RETRIEVAL_CONFIG.strategies).toContain("semantic");
    expect(DEFAULT_RETRIEVAL_CONFIG.strategies).toContain("fts5");
    expect(DEFAULT_RETRIEVAL_CONFIG.strategies).toContain("graph");
  });
});
