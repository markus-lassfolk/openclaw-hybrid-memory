/**
 * Regression test (loop iteration 126) for routes/graphql-resolvers.ts's `Query.graph`:
 *
 * `supersedeEdges` was computed from `facts`, which is filtered through `isActiveFact()` --
 * a predicate that *requires* `supersededBy == null`. So no fact reaching the `supersedeEdges`
 * computation could ever have `supersededBy` set, and the "superseded_by" edge type could never
 * appear in a graph query's response, even though the REST/GraphQL graph feature was clearly
 * written to produce it.
 */
import { describe, expect, it, vi } from "vitest";
import { resolvers } from "../routes/graphql-resolvers.js";

type ResolverContext = Parameters<typeof resolvers.Query.graph>[2];
type GraphResult = {
  nodes: Array<{ id: string }>;
  edges: Array<{ source: string; target: string; linkType: string; weight: number }>;
};

function makeFact(overrides: Record<string, unknown>) {
  return {
    id: "fact",
    text: "fact text",
    category: "fact",
    decayClass: "durable",
    importance: 0.5,
    confidence: 0.9,
    scope: "global",
    scopeTarget: null,
    createdAt: 1000,
    expiresAt: null,
    supersededAt: null,
    supersededBy: null,
    tags: [],
    entity: null,
    key: null,
    value: null,
    ...overrides,
  };
}

function makeContext(facts: ReturnType<typeof makeFact>[]): ResolverContext {
  const factsDb = {
    getAll: vi.fn((options?: { includeSuperseded?: boolean }) => {
      const includeSuperseded = options?.includeSuperseded === true;
      return facts.filter((fact) => includeSuperseded || fact.supersededAt == null);
    }),
    getRawDb: vi.fn(() => ({
      prepare: vi.fn(() => ({ all: vi.fn(() => []) })),
    })),
  };
  return {
    factsDb,
    pluginContext: {},
    scopeFilter: {},
  } as unknown as ResolverContext;
}

describe("GraphQL Query.graph superseded_by edges (loop iteration 126 regression)", () => {
  it("includes a superseded_by edge when the replacement fact is a rendered node", () => {
    const factA = makeFact({ id: "fact-a" }); // active replacement
    const factB = makeFact({ id: "fact-b", supersededAt: 500, supersededBy: "fact-a" }); // superseded predecessor
    const factC = makeFact({ id: "fact-c" }); // unrelated active fact
    const context = makeContext([factA, factB, factC]);

    const result = resolvers.Query.graph(null, { filter: {} }, context) as GraphResult;

    const nodeIds = result.nodes.map((n) => n.id).sort();
    expect(nodeIds).toEqual(["fact-a", "fact-b", "fact-c"]);

    const supersedeEdges = result.edges.filter((e) => e.linkType === "superseded_by");
    // Synthetic lineage edges carry id: null (not a memory_links row).
    expect(supersedeEdges).toEqual([
      { id: null, source: "fact-b", target: "fact-a", linkType: "superseded_by", weight: 1 },
    ]);
  });

  it("omits the superseded_by edge and predecessor node when the replacement is filtered out", () => {
    const factA = makeFact({ id: "fact-a", category: "reasoning" }); // filtered out below
    const factB = makeFact({ id: "fact-b", supersededAt: 500, supersededBy: "fact-a" });
    const context = makeContext([factA, factB]);

    const result = resolvers.Query.graph(null, { filter: { categories: ["fact"] } }, context) as GraphResult;

    expect(result.nodes.map((n) => n.id)).not.toContain("fact-b");
    expect(result.edges.filter((e) => e.linkType === "superseded_by")).toEqual([]);
  });

  it("does not add a supersede edge when nothing is superseded", () => {
    const factA = makeFact({ id: "fact-a" });
    const context = makeContext([factA]);

    const result = resolvers.Query.graph(null, { filter: {} }, context) as GraphResult;

    expect(result.nodes.map((n) => n.id)).toEqual(["fact-a"]);
    expect(result.edges).toEqual([]);
  });
});
