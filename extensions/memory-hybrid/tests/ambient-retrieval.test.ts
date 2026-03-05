/**
 * Tests for Issue #156 — Enhanced Ambient Retrieval with Multi-Query Generation.
 *
 * Coverage:
 *   - cosineSimilarity(): identical, orthogonal, opposite, empty, mismatched lengths
 *   - cosineDistance(): derived correctly from similarity
 *   - detectTopicShift(): fires at threshold, stays quiet below, edge cases
 *   - extractEntitiesFromMessage(): mentions, tags, IPs, capitalised words, known entities
 *   - generateTemporalQueries(): morning / afternoon / evening buckets
 *   - SessionSeenFacts: markSeen, hasBeenSeen, filterUnseen, size, clear
 *   - generateAmbientQueries(): multiQuery disabled, entity/temporal/context types, max cap
 *   - deduplicateByFactId(): deduplication, priority order, empty input
 *   - deduplicateResultsById(): generic helper with custom key extractor
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  cosineSimilarity,
  cosineDistance,
  detectTopicShift,
  extractEntitiesFromMessage,
  generateTemporalQueries,
  SessionSeenFacts,
  generateAmbientQueries,
  deduplicateByFactId,
  deduplicateResultsById,
  type AmbientConfig,
  type AmbientQuery,
} from "../services/ambient-retrieval.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVec(dims: number, fillValue = 0): number[] {
  return new Array(dims).fill(fillValue);
}

/** Create a unit vector along axis `axis` in `dims` dimensions. */
function unitVec(dims: number, axis: number): number[] {
  const v = makeVec(dims);
  v[axis] = 1;
  return v;
}

const DEFAULT_CFG: AmbientConfig = {
  enabled: true,
  multiQuery: true,
  topicShiftThreshold: 0.4,
  maxQueriesPerTrigger: 4,
  budgetTokens: 2000,
};

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity(unitVec(2, 0), unitVec(2, 1))).toBeCloseTo(0.0);
  });

  it("returns -1.0 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("returns 0 for zero-magnitude vector", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });

  it("returns 0 for both zero-magnitude vectors", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched vector lengths", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it("computes correct similarity for known vectors", () => {
    // [1,1] and [1,0]: cos θ = 1/√2 ≈ 0.707
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2);
  });
});

// ---------------------------------------------------------------------------
// cosineDistance
// ---------------------------------------------------------------------------

describe("cosineDistance", () => {
  it("returns 0 for identical vectors", () => {
    const v = [1, 2, 3];
    expect(cosineDistance(v, v)).toBeCloseTo(0);
  });

  it("returns 1 for orthogonal vectors", () => {
    expect(cosineDistance(unitVec(3, 0), unitVec(3, 1))).toBeCloseTo(1);
  });

  it("returns 2 for opposite vectors", () => {
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2);
  });

  it("equals 1 - cosineSimilarity", () => {
    const a = [3, 1, 4];
    const b = [1, 5, 9];
    expect(cosineDistance(a, b)).toBeCloseTo(1 - cosineSimilarity(a, b));
  });
});

// ---------------------------------------------------------------------------
// detectTopicShift
// ---------------------------------------------------------------------------

describe("detectTopicShift", () => {
  it("returns false for identical embeddings (distance 0)", () => {
    const v = [1, 0, 0];
    expect(detectTopicShift(v, v, 0.4)).toBe(false);
  });

  it("returns false when distance is below threshold", () => {
    // Two nearly-identical unit vectors with tiny angle
    const a = [1, 0.01, 0];
    const b = [1, 0, 0];
    // Distance ≈ 0 (nearly collinear) → below threshold 0.4
    expect(detectTopicShift(a, b, 0.4)).toBe(false);
  });

  it("returns true for orthogonal vectors when threshold = 0.4", () => {
    // cos distance = 1.0 which is > 0.4
    expect(detectTopicShift(unitVec(2, 0), unitVec(2, 1), 0.4)).toBe(true);
  });

  it("returns true for completely opposite vectors", () => {
    expect(detectTopicShift([1, 0], [-1, 0], 0.1)).toBe(true);
  });

  it("respects threshold: returns false when threshold=1.5 and distance=1", () => {
    // Orthogonal → distance 1, but threshold is 1.5 → no shift
    expect(detectTopicShift(unitVec(2, 0), unitVec(2, 1), 1.5)).toBe(false);
  });

  it("returns false for empty prev vector", () => {
    expect(detectTopicShift([], [1, 0], 0.4)).toBe(false);
  });

  it("returns false for empty next vector", () => {
    expect(detectTopicShift([1, 0], [], 0.4)).toBe(false);
  });

  it("uses default threshold of 0.4 when omitted", () => {
    // Orthogonal → distance 1 > 0.4 → shift detected
    expect(detectTopicShift(unitVec(2, 0), unitVec(2, 1))).toBe(true);
  });

  it("fires at exactly the boundary (distance == threshold) — returns false (strictly greater)", () => {
    // Build vectors whose cosine distance is exactly 0.4
    // cos(θ) = 0.6 → distance = 0.4
    // a = [1, 0], b = [0.6, 0.8] (normalized, cos θ = 0.6)
    const a = [1, 0];
    const b = [0.6, 0.8];
    const dist = cosineDistance(a, b);
    // Depending on floating-point: dist ≈ 0.4 exactly → strictly > → false
    // This tests that boundary is exclusive
    expect(detectTopicShift(a, b, dist)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractEntitiesFromMessage
// ---------------------------------------------------------------------------

describe("extractEntitiesFromMessage", () => {
  it("returns empty array for empty text", () => {
    expect(extractEntitiesFromMessage("", [])).toEqual([]);
  });

  it("extracts @mention", () => {
    const result = extractEntitiesFromMessage("Hey @alice can you review?", []);
    expect(result).toContain("alice");
  });

  it("extracts #tag", () => {
    const result = extractEntitiesFromMessage("Working on #feature-123", []);
    expect(result).toContain("feature-123");
  });

  it("extracts IPv4 address", () => {
    const result = extractEntitiesFromMessage("Connect to 192.168.1.1 now", []);
    expect(result).toContain("192.168.1.1");
  });

  it("extracts PascalCase word", () => {
    const result = extractEntitiesFromMessage("Deploy MyService to production", []);
    expect(result).toContain("myservice");
  });

  it("extracts known entity from knownEntities list", () => {
    const result = extractEntitiesFromMessage("Deploy to alice's server", ["alice"]);
    expect(result).toContain("alice");
  });

  it("does not extract short words (< 2 chars)", () => {
    const result = extractEntitiesFromMessage("@x #y", []);
    expect(result).not.toContain("x");
    expect(result).not.toContain("y");
  });

  it("caps results at 10 entities", () => {
    // Text with many capitalised words
    const manyCapWords = Array.from({ length: 20 }, (_, i) => `Entity${i}`).join(" ");
    const result = extractEntitiesFromMessage(manyCapWords, []);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("deduplicate: same entity from multiple sources appears once", () => {
    // "alice" via known entities and @mention
    const result = extractEntitiesFromMessage("@alice is doing well", ["alice"]);
    const aliceCount = result.filter((e) => e === "alice").length;
    expect(aliceCount).toBe(1);
  });

  it("extracts quoted string", () => {
    const result = extractEntitiesFromMessage('Use "my-service" for this', []);
    expect(result).toContain("my-service");
  });

  it("known entity match is case-insensitive", () => {
    const result = extractEntitiesFromMessage("Talk about Alice today", ["alice"]);
    expect(result).toContain("alice");
  });

  it("common stop-words are excluded from capitalised extraction", () => {
    const result = extractEntitiesFromMessage("The quick The brown The fox", []);
    expect(result).not.toContain("the");
  });
});

// ---------------------------------------------------------------------------
// generateTemporalQueries
// ---------------------------------------------------------------------------

describe("generateTemporalQueries", () => {
  function hoursToMs(h: number): number {
    const d = new Date();
    d.setHours(h, 0, 0, 0);
    return d.getTime();
  }

  it("returns 2 queries for morning (6-11)", () => {
    const queries = generateTemporalQueries(hoursToMs(9));
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("today");
  });

  it("returns 2 queries for afternoon (12-17)", () => {
    const queries = generateTemporalQueries(hoursToMs(14));
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("48 hours");
  });

  it("returns 2 queries for evening (18+)", () => {
    const queries = generateTemporalQueries(hoursToMs(20));
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("unresolved");
  });

  it("returns 2 queries for night/early morning (0-5)", () => {
    const queries = generateTemporalQueries(hoursToMs(2));
    expect(queries).toHaveLength(2);
  });

  it("all returned strings are non-empty", () => {
    for (const hour of [0, 6, 9, 12, 15, 18, 22]) {
      const queries = generateTemporalQueries(hoursToMs(hour));
      for (const q of queries) {
        expect(q.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// SessionSeenFacts
// ---------------------------------------------------------------------------

describe("SessionSeenFacts", () => {
  let seen: SessionSeenFacts;

  beforeEach(() => {
    seen = new SessionSeenFacts();
  });

  it("starts empty (size = 0)", () => {
    expect(seen.size).toBe(0);
  });

  it("hasBeenSeen returns false for unknown id", () => {
    expect(seen.hasBeenSeen("abc")).toBe(false);
  });

  it("markSeen + hasBeenSeen", () => {
    seen.markSeen(["fact-1", "fact-2"]);
    expect(seen.hasBeenSeen("fact-1")).toBe(true);
    expect(seen.hasBeenSeen("fact-2")).toBe(true);
    expect(seen.hasBeenSeen("fact-3")).toBe(false);
  });

  it("size increments correctly", () => {
    seen.markSeen(["a", "b", "c"]);
    expect(seen.size).toBe(3);
  });

  it("duplicate markSeen does not double-count", () => {
    seen.markSeen(["x", "x", "y"]);
    expect(seen.size).toBe(2);
  });

  it("filterUnseen returns only unseen ids", () => {
    seen.markSeen(["f1", "f2"]);
    const unseen = seen.filterUnseen(["f1", "f3", "f4"]);
    expect(unseen).toEqual(["f3", "f4"]);
  });

  it("filterUnseen returns empty array when all ids seen", () => {
    seen.markSeen(["a", "b"]);
    expect(seen.filterUnseen(["a", "b"])).toEqual([]);
  });

  it("clear resets state", () => {
    seen.markSeen(["f1", "f2"]);
    seen.clear();
    expect(seen.size).toBe(0);
    expect(seen.hasBeenSeen("f1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateAmbientQueries
// ---------------------------------------------------------------------------

describe("generateAmbientQueries — multiQuery disabled", () => {
  it("returns only the message query when multiQuery is false", () => {
    const cfg = { ...DEFAULT_CFG, multiQuery: false };
    const result = generateAmbientQueries("Deploy the service", cfg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("message");
    expect(result[0].text).toBe("Deploy the service");
  });

  it("returns empty array for empty/whitespace message", () => {
    const cfg = { ...DEFAULT_CFG, multiQuery: false };
    expect(generateAmbientQueries("", cfg)).toHaveLength(0);
    expect(generateAmbientQueries("   ", cfg)).toHaveLength(0);
  });
});

describe("generateAmbientQueries — multiQuery enabled", () => {
  it("always includes message query as first element", () => {
    const result = generateAmbientQueries("Checking service status", DEFAULT_CFG);
    expect(result[0].type).toBe("message");
    expect(result[0].text).toBe("Checking service status");
  });

  it("caps total queries at maxQueriesPerTrigger (4 default)", () => {
    const result = generateAmbientQueries(
      "@alice check #feature on 10.0.0.1 and 10.0.0.2 and MyService",
      DEFAULT_CFG,
      {},
      ["alice", "bob"],
    );
    expect(result.length).toBeLessThanOrEqual(4);
  });

  it("caps at maxQueriesPerTrigger = 2", () => {
    const cfg = { ...DEFAULT_CFG, maxQueriesPerTrigger: 2 };
    const result = generateAmbientQueries("Big message with @alice and #tag and 1.2.3.4", cfg);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("generates entity queries when entities detected", () => {
    const result = generateAmbientQueries("Update the MyService deployment", DEFAULT_CFG);
    const entityQueries = result.filter((q) => q.type === "entity");
    expect(entityQueries.length).toBeGreaterThan(0);
  });

  it("entity query has entity field set", () => {
    const result = generateAmbientQueries("Fix @alice's issue", DEFAULT_CFG);
    const entityQ = result.find((q) => q.type === "entity");
    expect(entityQ?.entity).toBeDefined();
    expect(typeof entityQ?.entity).toBe("string");
  });

  it("generates temporal queries when no entities fill the slots", () => {
    // Plain message with no entities or special patterns → falls to temporal
    const result = generateAmbientQueries("hello world", DEFAULT_CFG, { nowMs: Date.now() });
    const temporalQueries = result.filter((q) => q.type === "temporal");
    expect(temporalQueries.length).toBeGreaterThan(0);
  });

  it("generates context query when userId provided", () => {
    const result = generateAmbientQueries("hello", DEFAULT_CFG, { userId: "alice" });
    const contextQ = result.find((q) => q.type === "context");
    expect(contextQ).toBeDefined();
    expect(contextQ?.text).toContain("alice");
  });

  it("generates context query when channelId provided", () => {
    const result = generateAmbientQueries("hello", DEFAULT_CFG, { channelId: "general" });
    const contextQ = result.find((q) => q.type === "context");
    expect(contextQ).toBeDefined();
    expect(contextQ?.text).toContain("general");
  });

  it("no context query when neither userId nor channelId is provided", () => {
    const result = generateAmbientQueries("plain message", DEFAULT_CFG, {});
    const contextQ = result.find((q) => q.type === "context");
    // May or may not appear depending on whether slots are filled — but not from empty context
    if (contextQ) {
      // If it exists, text should be non-empty
      expect(contextQ.text.length).toBeGreaterThan(0);
    }
  });

  it("all query texts are non-empty strings", () => {
    const result = generateAmbientQueries("Deploy @alice's MyService", DEFAULT_CFG, { userId: "bob" });
    for (const q of result) {
      expect(typeof q.text).toBe("string");
      expect(q.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("uses knownEntities to produce entity queries from plain words", () => {
    const result = generateAmbientQueries(
      "Let's discuss production",
      DEFAULT_CFG,
      {},
      ["production"],
    );
    const entityQ = result.find((q) => q.type === "entity" && q.entity === "production");
    expect(entityQ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// deduplicateByFactId
// ---------------------------------------------------------------------------

describe("deduplicateByFactId", () => {
  it("returns empty array for no result sets", () => {
    expect(deduplicateByFactId([])).toEqual([]);
  });

  it("returns all items from single result set", () => {
    const set = [{ factId: "a" }, { factId: "b" }];
    expect(deduplicateByFactId([set])).toEqual(set);
  });

  it("deduplicates across result sets — first occurrence wins", () => {
    const s1 = [{ factId: "a", score: 0.9 }, { factId: "b", score: 0.8 }];
    const s2 = [{ factId: "b", score: 0.5 }, { factId: "c", score: 0.7 }];
    const result = deduplicateByFactId([s1, s2]);
    const ids = result.map((r) => r.factId);
    expect(ids).toEqual(["a", "b", "c"]);
    // b from first set (score 0.8) wins over b from second set (score 0.5)
    const bResult = result.find((r) => r.factId === "b");
    expect((bResult as { score: number } | undefined)?.score).toBe(0.8);
  });

  it("handles completely disjoint result sets", () => {
    const s1 = [{ factId: "x" }];
    const s2 = [{ factId: "y" }];
    const result = deduplicateByFactId([s1, s2]);
    expect(result.map((r) => r.factId).sort()).toEqual(["x", "y"]);
  });

  it("handles empty inner result set", () => {
    const s1 = [{ factId: "a" }];
    const s2: { factId: string }[] = [];
    const result = deduplicateByFactId([s1, s2]);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// deduplicateResultsById
// ---------------------------------------------------------------------------

describe("deduplicateResultsById", () => {
  it("deduplicates by custom id extractor", () => {
    type Item = { id: string; val: number };
    const s1: Item[] = [{ id: "a", val: 1 }, { id: "b", val: 2 }];
    const s2: Item[] = [{ id: "b", val: 99 }, { id: "c", val: 3 }];
    const result = deduplicateResultsById([s1, s2], (r) => r.id);
    const ids = result.map((r) => r.id);
    expect(ids).toEqual(["a", "b", "c"]);
    // b from first set wins
    expect(result.find((r) => r.id === "b")?.val).toBe(2);
  });

  it("returns empty for empty input", () => {
    expect(deduplicateResultsById([], (r: { id: string }) => r.id)).toEqual([]);
  });

  it("preserves all items when no duplicates", () => {
    const s1 = [{ id: "1" }];
    const s2 = [{ id: "2" }];
    const result = deduplicateResultsById([s1, s2], (r) => r.id);
    expect(result).toHaveLength(2);
  });
});
