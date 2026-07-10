/**
 * Regression coverage (#2067-followup) for routes/graphql-resolvers.ts's `Query.graph`:
 *
 * `GraphFilterInput` declares `linkTypes`, `maxDepth`, and `startNodeIds`, but the resolver
 * silently ignored all three and always returned the same "top-N facts by recency" node set
 * regardless of what a caller asked for -- a seed-rooted subgraph request got back an unrelated
 * flat listing instead. The fix reuses the same scoped-BFS helper Query.relatedFacts uses, so a
 * startNodeIds-rooted traversal also can't reveal a path through a fact outside the caller's
 * scope.
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

function makeContext(
  facts: ReturnType<typeof makeFact>[],
  linkRows: Array<Record<string, unknown>> = [],
): ResolverContext {
  const factMap = new Map(facts.map((f) => [f.id, f]));
  const factsDb = {
    getAll: vi.fn((options?: { includeSuperseded?: boolean }) => {
      const includeSuperseded = options?.includeSuperseded === true;
      return facts.filter((fact) => includeSuperseded || fact.supersededAt == null);
    }),
    getById: vi.fn((id: string) => factMap.get(id) ?? null),
    getRawDb: vi.fn(() => ({
      prepare: vi.fn(() => ({ all: vi.fn(() => linkRows) })),
    })),
  };
  return {
    factsDb,
    pluginContext: {},
    scopeFilter: {},
  } as unknown as ResolverContext;
}

describe("GraphQL Query.graph startNodeIds/maxDepth/linkTypes (#2067-followup)", () => {
  it("restricts the node set to facts reachable from startNodeIds within maxDepth, instead of an unrelated top-N-by-recency listing", () => {
    const seed = makeFact({ id: "seed", createdAt: 1 });
    const neighbor = makeFact({ id: "neighbor", createdAt: 2 });
    const unrelated = makeFact({ id: "unrelated", createdAt: 3 });
    const context = makeContext(
      [seed, neighbor, unrelated],
      [
        {
          id: "link-1",
          source_fact_id: "seed",
          target_fact_id: "neighbor",
          link_type: "RELATED_TO",
          strength: 1,
          created_at: 1,
        },
      ],
    );

    const result = resolvers.Query.graph(
      null,
      { filter: { startNodeIds: ["seed"], maxDepth: 1 } },
      context,
    ) as GraphResult;

    expect(result.nodes.map((n) => n.id).sort()).toEqual(["neighbor", "seed"]);
  });

  it("does not surface a fact reachable only through a link type excluded by linkTypes", () => {
    const seed = makeFact({ id: "seed" });
    const neighbor = makeFact({ id: "neighbor" });
    const context = makeContext(
      [seed, neighbor],
      [
        {
          id: "link-1",
          source_fact_id: "seed",
          target_fact_id: "neighbor",
          link_type: "CONTRADICTS",
          strength: 1,
          created_at: 1,
        },
      ],
    );

    const result = resolvers.Query.graph(
      null,
      { filter: { startNodeIds: ["seed"], maxDepth: 1, linkTypes: ["RELATED_TO"] } },
      context,
    ) as GraphResult;

    expect(result.nodes.map((n) => n.id)).toEqual(["seed"]);
  });

  it("falls back to the default top-N-by-recency behavior when startNodeIds is not given", () => {
    const factA = makeFact({ id: "fact-a", createdAt: 3 });
    const factB = makeFact({ id: "fact-b", createdAt: 2 });
    const context = makeContext([factA, factB]);

    const result = resolvers.Query.graph(null, { filter: {} }, context) as GraphResult;

    expect(result.nodes.map((n) => n.id).sort()).toEqual(["fact-a", "fact-b"]);
  });
});
