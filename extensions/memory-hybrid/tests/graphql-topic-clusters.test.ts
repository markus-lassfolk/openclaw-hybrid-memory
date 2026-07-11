/**
 * topicClusters query: exposes labeled, scope-filtered link-graph clusters so the SPA can name
 * its hulls. Scope filtering happens inside detectClusters (per-member getById) — a fact outside
 * the caller's scope must never surface in any cluster's factIds.
 */
import { describe, expect, it } from "vitest";
import { resolvers } from "../routes/graphql-resolvers.js";
import type { MemoryEntry, ScopeFilter } from "../types/memory.js";

type ResolverContext = Parameters<typeof resolvers.Query.topicClusters>[2];
type ClusterResult = { id: string; label: string; factCount: number; factIds: string[] };

function fact(id: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    text: `${id} text about kubernetes deployments`,
    category: "fact",
    decayClass: "durable",
    importance: 0.5,
    confidence: 0.9,
    scope: "global",
    scopeTarget: null,
    createdAt: 1000,
    tags: ["kubernetes"],
    entity: "kubernetes",
    ...over,
  } as MemoryEntry;
}

/** factsDb mock satisfying ClusterFactLookup; `hiddenIds` simulates out-of-scope facts. */
function makeContext(links: Array<[string, string]>, hiddenIds: string[] = []): ResolverContext {
  const ids = [...new Set(links.flat())];
  return {
    factsDb: {
      getAllLinkedFactIds: () => ids,
      getAllLinks: () => links.map(([sourceFactId, targetFactId]) => ({ sourceFactId, targetFactId })),
      getById: (id: string, _opts?: { scopeFilter?: ScopeFilter }) => (hiddenIds.includes(id) ? null : fact(id)),
    },
    pluginContext: {},
    scopeFilter: {},
  } as unknown as ResolverContext;
}

describe("GraphQL Query.topicClusters", () => {
  it("returns labeled clusters of size >= minSize", () => {
    // Component 1: a-b-c (size 3). Component 2: x-y (size 2, below default minSize).
    const context = makeContext([
      ["a", "b"],
      ["b", "c"],
      ["x", "y"],
    ]);

    const result = resolvers.Query.topicClusters(null, {}, context) as ClusterResult[];

    expect(result).toHaveLength(1);
    expect(result[0]?.factIds.sort()).toEqual(["a", "b", "c"]);
    expect(result[0]?.factCount).toBe(3);
    expect(result[0]?.label).toBeTruthy();
  });

  it("honors a smaller minSize", () => {
    const context = makeContext([["x", "y"]]);
    const result = resolvers.Query.topicClusters(null, { minSize: 2 }, context) as ClusterResult[];
    expect(result).toHaveLength(1);
    expect(result[0]?.factIds.sort()).toEqual(["x", "y"]);
  });

  it("never surfaces out-of-scope fact ids in any cluster", () => {
    // b is hidden: the a-b-c chain breaks apart, so no cluster of size 3 can survive, and b's id
    // must not appear anywhere.
    const context = makeContext(
      [
        ["a", "b"],
        ["b", "c"],
      ],
      ["b"],
    );

    const result = resolvers.Query.topicClusters(null, { minSize: 2 }, context) as ClusterResult[];

    for (const cluster of result) {
      expect(cluster.factIds).not.toContain("b");
    }
  });
});
