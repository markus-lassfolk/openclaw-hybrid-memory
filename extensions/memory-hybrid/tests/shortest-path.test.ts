/**
 * Tests for Issue #140 — Shortest-Path Traversal: memory_path BFS.
 *
 * Coverage:
 *   - findShortestPath: same start and end returns 0-hop path
 *   - findShortestPath: start fact not found returns null
 *   - findShortestPath: end fact not found returns null
 *   - findShortestPath: no links returns null
 *   - findShortestPath: direct edge (1 hop) via outgoing link
 *   - findShortestPath: direct edge (1 hop) via incoming link (bidirectional)
 *   - findShortestPath: 2-hop path (A→B→C)
 *   - findShortestPath: 3-hop path (A→B→C→D)
 *   - findShortestPath: 4-hop path found with bidirectional BFS
 *   - findShortestPath: maxDepth=1 blocks 2-hop path
 *   - findShortestPath: maxDepth=2 blocks 3-hop path
 *   - findShortestPath: maxDepth=0 returns null even for direct neighbors
 *   - findShortestPath: shortest path chosen when multiple paths exist
 *   - findShortestPath: chain contains correct MemoryEntry objects
 *   - findShortestPath: steps contain correct link types
 *   - findShortestPath: steps contain correct strength values
 *   - findShortestPath: hops count equals steps.length
 *   - findShortestPath: disconnected graph returns null
 *   - findShortestPath: various link types traversed
 *   - findShortestPath: integration with real FactsDB
 *   - resolveInput: returns fact ID when input matches getById
 *   - resolveInput: returns null for unknown ID without lookup
 *   - resolveInput: resolves entity name via db.lookup
 *   - resolveInput: returns null when entity not found
 *   - resolveInput: empty/whitespace input returns null
 *   - formatPath: empty steps returns "(same fact)"
 *   - formatPath: single step formatted correctly
 *   - formatPath: multi-step path formatted correctly
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import type { ShortestPathLookup } from "../services/shortest-path.js";
import type { MemoryEntry } from "../types/memory.js";

const { findShortestPath, resolveInput, formatPath, FactsDB } = _testing;

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

type MockLink = { id: string; targetFactId: string; linkType: string; strength: number };
type MockInLink = { id: string; sourceFactId: string; linkType: string; strength: number };

function buildMockDb(
  entries: MemoryEntry[],
  linksFrom: Record<string, MockLink[]>,
  linksTo: Record<string, MockInLink[]>,
  lookupMap?: Record<string, MemoryEntry[]>,
): ShortestPathLookup {
  const entryMap = new Map(entries.map((e) => [e.id, e]));
  return {
    getById: (id: string) => entryMap.get(id) ?? null,
    getLinksFrom: (id: string) => linksFrom[id] ?? [],
    getLinksTo: (id: string) => linksTo[id] ?? [],
    lookup: lookupMap
      ? (entity: string) => (lookupMap[entity] ?? []).map((e) => ({ entry: e, score: 1.0 }))
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// findShortestPath — trivial cases
// ---------------------------------------------------------------------------

describe("findShortestPath: trivial cases", () => {
  it("returns 0-hop path when start equals end", () => {
    const a = makeEntry("a");
    const db = buildMockDb([a], {}, {});
    const result = findShortestPath(db, "a", "a");
    expect(result).not.toBeNull();
    expect(result?.hops).toBe(0);
    expect(result?.steps).toHaveLength(0);
    expect(result?.fromFactId).toBe("a");
    expect(result?.toFactId).toBe("a");
    expect(result?.chain).toHaveLength(1);
    expect(result?.chain[0].id).toBe("a");
  });

  it("returns null when start fact not found", () => {
    const b = makeEntry("b");
    const db = buildMockDb([b], {}, {});
    const result = findShortestPath(db, "nonexistent", "b");
    expect(result).toBeNull();
  });

  it("returns null when end fact not found", () => {
    const a = makeEntry("a");
    const db = buildMockDb([a], {}, {});
    const result = findShortestPath(db, "a", "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when both nodes exist but no links between them", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb([a, b], {}, {});
    const result = findShortestPath(db, "a", "b");
    expect(result).toBeNull();
  });

  it("returns null for disconnected graph with links to other nodes", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const d = makeEntry("d");
    // a-b connected, c-d connected, no cross links
    const db = buildMockDb(
      [a, b, c, d],
      { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }] },
      {
        b: [{ id: "l1", sourceFactId: "a", linkType: "RELATED_TO", strength: 1.0 }],
        d: [{ id: "l2", sourceFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
      },
    );
    const result = findShortestPath(db, "a", "d");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findShortestPath — 1-hop paths
// ---------------------------------------------------------------------------

describe("findShortestPath: 1-hop paths", () => {
  it("finds direct path via outgoing edge (A→B)", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb([a, b], { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 0.9 }] }, {});
    const result = findShortestPath(db, "a", "b");
    expect(result).not.toBeNull();
    expect(result?.hops).toBe(1);
    expect(result?.steps).toHaveLength(1);
    expect(result?.steps[0].fromFactId).toBe("a");
    expect(result?.steps[0].toFactId).toBe("b");
    expect(result?.steps[0].linkType).toBe("RELATED_TO");
    expect(result?.steps[0].strength).toBeCloseTo(0.9);
  });

  it("finds direct path via incoming edge (B→A traversed as A←B)", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    // A has an incoming link from B (B is source, A is target)
    const db = buildMockDb([a, b], {}, { a: [{ id: "l1", sourceFactId: "b", linkType: "CAUSED_BY", strength: 0.8 }] });
    // Path from b to a: b→a via the link (b is source, a is target)
    const result = findShortestPath(db, "b", "a");
    expect(result).not.toBeNull();
    expect(result?.hops).toBe(1);
    expect(result?.steps[0].linkType).toBe("CAUSED_BY");
  });

  it("returns correct chain for 1-hop path", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb([a, b], { a: [{ id: "l1", targetFactId: "b", linkType: "PART_OF", strength: 1.0 }] }, {});
    const result = findShortestPath(db, "a", "b");
    expect(result?.chain).toHaveLength(2);
    expect(result?.chain[0].id).toBe("a");
    expect(result?.chain[1].id).toBe("b");
  });

  it("hops equals steps.length", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb([a, b], { a: [{ id: "l1", targetFactId: "b", linkType: "DEPENDS_ON", strength: 0.5 }] }, {});
    const result = findShortestPath(db, "a", "b");
    expect(result?.hops).toBe(result?.steps.length);
  });
});

// ---------------------------------------------------------------------------
// findShortestPath — multi-hop paths
// ---------------------------------------------------------------------------

describe("findShortestPath: multi-hop paths", () => {
  it("finds 2-hop path A→B→C", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const db = buildMockDb(
      [a, b, c],
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "PART_OF", strength: 0.7 }],
      },
      {},
    );
    const result = findShortestPath(db, "a", "c");
    expect(result).not.toBeNull();
    expect(result?.hops).toBe(2);
    expect(result?.steps[0].fromFactId).toBe("a");
    expect(result?.steps[0].toFactId).toBe("b");
    expect(result?.steps[1].fromFactId).toBe("b");
    expect(result?.steps[1].toFactId).toBe("c");
  });

  it("finds 3-hop path A→B→C→D", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const d = makeEntry("d");
    const db = buildMockDb(
      [a, b, c, d],
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "CAUSED_BY", strength: 1.0 }],
        c: [{ id: "l3", targetFactId: "d", linkType: "PART_OF", strength: 1.0 }],
      },
      {},
    );
    const result = findShortestPath(db, "a", "d", { maxDepth: 5 });
    expect(result).not.toBeNull();
    expect(result?.hops).toBe(3);
  });

  it("finds 4-hop path with bidirectional BFS", () => {
    // A→B→C→D→E; bidirectional BFS meets at C:
    //   fwd (hop1): a→b; fwd (hop3): b→c
    //   bwd (hop2): e←d; bwd (hop4): d←c → c is in fwd!
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((id) => makeEntry(id));
    const db = buildMockDb(
      [a, b, c, d, e],
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
        c: [{ id: "l3", targetFactId: "d", linkType: "RELATED_TO", strength: 1.0 }],
        d: [{ id: "l4", targetFactId: "e", linkType: "RELATED_TO", strength: 1.0 }],
      },
      {
        b: [{ id: "l1", sourceFactId: "a", linkType: "RELATED_TO", strength: 1.0 }],
        c: [{ id: "l2", sourceFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        d: [{ id: "l3", sourceFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
        e: [{ id: "l4", sourceFactId: "d", linkType: "RELATED_TO", strength: 1.0 }],
      },
    );
    const result = findShortestPath(db, "a", "e", { maxDepth: 5 });
    expect(result).not.toBeNull();
    expect(result?.hops).toBe(4);
    expect(result?.fromFactId).toBe("a");
    expect(result?.toFactId).toBe("e");
  });

  it("fromFactId and toFactId are preserved in result", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb([a, b], { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }] }, {});
    const result = findShortestPath(db, "a", "b");
    expect(result?.fromFactId).toBe("a");
    expect(result?.toFactId).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// findShortestPath — maxDepth limits
// ---------------------------------------------------------------------------

describe("findShortestPath: maxDepth enforcement", () => {
  it("maxDepth=0 returns null even for nodes that are neighbors", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb([a, b], { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }] }, {});
    const result = findShortestPath(db, "a", "b", { maxDepth: 0 });
    expect(result).toBeNull();
  });

  it("maxDepth=1 finds 1-hop path", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb([a, b], { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }] }, {});
    const result = findShortestPath(db, "a", "b", { maxDepth: 1 });
    expect(result).not.toBeNull();
    expect(result?.hops).toBe(1);
  });

  it("maxDepth=1 blocks 2-hop path", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const db = buildMockDb(
      [a, b, c],
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
      },
      {},
    );
    const result = findShortestPath(db, "a", "c", { maxDepth: 1 });
    expect(result).toBeNull();
  });

  it("maxDepth=2 blocks 3-hop path", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => makeEntry(id));
    const db = buildMockDb(
      [a, b, c, d],
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
        c: [{ id: "l3", targetFactId: "d", linkType: "RELATED_TO", strength: 1.0 }],
      },
      {},
    );
    const result = findShortestPath(db, "a", "d", { maxDepth: 2 });
    expect(result).toBeNull();
  });

  it("maxDepth=3 finds 3-hop path", () => {
    // A→B→C→D; bidirectional BFS meets at C:
    //   fwd (hop1): a→b; fwd (hop3): b→c → c is in bwd!
    //   bwd (hop2): d←c; bwd.get(c)=[c→d]
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => makeEntry(id));
    const db = buildMockDb(
      [a, b, c, d],
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
        c: [{ id: "l3", targetFactId: "d", linkType: "RELATED_TO", strength: 1.0 }],
      },
      {
        b: [{ id: "l1", sourceFactId: "a", linkType: "RELATED_TO", strength: 1.0 }],
        c: [{ id: "l2", sourceFactId: "b", linkType: "RELATED_TO", strength: 1.0 }],
        d: [{ id: "l3", sourceFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
      },
    );
    const result = findShortestPath(db, "a", "d", { maxDepth: 3 });
    expect(result).not.toBeNull();
    expect(result?.hops).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// findShortestPath — shortest path selection
// ---------------------------------------------------------------------------

describe("findShortestPath: shortest path selection", () => {
  it("returns 1-hop direct path even when longer alternative exists", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    // a→b directly, and a→c→b (2 hops)
    const db = buildMockDb(
      [a, b, c],
      {
        a: [
          { id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 1.0 },
          { id: "l2", targetFactId: "c", linkType: "PART_OF", strength: 0.5 },
        ],
        c: [{ id: "l3", targetFactId: "b", linkType: "CAUSED_BY", strength: 0.3 }],
      },
      {},
    );
    const result = findShortestPath(db, "a", "b");
    expect(result?.hops).toBe(1);
    expect(result?.steps[0].fromFactId).toBe("a");
    expect(result?.steps[0].toFactId).toBe("b");
  });

  it("finds 2-hop path when 1-hop is unavailable", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const db = buildMockDb(
      [a, b, c],
      {
        a: [{ id: "l1", targetFactId: "c", linkType: "RELATED_TO", strength: 1.0 }],
        c: [{ id: "l2", targetFactId: "b", linkType: "PART_OF", strength: 1.0 }],
      },
      {},
    );
    const result = findShortestPath(db, "a", "b");
    expect(result?.hops).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// findShortestPath — link types and strengths
// ---------------------------------------------------------------------------

describe("findShortestPath: link types and strengths", () => {
  it("traverses SUPERSEDES links", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb([a, b], { a: [{ id: "l1", targetFactId: "b", linkType: "SUPERSEDES", strength: 1.0 }] }, {});
    const result = findShortestPath(db, "a", "b");
    expect(result?.steps[0].linkType).toBe("SUPERSEDES");
  });

  it("traverses INSTANCE_OF and DERIVED_FROM links", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const c = makeEntry("c");
    const db = buildMockDb(
      [a, b, c],
      {
        a: [{ id: "l1", targetFactId: "b", linkType: "INSTANCE_OF", strength: 0.9 }],
        b: [{ id: "l2", targetFactId: "c", linkType: "DERIVED_FROM", strength: 0.8 }],
      },
      {},
    );
    const result = findShortestPath(db, "a", "c");
    expect(result?.steps[0].linkType).toBe("INSTANCE_OF");
    expect(result?.steps[1].linkType).toBe("DERIVED_FROM");
  });

  it("preserves edge strength in steps", () => {
    const a = makeEntry("a");
    const b = makeEntry("b");
    const db = buildMockDb(
      [a, b],
      { a: [{ id: "l1", targetFactId: "b", linkType: "RELATED_TO", strength: 0.42 }] },
      {},
    );
    const result = findShortestPath(db, "a", "b");
    expect(result?.steps[0].strength).toBeCloseTo(0.42);
  });
});

// ---------------------------------------------------------------------------
// resolveInput
// ---------------------------------------------------------------------------

describe("resolveInput", () => {
  it("returns fact ID when input directly matches getById", () => {
    const a = makeEntry("fact-abc-123");
    const db = buildMockDb([a], {}, {});
    expect(resolveInput(db, "fact-abc-123")).toBe("fact-abc-123");
  });

  it("returns null for unknown ID when no lookup is provided", () => {
    const db = buildMockDb([], {}, {});
    expect(resolveInput(db, "unknown-id")).toBeNull();
  });

  it("resolves entity name via db.lookup", () => {
    const a = makeEntry("entity-fact-id");
    const db = buildMockDb([a], {}, {}, { myEntity: [a] });
    expect(resolveInput(db, "myEntity")).toBe("entity-fact-id");
  });

  it("returns null when entity name not found via lookup", () => {
    const db = buildMockDb([], {}, {}, { other: [] });
    expect(resolveInput(db, "unknown-entity")).toBeNull();
  });

  it("returns null for empty string", () => {
    const db = buildMockDb([], {}, {});
    expect(resolveInput(db, "")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    const db = buildMockDb([], {}, {});
    expect(resolveInput(db, "   ")).toBeNull();
  });

  it("prefers fact ID over entity name when ID exists", () => {
    const a = makeEntry("real-id");
    const b = makeEntry("entity-id");
    const db = buildMockDb([a, b], {}, {}, { "real-id": [b] });
    // "real-id" matches getById directly → returns "real-id", not "entity-id"
    expect(resolveInput(db, "real-id")).toBe("real-id");
  });
});

// ---------------------------------------------------------------------------
// formatPath
// ---------------------------------------------------------------------------

describe("formatPath", () => {
  it("returns (same fact) for empty steps", () => {
    expect(formatPath([])).toBe("(same fact)");
  });

  it("formats single step correctly", () => {
    const steps = [{ fromFactId: "abcdef12", toFactId: "12345678", linkType: "RELATED_TO", strength: 1.0 }];
    const out = formatPath(steps);
    expect(out).toContain("abcdef12");
    expect(out).toContain("RELATED_TO");
    expect(out).toContain("12345678");
  });

  it("formats multi-step path with all nodes", () => {
    const steps = [
      { fromFactId: "aaa", toFactId: "bbb", linkType: "PART_OF", strength: 1.0 },
      { fromFactId: "bbb", toFactId: "ccc", linkType: "CAUSED_BY", strength: 0.5 },
    ];
    const out = formatPath(steps);
    expect(out).toContain("aaa");
    expect(out).toContain("PART_OF");
    expect(out).toContain("bbb");
    expect(out).toContain("CAUSED_BY");
    expect(out).toContain("ccc");
  });
});

// ---------------------------------------------------------------------------
// Integration with real FactsDB
// ---------------------------------------------------------------------------

describe("findShortestPath: integration with FactsDB", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "shortest-path-test-"));
    factsDb = new FactsDB(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds direct path in real DB", () => {
    const aId = factsDb.store({
      text: "Fact A",
      category: "fact",
      importance: 0.7,
      source: "test",
      entity: null,
      key: null,
      value: null,
    }).id;
    const bId = factsDb.store({
      text: "Fact B",
      category: "fact",
      importance: 0.7,
      source: "test",
      entity: null,
      key: null,
      value: null,
    }).id;
    factsDb.createLink(aId, bId, "RELATED_TO", 1.0);

    const result = findShortestPath(factsDb, aId, bId, { maxDepth: 5 });
    expect(result).not.toBeNull();
    expect(result?.hops).toBe(1);
    expect(result?.steps[0].linkType).toBe("RELATED_TO");
  });

  it("finds 2-hop path in real DB", () => {
    const aId = factsDb.store({
      text: "Fact A",
      category: "fact",
      importance: 0.7,
      source: "test",
      entity: null,
      key: null,
      value: null,
    }).id;
    const bId = factsDb.store({
      text: "Fact B",
      category: "fact",
      importance: 0.7,
      source: "test",
      entity: null,
      key: null,
      value: null,
    }).id;
    const cId = factsDb.store({
      text: "Fact C",
      category: "fact",
      importance: 0.7,
      source: "test",
      entity: null,
      key: null,
      value: null,
    }).id;
    factsDb.createLink(aId, bId, "PART_OF", 1.0);
    factsDb.createLink(bId, cId, "CAUSED_BY", 0.8);

    const result = findShortestPath(factsDb, aId, cId, { maxDepth: 5 });
    expect(result).not.toBeNull();
    expect(result?.hops).toBe(2);
  });

  it("returns null when no path in real DB", () => {
    const aId = factsDb.store({
      text: "Fact A",
      category: "fact",
      importance: 0.7,
      source: "test",
      entity: null,
      key: null,
      value: null,
    }).id;
    const bId = factsDb.store({
      text: "Fact B",
      category: "fact",
      importance: 0.7,
      source: "test",
      entity: null,
      key: null,
      value: null,
    }).id;

    const result = findShortestPath(factsDb, aId, bId, { maxDepth: 5 });
    expect(result).toBeNull();
  });

  it("chain contains correct MemoryEntry objects in real DB", () => {
    const aId = factsDb.store({
      text: "Fact A",
      category: "fact",
      importance: 0.7,
      source: "test",
      entity: null,
      key: null,
      value: null,
    }).id;
    const bId = factsDb.store({
      text: "Fact B",
      category: "fact",
      importance: 0.7,
      source: "test",
      entity: null,
      key: null,
      value: null,
    }).id;
    factsDb.createLink(aId, bId, "RELATED_TO", 1.0);

    const result = findShortestPath(factsDb, aId, bId, { maxDepth: 5 });
    expect(result?.chain).toHaveLength(2);
    expect(result?.chain[0].text).toBe("Fact A");
    expect(result?.chain[1].text).toBe("Fact B");
  });
});
