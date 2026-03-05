/**
 * Tests for Issue #146 — Topic Cluster Detection.
 *
 * Coverage:
 *   - detectClusters: empty graph returns no clusters
 *   - detectClusters: single isolated fact returns no cluster
 *   - detectClusters: pair below minClusterSize → isolated
 *   - detectClusters: triangle of 3 linked facts forms one cluster
 *   - detectClusters: minClusterSize=2 includes pairs
 *   - detectClusters: two disconnected components form two separate clusters
 *   - detectClusters: large connected component identified correctly
 *   - detectClusters: BFS reaches transitive connections
 *   - detectClusters: bidirectional traversal (incoming + outgoing edges)
 *   - detectClusters: cluster factIds are sorted for stability
 *   - detectClusters: clusters sorted by size desc
 *   - detectClusters: isolatedFacts count matches below-threshold components
 *   - detectClusters: totalLinkedFacts reports all linked facts
 *   - detectClusters: existingClusterIds reuses stable IDs
 *   - detectClusters: cluster-aware retrieval boosting (factIds usable for filtering)
 *   - generateClusterLabel: uses most common entity
 *   - generateClusterLabel: falls back to most common tag when no entity
 *   - generateClusterLabel: falls back to category when no entity/tag
 *   - generateClusterLabel: returns generic label for empty entries
 *   - generateClusterLabel: limits label to 3 words max
 *   - Integration: FactsDB.getAllLinkedFactIds returns correct IDs
 *   - Integration: FactsDB.getAllLinks returns all edges
 *   - Integration: FactsDB.saveClusters persists and getClusters retrieves
 *   - Integration: FactsDB.getClusterMembers returns member IDs
 *   - Integration: FactsDB.getFactClusterId resolves cluster for a fact
 *   - Integration: saveClusters replaces existing data atomically
 *   - Integration: detectClusters + saveClusters round-trip on real DB
 *   - Integration: incremental re-cluster reuses cluster IDs when components unchanged
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";
import type { MemoryEntry } from "../types/memory.js";
import type { ClusterFactLookup, TopicCluster } from "../services/topic-clusters.js";

const { detectClusters, generateClusterLabel, FactsDB } = _testing;

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

/** Build a minimal ClusterFactLookup mock. */
function buildMockDb(
  entries: MemoryEntry[],
  edges: Array<{ sourceFactId: string; targetFactId: string }>,
): ClusterFactLookup {
  const entryMap = new Map(entries.map((e) => [e.id, e]));
  const linkedIds = new Set<string>();
  for (const { sourceFactId, targetFactId } of edges) {
    linkedIds.add(sourceFactId);
    linkedIds.add(targetFactId);
  }
  return {
    getAllLinkedFactIds: () => [...linkedIds],
    getAllLinks: () => edges,
    getById: (id: string) => entryMap.get(id) ?? null,
  };
}

// ---------------------------------------------------------------------------
// detectClusters — empty and trivial cases
// ---------------------------------------------------------------------------

describe("detectClusters: empty/trivial cases", () => {
  it("returns no clusters when graph has no linked facts", () => {
    const db = buildMockDb([], []);
    const result = detectClusters(db);
    expect(result.clusters).toHaveLength(0);
    expect(result.isolatedFacts).toBe(0);
    expect(result.totalLinkedFacts).toBe(0);
  });

  it("returns no cluster for a single isolated fact (no links)", () => {
    // No edges → no linked IDs → nothing to cluster
    const db = buildMockDb([makeEntry("a")], []);
    const result = detectClusters(db);
    expect(result.clusters).toHaveLength(0);
    expect(result.totalLinkedFacts).toBe(0);
  });

  it("pair of linked facts (size 2) is below default minClusterSize=3 → isolated", () => {
    const db = buildMockDb(
      [makeEntry("a"), makeEntry("b")],
      [{ sourceFactId: "a", targetFactId: "b" }],
    );
    const result = detectClusters(db, { minClusterSize: 3 });
    expect(result.clusters).toHaveLength(0);
    expect(result.isolatedFacts).toBe(2);
    expect(result.totalLinkedFacts).toBe(2);
  });

  it("pair of linked facts forms a cluster when minClusterSize=2", () => {
    const db = buildMockDb(
      [makeEntry("a"), makeEntry("b")],
      [{ sourceFactId: "a", targetFactId: "b" }],
    );
    const result = detectClusters(db, { minClusterSize: 2 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].factCount).toBe(2);
    expect(result.isolatedFacts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectClusters — component detection
// ---------------------------------------------------------------------------

describe("detectClusters: component detection", () => {
  it("triangle of 3 linked facts forms one cluster (default minClusterSize=3)", () => {
    const db = buildMockDb(
      [makeEntry("a"), makeEntry("b"), makeEntry("c")],
      [
        { sourceFactId: "a", targetFactId: "b" },
        { sourceFactId: "b", targetFactId: "c" },
        { sourceFactId: "a", targetFactId: "c" },
      ],
    );
    const result = detectClusters(db);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].factCount).toBe(3);
    expect(result.clusters[0].factIds).toEqual(["a", "b", "c"]);
  });

  it("two disconnected components form two separate clusters", () => {
    const db = buildMockDb(
      ["a", "b", "c", "d", "e", "f"].map((id) => makeEntry(id)),
      [
        { sourceFactId: "a", targetFactId: "b" },
        { sourceFactId: "b", targetFactId: "c" },
        { sourceFactId: "d", targetFactId: "e" },
        { sourceFactId: "e", targetFactId: "f" },
      ],
    );
    const result = detectClusters(db, { minClusterSize: 3 });
    expect(result.clusters).toHaveLength(2);
    const sizes = result.clusters.map((c) => c.factCount).sort((a, b) => b - a);
    expect(sizes).toEqual([3, 3]);
  });

  it("BFS reaches transitive connections (chain a→b→c→d)", () => {
    const db = buildMockDb(
      ["a", "b", "c", "d"].map((id) => makeEntry(id)),
      [
        { sourceFactId: "a", targetFactId: "b" },
        { sourceFactId: "b", targetFactId: "c" },
        { sourceFactId: "c", targetFactId: "d" },
      ],
    );
    const result = detectClusters(db, { minClusterSize: 4 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].factIds).toEqual(["a", "b", "c", "d"]);
  });

  it("bidirectional traversal: incoming edge expands the component", () => {
    // Only b→a edge exists; starting from "a" we should still find "b"
    const db = buildMockDb(
      ["a", "b", "c"].map((id) => makeEntry(id)),
      [
        { sourceFactId: "b", targetFactId: "a" }, // incoming to a
        { sourceFactId: "a", targetFactId: "c" }, // outgoing from a
      ],
    );
    const result = detectClusters(db, { minClusterSize: 3 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].factCount).toBe(3);
  });

  it("multiple components where some are below threshold (mixed)", () => {
    // Component 1: a-b-c (size 3) — above threshold
    // Component 2: d-e   (size 2) — below threshold → isolated
    const db = buildMockDb(
      ["a", "b", "c", "d", "e"].map((id) => makeEntry(id)),
      [
        { sourceFactId: "a", targetFactId: "b" },
        { sourceFactId: "b", targetFactId: "c" },
        { sourceFactId: "d", targetFactId: "e" },
      ],
    );
    const result = detectClusters(db, { minClusterSize: 3 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].factCount).toBe(3);
    expect(result.isolatedFacts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// detectClusters — cluster properties
// ---------------------------------------------------------------------------

describe("detectClusters: cluster properties", () => {
  it("cluster factIds are sorted lexicographically for stability", () => {
    const db = buildMockDb(
      ["c", "a", "b"].map((id) => makeEntry(id)),
      [
        { sourceFactId: "c", targetFactId: "a" },
        { sourceFactId: "a", targetFactId: "b" },
      ],
    );
    const result = detectClusters(db, { minClusterSize: 3 });
    expect(result.clusters[0].factIds).toEqual(["a", "b", "c"]);
  });

  it("clusters are sorted by size descending (largest first)", () => {
    const db = buildMockDb(
      ["a", "b", "c", "d", "e", "f", "g"].map((id) => makeEntry(id)),
      [
        { sourceFactId: "a", targetFactId: "b" },
        { sourceFactId: "b", targetFactId: "c" },
        { sourceFactId: "c", targetFactId: "d" }, // 4-node component
        { sourceFactId: "e", targetFactId: "f" },
        { sourceFactId: "f", targetFactId: "g" }, // 3-node component
      ],
    );
    const result = detectClusters(db, { minClusterSize: 3 });
    expect(result.clusters[0].factCount).toBeGreaterThanOrEqual(result.clusters[1].factCount);
  });

  it("each cluster has a non-empty label", () => {
    const db = buildMockDb(
      ["a", "b", "c"].map((id) => makeEntry(id)),
      [
        { sourceFactId: "a", targetFactId: "b" },
        { sourceFactId: "b", targetFactId: "c" },
      ],
    );
    const result = detectClusters(db, { minClusterSize: 3 });
    expect(result.clusters[0].label.length).toBeGreaterThan(0);
  });

  it("each cluster has a valid UUID id", () => {
    const db = buildMockDb(
      ["a", "b", "c"].map((id) => makeEntry(id)),
      [
        { sourceFactId: "a", targetFactId: "b" },
        { sourceFactId: "b", targetFactId: "c" },
      ],
    );
    const result = detectClusters(db, { minClusterSize: 3 });
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(result.clusters[0].id).toMatch(uuidRegex);
  });

  it("existingClusterIds reuses stable IDs for same component", () => {
    const edges = [
      { sourceFactId: "a", targetFactId: "b" },
      { sourceFactId: "b", targetFactId: "c" },
    ];
    const db = buildMockDb(["a", "b", "c"].map((id) => makeEntry(id)), edges);

    // First run
    const firstResult = detectClusters(db, { minClusterSize: 3 });
    const firstId = firstResult.clusters[0].id;
    const firstCreatedAt = firstResult.clusters[0].createdAt;
    const componentKey = firstResult.clusters[0].factIds.join(",");

    // Second run with existing IDs map
    const existingClusterIds = new Map([[componentKey, { id: firstId, createdAt: firstCreatedAt }]]);
    const secondResult = detectClusters(db, { minClusterSize: 3, existingClusterIds });
    expect(secondResult.clusters[0].id).toBe(firstId);
    expect(secondResult.clusters[0].createdAt).toBe(firstCreatedAt);
  });

  it("totalLinkedFacts counts all unique facts appearing in links", () => {
    const db = buildMockDb(
      ["a", "b", "c", "d"].map((id) => makeEntry(id)),
      [
        { sourceFactId: "a", targetFactId: "b" },
        { sourceFactId: "b", targetFactId: "c" }, // "b" appears twice but counted once
        { sourceFactId: "c", targetFactId: "d" },
      ],
    );
    const result = detectClusters(db, { minClusterSize: 5 });
    expect(result.totalLinkedFacts).toBe(4);
    expect(result.isolatedFacts).toBe(4);
  });

  it("cluster-aware retrieval: factIds can be used to filter/boost search results", () => {
    const db = buildMockDb(
      ["a", "b", "c"].map((id) => makeEntry(id)),
      [
        { sourceFactId: "a", targetFactId: "b" },
        { sourceFactId: "b", targetFactId: "c" },
      ],
    );
    const result = detectClusters(db, { minClusterSize: 3 });
    const clusterFactSet = new Set(result.clusters[0].factIds);
    // Simulate retrieval boost: any result in the cluster gets boosted
    const searchResults = [
      { factId: "a", score: 0.5 },
      { factId: "x", score: 0.9 }, // not in cluster
    ];
    const boosted = searchResults.map((r) =>
      clusterFactSet.has(r.factId) ? { ...r, score: r.score + 0.1 } : r,
    );
    expect(boosted.find((r) => r.factId === "a")!.score).toBeCloseTo(0.6);
    expect(boosted.find((r) => r.factId === "x")!.score).toBeCloseTo(0.9);
  });
});

// ---------------------------------------------------------------------------
// generateClusterLabel
// ---------------------------------------------------------------------------

describe("generateClusterLabel", () => {
  it("returns generic label for empty entries array", () => {
    expect(generateClusterLabel([])).toBe("knowledge cluster");
  });

  it("uses most common entity across cluster members", () => {
    const entries = [
      makeEntry("a", { entity: "PostgreSQL" }),
      makeEntry("b", { entity: "PostgreSQL" }),
      makeEntry("c", { entity: "Redis" }),
    ];
    const label = generateClusterLabel(entries);
    expect(label).toContain("postgresql");
  });

  it("falls back to most common tag when no entity", () => {
    const entries = [
      makeEntry("a", { tags: ["auth", "security"] }),
      makeEntry("b", { tags: ["auth"] }),
      makeEntry("c", { tags: ["logging"] }),
    ];
    const label = generateClusterLabel(entries);
    expect(label).toContain("auth");
  });

  it("falls back to category when no entity or tag", () => {
    const entries = [
      makeEntry("a", { category: "preference" }),
      makeEntry("b", { category: "preference" }),
      makeEntry("c", { category: "fact" }),
    ];
    const label = generateClusterLabel(entries);
    expect(label).toContain("preference");
  });

  it("limits label to 3 words from entity", () => {
    const entries = [makeEntry("a", { entity: "word1_word2_word3_word4" })];
    const label = generateClusterLabel(entries);
    const wordCount = label.split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeLessThanOrEqual(3);
  });

  it("entity label is lowercased", () => {
    const entries = [makeEntry("a", { entity: "MyBigService" })];
    const label = generateClusterLabel(entries);
    expect(label).toBe(label.toLowerCase());
  });

  it("tag label is lowercased", () => {
    const entries = [makeEntry("a", { tags: ["MyTag"] })];
    const label = generateClusterLabel(entries);
    expect(label).toBe(label.toLowerCase());
  });

  it("entity wins over tag when both are present", () => {
    const entries = [
      makeEntry("a", { entity: "serverX", tags: ["tagA", "tagA", "tagA"] }),
    ];
    // entity should take priority
    const label = generateClusterLabel(entries);
    expect(label).toContain("serverx");
  });

  it("picks the most frequent entity (majority wins)", () => {
    const entries = [
      makeEntry("a", { entity: "alpha" }),
      makeEntry("b", { entity: "beta" }),
      makeEntry("c", { entity: "beta" }),
    ];
    const label = generateClusterLabel(entries);
    expect(label).toBe("beta");
  });
});

// ---------------------------------------------------------------------------
// Integration: real FactsDB
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "topic-clusters-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function storeFact(text: string, entity: string | null = null) {
  return db.store({ text, entity, key: null, value: null, category: "fact", importance: 0.7, source: "test" });
}

describe("Integration: FactsDB cluster methods", () => {
  it("getAllLinkedFactIds returns IDs from memory_links", () => {
    const a = storeFact("Alpha");
    const b = storeFact("Beta");
    db.createLink(a.id, b.id, "RELATED_TO", 0.8);

    const ids = db.getAllLinkedFactIds();
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("getAllLinkedFactIds deduplicates IDs that appear in multiple links", () => {
    const a = storeFact("Alpha");
    const b = storeFact("Beta");
    const c = storeFact("Gamma");
    db.createLink(a.id, b.id, "RELATED_TO", 0.8);
    db.createLink(a.id, c.id, "RELATED_TO", 0.7); // "a" appears in two links

    const ids = db.getAllLinkedFactIds();
    const aCount = ids.filter((id) => id === a.id).length;
    expect(aCount).toBe(1); // no duplicates
  });

  it("getAllLinkedFactIds returns empty array when no links", () => {
    storeFact("Isolated");
    const ids = db.getAllLinkedFactIds();
    expect(ids).toHaveLength(0);
  });

  it("getAllLinks returns all edges", () => {
    const a = storeFact("A");
    const b = storeFact("B");
    const c = storeFact("C");
    db.createLink(a.id, b.id, "RELATED_TO", 1.0);
    db.createLink(b.id, c.id, "PART_OF", 0.9);

    const links = db.getAllLinks();
    expect(links).toHaveLength(2);
    const sources = links.map((l) => l.sourceFactId);
    expect(sources).toContain(a.id);
    expect(sources).toContain(b.id);
  });

  it("saveClusters persists and getClusters retrieves", () => {
    const now = Math.floor(Date.now() / 1000);
    const clusters = [
      { id: "cluster-1", label: "test cluster", factIds: ["f1", "f2", "f3"], factCount: 3, createdAt: now, updatedAt: now },
    ];
    db.saveClusters(clusters);

    const retrieved = db.getClusters();
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].id).toBe("cluster-1");
    expect(retrieved[0].label).toBe("test cluster");
    expect(retrieved[0].factCount).toBe(3);
  });

  it("getClusterMembers returns all member fact IDs", () => {
    const now = Math.floor(Date.now() / 1000);
    const clusters = [
      { id: "c1", label: "my cluster", factIds: ["f1", "f2", "f3"], factCount: 3, createdAt: now, updatedAt: now },
    ];
    db.saveClusters(clusters);

    const members = db.getClusterMembers("c1");
    expect(members).toHaveLength(3);
    expect(members).toContain("f1");
    expect(members).toContain("f2");
    expect(members).toContain("f3");
  });

  it("getFactClusterId returns the cluster ID for a member fact", () => {
    const now = Math.floor(Date.now() / 1000);
    db.saveClusters([
      { id: "c1", label: "alpha", factIds: ["f1", "f2", "f3"], factCount: 3, createdAt: now, updatedAt: now },
    ]);
    expect(db.getFactClusterId("f1")).toBe("c1");
    expect(db.getFactClusterId("f99")).toBeNull();
  });

  it("saveClusters replaces all previous clusters atomically", () => {
    const now = Math.floor(Date.now() / 1000);
    db.saveClusters([
      { id: "old-1", label: "old cluster", factIds: ["a", "b", "c"], factCount: 3, createdAt: now, updatedAt: now },
    ]);
    // Save again with completely different clusters
    db.saveClusters([
      { id: "new-1", label: "new cluster", factIds: ["x", "y", "z"], factCount: 3, createdAt: now, updatedAt: now },
    ]);
    const retrieved = db.getClusters();
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].id).toBe("new-1");
  });

  it("detectClusters + saveClusters round-trip on real DB", () => {
    const a = storeFact("Alpha about database");
    const b = storeFact("Beta about database");
    const c = storeFact("Gamma about database");
    db.createLink(a.id, b.id, "RELATED_TO", 0.9);
    db.createLink(b.id, c.id, "RELATED_TO", 0.8);

    const result = detectClusters(db, { minClusterSize: 3 });
    expect(result.clusters).toHaveLength(1);

    db.saveClusters(result.clusters);
    const saved = db.getClusters();
    expect(saved).toHaveLength(1);
    expect(saved[0].factCount).toBe(3);
    const members = db.getClusterMembers(saved[0].id);
    expect(members).toContain(a.id);
    expect(members).toContain(b.id);
    expect(members).toContain(c.id);
  });

  it("incremental re-cluster reuses cluster IDs when components unchanged", () => {
    const a = storeFact("A");
    const b = storeFact("B");
    const c = storeFact("C");
    db.createLink(a.id, b.id, "RELATED_TO", 1.0);
    db.createLink(b.id, c.id, "RELATED_TO", 1.0);

    // First detection
    const first = detectClusters(db, { minClusterSize: 3 });
    const firstId = first.clusters[0].id;
    const firstCreatedAt = first.clusters[0].createdAt;
    const componentKey = first.clusters[0].factIds.join(",");

    // Second detection with stable ID map
    const existingClusterIds = new Map([[componentKey, { id: firstId, createdAt: firstCreatedAt }]]);
    const second = detectClusters(db, { minClusterSize: 3, existingClusterIds });
    expect(second.clusters[0].id).toBe(firstId);
    expect(second.clusters[0].createdAt).toBe(firstCreatedAt);
  });
});
