/**
 * Tests for Issue #145 — GraphRAG Retrieval: semantic search + graph traversal.
 *
 * Coverage:
 *   - expandGraph: empty seed set returns empty array
 *   - expandGraph: maxDepth=0 returns only direct seeds
 *   - expandGraph: single seed with no links returns only that seed
 *   - expandGraph: basic 1-hop expansion via outgoing link
 *   - expandGraph: basic 1-hop expansion via incoming link (bidirectional)
 *   - expandGraph: 2-hop traversal reaches grandchild facts
 *   - expandGraph: depth limit respected (depth=1 stops at 1 hop)
 *   - expandGraph: depth=3 reaches 3 hops
 *   - expandGraph: deduplication when multiple paths lead to same fact
 *   - expandGraph: direct results scored higher than 1-hop expanded
 *   - expandGraph: 1-hop expanded scored higher than 2-hop expanded
 *   - expandGraph: HOP_SCORE_DECAY applied correctly at each hop
 *   - expandGraph: link path annotated correctly for 1-hop outgoing
 *   - expandGraph: link path annotated correctly for 1-hop incoming
 *   - expandGraph: link path annotated correctly for 2-hop chain
 *   - expandGraph: maxExpandedResults limits graph-expanded results
 *   - expandGraph: expansionSource="direct" for seeds, "graph" for expanded
 *   - expandGraph: hopCount=0 for seeds, ≥1 for expanded
 *   - expandGraph: backward compatibility (maxDepth=0 = no expansion)
 *   - expandGraph: multiple seeds expand independently
 *   - expandGraph: various link types (RELATED_TO, PART_OF, CAUSED_BY, CONTRADICTS)
 *   - expandGraph: facts not found in DB are skipped
 *   - expandGraph: seed score propagates to expanded score via decay
 *   - formatLinkPath: empty path returns empty string
 *   - formatLinkPath: single step formatted correctly
 *   - formatLinkPath: multi-step path formatted correctly
 *   - HOP_SCORE_DECAY: index 0 is 1.0 (no decay for direct)
 *   - Integration with FactsDB: real DB links traversed correctly
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";
import type { MemoryEntry } from "../types/memory.js";

const { expandGraph, formatLinkPath, HOP_SCORE_DECAY, FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    text: `Text for ${id}`,
    category: "fact",
    importance: 0.7,
    entity: null,
    key: null,
    value: null,
    source: "conversation",
    createdAt: 1_700_000_000,
    sourceDate: null,
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: 1_700_000_000,
    confidence: 1.0,
    summary: null,
    tags: null,
    recallCount: 0,
    lastAccessed: null,
    supersededAt: null,
    supersededBy: null,
    supersedesId: null,
    validFrom: null,
    validUntil: null,
    tier: "warm",
    scope: "global",
    scopeTarget: null,
    procedureType: null,
    successCount: 0,
    lastValidated: null,
    sourceSessions: null,
    reinforcedCount: 0,
    lastReinforcedAt: null,
    reinforcedQuotes: null,
    ...overrides,
  };
}

/** Build a minimal GraphFactLookup mock. */
function buildMockDb(
  entries: MemoryEntry[],
  linksFrom: Record<string, Array<{ id: string; targetFactId: string; linkType: string; strength: number }>>,
  linksTo: Record<string, Array<{ id: string; sourceFactId: string; linkType: string; strength: number }>>,
) {
  const entryMap = new Map(entries.map((e) => [e.id, e]));
  return {
    getById: (id: string) => entryMap.get(id) ?? null,
    getLinksFrom: (id: string) => linksFrom[id] ?? [],
    getLinksTo: (id: string) => linksTo[id] ?? [],
  };
}

// ---------------------------------------------------------------------------
// expandGraph — basic seeds
// ---------------------------------------------------------------------------

describe("expandGraph: seed handling", () => {
  it("returns empty array when seed set is empty", () => {
    const db = buildMockDb([], {}, {});
    const result = expandGraph(db, [], {});
    expect(result).toHaveLength(0);
  });

  it("returns only seeds when maxDepth=0 (no expansion)", () => {
    const a = makeEntry("a");
    const db = buildMockDb(
      [a],
      { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }] },
      {},
    );
    const seeds = [{ factId: "a", score: 0.9, entry: a }];
    const result = expandGraph(db, seeds, { maxDepth: 0 });
    expect(result).toHaveLength(1);
    expect(result[0].factId).toBe("a");
    expect(result[0].expansionSource).toBe("direct");
  });

  it("returns only seed when seed has no links", () => {
    const a = makeEntry("a");
    const db = buildMockDb([a], {}, {});
    const seeds = [{ factId: "a", score: 0.8, entry: a }];
    const result = expandGraph(db, seeds, { maxDepth: 2 });
    expect(result).toHaveLength(1);
    expect(result[0].expansionSource).toBe("direct");
    expect(result[0].hopCount).toBe(0);
    expect(result[0].linkPath).toHaveLength(0);
  });

  it("marks all seeds as expansionSource=direct with hopCount=0", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb([a, b], {}, {});
    const seeds = [
      { factId: "a", score: 0.9, entry: a },
      { factId: "b", score: 0.7, entry: b },
    ];
    const result = expandGraph(db, seeds, { maxDepth: 0 });
    for (const r of result) {
      expect(r.expansionSource).toBe("direct");
      expect(r.hopCount).toBe(0);
      expect(r.linkPath).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// expandGraph — 1-hop expansion
// ---------------------------------------------------------------------------

describe("expandGraph: 1-hop expansion", () => {
  it("expands via outgoing link (getLinksFrom)", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb(
      [a, b],
      { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 0.8 }] },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 1 });
    expect(result).toHaveLength(2);
    const expanded = result.find((r) => r.factId === "b");
    expect(expanded).toBeDefined();
    expect(expanded!.expansionSource).toBe("graph");
    expect(expanded!.hopCount).toBe(1);
  });

  it("expands via incoming link (getLinksTo — bidirectional)", () => {
    const a = makeEntry("a");
    const c = makeEntry("c");
    const db = buildMockDb(
      [a, c],
      {},
      { a: [{ id: "l2", sourceFactId: "c", linkType: "CAUSED_BY", strength: 0.9 }] },
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 1 });
    expect(result).toHaveLength(2);
    const expanded = result.find((r) => r.factId === "c");
    expect(expanded).toBeDefined();
    expect(expanded!.expansionSource).toBe("graph");
    expect(expanded!.hopCount).toBe(1);
  });

  it("does not include seed facts in expanded results (no duplication)", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb(
      [a, b],
      { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }] },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 1 });
    const aResults = result.filter((r) => r.factId === "a");
    expect(aResults).toHaveLength(1); // seed appears once
    expect(aResults[0].expansionSource).toBe("direct");
  });
});

// ---------------------------------------------------------------------------
// expandGraph — multi-hop traversal
// ---------------------------------------------------------------------------

describe("expandGraph: multi-hop traversal", () => {
  it("reaches facts 2 hops away", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const db = buildMockDb(
      [a, b, c],
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "PART_OF", strength: 0.9 }],
      },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 2 });
    const factIds = result.map((r) => r.factId);
    expect(factIds).toContain("a");
    expect(factIds).toContain("b");
    expect(factIds).toContain("c");
    expect(result.find((r) => r.factId === "c")?.hopCount).toBe(2);
  });

  it("reaches facts 3 hops away when depth=3", () => {
    const facts = ["a", "b", "c", "d"].map((id) => makeEntry(id));
    const [a, b, c, d] = facts;
    const db = buildMockDb(
      facts,
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
        c: [{ id: "l3", targetFactId: "d", linkType: "RELATED_TO", strength: 1.0 }],
      },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 3 });
    expect(result.find((r) => r.factId === "d")?.hopCount).toBe(3);
  });

  it("respects depth limit — stops at depth=1 and does not reach 2-hop facts", () => {
    const facts = ["a", "b", "c"].map((id) => makeEntry(id));
    const [a, b] = facts;
    const db = buildMockDb(
      facts,
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
      },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 1 });
    expect(result.map((r) => r.factId)).not.toContain("c");
    expect(result.map((r) => r.factId)).toContain("b");
  });
});

// ---------------------------------------------------------------------------
// expandGraph — deduplication
// ---------------------------------------------------------------------------

describe("expandGraph: deduplication", () => {
  it("does not produce duplicate factIds when multiple paths lead to same fact", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    // Both a→c (direct 1-hop) and a→b→c (2-hop) paths to c
    const db = buildMockDb(
      [a, b, c],
      {
        a: [
          { id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 },
          { id: "l2", targetFactId: "c", linkType: "PART_OF", strength: 0.9 },
        ],
        b: [{ id: "l3", targetFactId: "c", linkType: "CAUSED_BY", strength: 0.8 }],
      },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 2 });
    const cEntries = result.filter((r) => r.factId === "c");
    expect(cEntries).toHaveLength(1);
    // Shorter path (1-hop) should be preferred
    expect(cEntries[0].hopCount).toBe(1);
  });

  it("keeps shortest hop path when same fact reachable via different depths", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const db = buildMockDb(
      [a, b, c],
      {
        a: [
          { id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 },
          { id: "l2", targetFactId: "c", linkType: "RELATED_TO", strength: 1.0 },
        ],
        b: [{ id: "l3", targetFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
      },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 2 });
    const cResult = result.find((r) => r.factId === "c");
    expect(cResult?.hopCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// expandGraph — ranking and scoring
// ---------------------------------------------------------------------------

describe("expandGraph: ranking and scoring", () => {
  it("direct results appear before expanded results in output", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb(
      [a, b],
      { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }] },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 0.5, entry: a }], { maxDepth: 1 });
    expect(result[0].factId).toBe("a"); // direct before expanded
    expect(result[0].expansionSource).toBe("direct");
  });

  it("1-hop expanded score = seedScore * HOP_SCORE_DECAY[1]", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb(
      [a, b],
      { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }] },
      {},
    );
    const seedScore = 0.8;
    const result = expandGraph(db, [{ factId: "a", score: seedScore, entry: a }], { maxDepth: 1 });
    const bResult = result.find((r) => r.factId === "b");
    expect(bResult?.score).toBeCloseTo(seedScore * HOP_SCORE_DECAY[1], 5);
  });

  it("2-hop expanded score = seedScore * HOP_SCORE_DECAY[2]", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const db = buildMockDb(
      [a, b, c],
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "PART_OF", strength: 1.0 }],
      },
      {},
    );
    const seedScore = 1.0;
    const result = expandGraph(db, [{ factId: "a", score: seedScore, entry: a }], { maxDepth: 2 });
    const cResult = result.find((r) => r.factId === "c");
    expect(cResult?.score).toBeCloseTo(seedScore * HOP_SCORE_DECAY[2], 5);
  });

  it("direct score is preserved unchanged (decay=1.0)", () => {
    const a = makeEntry("a");
    const db = buildMockDb([a], {}, {});
    const seedScore = 0.732;
    const result = expandGraph(db, [{ factId: "a", score: seedScore, entry: a }], { maxDepth: 0 });
    expect(result[0].score).toBeCloseTo(seedScore, 5);
  });

  it("HOP_SCORE_DECAY[0] === 1.0 (no decay for direct)", () => {
    expect(HOP_SCORE_DECAY[0]).toBe(1.0);
  });

  it("HOP_SCORE_DECAY decreases monotonically", () => {
    for (let i = 1; i < HOP_SCORE_DECAY.length; i++) {
      expect(HOP_SCORE_DECAY[i]).toBeLessThan(HOP_SCORE_DECAY[i - 1]);
    }
  });

  it("direct match scores higher than 1-hop expanded for same underlying quality", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb(
      [a, b],
      { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }] },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 0.9, entry: a }], { maxDepth: 1 });
    const directScore = result.find((r) => r.factId === "a")!.score;
    const expandedScore = result.find((r) => r.factId === "b")!.score;
    expect(directScore).toBeGreaterThan(expandedScore);
  });
});

// ---------------------------------------------------------------------------
// expandGraph — link path annotation
// ---------------------------------------------------------------------------

describe("expandGraph: link path annotation", () => {
  it("linkPath is empty for direct results", () => {
    const a = makeEntry("a");
    const db = buildMockDb([a], {}, {});
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 0 });
    expect(result[0].linkPath).toHaveLength(0);
  });

  it("1-hop outgoing: linkPath has one step with correct fromFactId, toFactId, linkType", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb(
      [a, b],
      { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 0.75 }] },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 1 });
    const bResult = result.find((r) => r.factId === "b")!;
    expect(bResult.linkPath).toHaveLength(1);
    expect(bResult.linkPath[0].fromFactId).toBe("a");
    expect(bResult.linkPath[0].toFactId).toBe("b");
    expect(bResult.linkPath[0].linkType).toBe("RELATED_TO");
    expect(bResult.linkPath[0].strength).toBeCloseTo(0.75);
  });

  it("1-hop incoming: linkPath has one step with correct structure", () => {
    const a = makeEntry("a");
    const c = makeEntry("c");
    const db = buildMockDb(
      [a, c],
      {},
      { a: [{ id: "l2", sourceFactId: "c", linkType: "CAUSED_BY", strength: 0.6 }] },
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 1 });
    const cResult = result.find((r) => r.factId === "c")!;
    expect(cResult.linkPath).toHaveLength(1);
    expect(cResult.linkPath[0].linkType).toBe("CAUSED_BY");
  });

  it("2-hop: linkPath has two steps for a chained traversal", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const db = buildMockDb(
      [a, b, c],
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "PART_OF", strength: 0.8 }],
      },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 2 });
    const cResult = result.find((r) => r.factId === "c")!;
    expect(cResult.linkPath).toHaveLength(2);
    expect(cResult.linkPath[0].linkType).toBe("RELATED_TO");
    expect(cResult.linkPath[1].linkType).toBe("PART_OF");
  });
});

// ---------------------------------------------------------------------------
// expandGraph — maxExpandedResults limit
// ---------------------------------------------------------------------------

describe("expandGraph: maxExpandedResults", () => {
  it("limits the number of graph-expanded results", () => {
    // Seed A links to many targets
    const a = makeEntry("a");
    const targets = Array.from({ length: 10 }, (_, i) => makeEntry(`t${i}`));
    const linksFrom: Record<string, Array<{ id: string; targetFactId: string; linkType: string; strength: number }>> = {
      a: targets.map((t, i) => ({ id: `l${i}`, targetFactId: t.id, linkType: "RELATED_TO", strength: 1.0 })),
    };
    const db = buildMockDb([a, ...targets], linksFrom, {});
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], {
      maxDepth: 1,
      maxExpandedResults: 3,
    });
    const expanded = result.filter((r) => r.expansionSource === "graph");
    expect(expanded).toHaveLength(3);
  });

  it("includes all expanded results when count < maxExpandedResults", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb(
      [a, b],
      { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }] },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], {
      maxDepth: 1,
      maxExpandedResults: 20,
    });
    expect(result.filter((r) => r.expansionSource === "graph")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// expandGraph — multiple seeds
// ---------------------------------------------------------------------------

describe("expandGraph: multiple seeds", () => {
  it("expands from multiple seeds independently", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const d = makeEntry("d");
    const db = buildMockDb(
      [a, b, c, d],
      {
        a: [{ id: "l1", targetFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "d", linkType: "RELATED_TO", strength: 1.0 }],
      },
      {},
    );
    const result = expandGraph(
      db,
      [
        { factId: "a", score: 0.9, entry: a },
        { factId: "b", score: 0.8, entry: b },
      ],
      { maxDepth: 1 },
    );
    const factIds = result.map((r) => r.factId);
    expect(factIds).toContain("a");
    expect(factIds).toContain("b");
    expect(factIds).toContain("c");
    expect(factIds).toContain("d");
  });
});

// ---------------------------------------------------------------------------
// expandGraph — various link types
// ---------------------------------------------------------------------------

describe("expandGraph: various link types", () => {
  it.each([
    "RELATED_TO",
    "PART_OF",
    "CAUSED_BY",
    "DEPENDS_ON",
    "CONTRADICTS",
    "INSTANCE_OF",
    "DERIVED_FROM",
    "SUPERSEDES",
  ])("traverses %s links", (linkType) => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb(
      [a, b],
      { a: [{ id: "l1", targetFactId: "b", linkType, strength: 1.0 }] },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 1 });
    const bResult = result.find((r) => r.factId === "b");
    expect(bResult).toBeDefined();
    expect(bResult?.linkPath[0].linkType).toBe(linkType);
  });
});

// ---------------------------------------------------------------------------
// expandGraph — missing DB entries
// ---------------------------------------------------------------------------

describe("expandGraph: missing DB entries", () => {
  it("skips expanded facts that cannot be resolved in DB", () => {
    const a = makeEntry("a");
    // Link to "b" but "b" is not in DB
    const db = buildMockDb(
      [a],
      { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }] },
      {},
    );
    const result = expandGraph(db, [{ factId: "a", score: 1.0, entry: a }], { maxDepth: 1 });
    expect(result).toHaveLength(1); // only the seed
    expect(result[0].factId).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// formatLinkPath
// ---------------------------------------------------------------------------

describe("formatLinkPath", () => {
  it("returns empty string for empty path", () => {
    expect(formatLinkPath([])).toBe("");
  });

  it("formats a single step with truncated factId", () => {
    const path = [
      { fromFactId: "abcd1234-efgh-5678", toFactId: "x", linkType: "RELATED_TO", strength: 0.9 },
    ];
    const result = formatLinkPath(path);
    expect(result).toContain("RELATED_TO");
    expect(result).toContain("abcd1234");
    expect(result).toContain("…");
  });

  it("formats multiple steps with arrows", () => {
    const path = [
      { fromFactId: "aaa", toFactId: "bbb", linkType: "PART_OF", strength: 1.0 },
      { fromFactId: "bbb", toFactId: "ccc", linkType: "CAUSED_BY", strength: 0.8 },
    ];
    const result = formatLinkPath(path);
    expect(result).toContain("PART_OF");
    expect(result).toContain("CAUSED_BY");
    expect(result).toContain("→");
  });
});

// ---------------------------------------------------------------------------
// Integration: FactsDB + expandGraph
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "graph-retrieval-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function storeFact(text: string, entity: string | null = null) {
  return db.store({
    text,
    entity,
    key: null,
    value: null,
    category: "fact",
    importance: 0.7,
    source: "test",
  });
}

describe("Integration: expandGraph with real FactsDB", () => {
  it("traverses real RELATED_TO links created in DB", () => {
    const factA = storeFact("Fact A about server");
    const factB = storeFact("Fact B about database");
    db.createLink(factA.id, factB.id, "RELATED_TO", 0.9);

    const aEntry = db.getById(factA.id)!;
    const result = expandGraph(db, [{ factId: factA.id, score: 1.0, entry: aEntry }], {
      maxDepth: 1,
    });

    expect(result).toHaveLength(2);
    const bResult = result.find((r) => r.factId === factB.id);
    expect(bResult).toBeDefined();
    expect(bResult!.expansionSource).toBe("graph");
    expect(bResult!.hopCount).toBe(1);
    expect(bResult!.linkPath[0].linkType).toBe("RELATED_TO");
  });

  it("traverses 2-hop chain in real DB", () => {
    const factA = storeFact("Alpha");
    const factB = storeFact("Beta");
    const factC = storeFact("Gamma");
    db.createLink(factA.id, factB.id, "PART_OF", 1.0);
    db.createLink(factB.id, factC.id, "CAUSED_BY", 1.0);

    const aEntry = db.getById(factA.id)!;
    const result = expandGraph(db, [{ factId: factA.id, score: 0.8, entry: aEntry }], {
      maxDepth: 2,
    });

    const cResult = result.find((r) => r.factId === factC.id);
    expect(cResult).toBeDefined();
    expect(cResult!.hopCount).toBe(2);
    expect(cResult!.score).toBeCloseTo(0.8 * HOP_SCORE_DECAY[2], 5);
  });

  it("depth=1 does not reach fact 2 hops away in real DB", () => {
    const factA = storeFact("A");
    const factB = storeFact("B");
    const factC = storeFact("C");
    db.createLink(factA.id, factB.id, "RELATED_TO", 1.0);
    db.createLink(factB.id, factC.id, "RELATED_TO", 1.0);

    const aEntry = db.getById(factA.id)!;
    const result = expandGraph(db, [{ factId: factA.id, score: 1.0, entry: aEntry }], {
      maxDepth: 1,
    });

    expect(result.map((r) => r.factId)).not.toContain(factC.id);
  });

  it("backward compatible: maxDepth=0 returns only seed, no graph expansion", () => {
    const factA = storeFact("A");
    const factB = storeFact("B");
    db.createLink(factA.id, factB.id, "RELATED_TO", 1.0);

    const aEntry = db.getById(factA.id)!;
    const result = expandGraph(db, [{ factId: factA.id, score: 1.0, entry: aEntry }], {
      maxDepth: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0].factId).toBe(factA.id);
  });

  it("deduplicates correctly when multiple paths to same fact in real DB", () => {
    const factA = storeFact("A");
    const factB = storeFact("B");
    const factC = storeFact("C");
    // a→c (1-hop) and a→b→c (2-hop) — both paths to C
    db.createLink(factA.id, factC.id, "RELATED_TO", 1.0);
    db.createLink(factA.id, factB.id, "PART_OF", 1.0);
    db.createLink(factB.id, factC.id, "DEPENDS_ON", 1.0);

    const aEntry = db.getById(factA.id)!;
    const result = expandGraph(db, [{ factId: factA.id, score: 1.0, entry: aEntry }], {
      maxDepth: 2,
    });

    const cResults = result.filter((r) => r.factId === factC.id);
    expect(cResults).toHaveLength(1);
    expect(cResults[0].hopCount).toBe(1); // shortest path preferred
  });

  it("incoming links are traversed bidirectionally in real DB", () => {
    const factA = storeFact("Target");
    const factB = storeFact("Source that points to target");
    // B→A (incoming to A)
    db.createLink(factB.id, factA.id, "DERIVED_FROM", 0.8);

    const aEntry = db.getById(factA.id)!;
    const result = expandGraph(db, [{ factId: factA.id, score: 1.0, entry: aEntry }], {
      maxDepth: 1,
    });

    const bResult = result.find((r) => r.factId === factB.id);
    expect(bResult).toBeDefined();
    expect(bResult!.expansionSource).toBe("graph");
  });
});
