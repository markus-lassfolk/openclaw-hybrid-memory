/**
 * Regression test for routes/graphql-resolvers.ts's `Query.search`:
 *
 * `SearchInput.decayClasses` and `SearchInput.scopeTarget` are declared in the GraphQL schema
 * and accepted from clients, but `searchFacts()` never read them — a caller narrowing a search
 * to a specific decay class or scope target silently got back unfiltered results instead.
 */
import { describe, expect, it, vi } from "vitest";
import { resolvers } from "../routes/graphql-resolvers.js";

type ResolverContext = Parameters<typeof resolvers.Query.search>[2];

function makeFact(overrides: Record<string, unknown>) {
  return {
    id: "fact",
    text: "widget deployment notes",
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
  };
  return {
    factsDb,
    pluginContext: {},
    scopeFilter: {},
  } as unknown as ResolverContext;
}

describe("GraphQL Query.search decayClasses/scopeTarget filters", () => {
  it("filters out facts whose decayClass is not in the requested decayClasses set", () => {
    const durable = makeFact({ id: "durable-fact", decayClass: "durable" });
    const volatile = makeFact({ id: "volatile-fact", decayClass: "volatile" });
    const context = makeContext([durable, volatile]);

    const results = resolvers.Query.search(
      null,
      { input: { query: "widget", decayClasses: ["durable"] } },
      context,
    ) as Array<{ fact: { id: string } }>;

    expect(results.map((r) => r.fact.id)).toEqual(["durable-fact"]);
  });

  it("filters out facts whose scopeTarget does not match the requested scopeTarget", () => {
    const tenantA = makeFact({ id: "tenant-a-fact", scope: "user", scopeTarget: "tenant-a" });
    const tenantB = makeFact({ id: "tenant-b-fact", scope: "user", scopeTarget: "tenant-b" });
    const context = makeContext([tenantA, tenantB]);

    const results = resolvers.Query.search(
      null,
      { input: { query: "widget", scopeTarget: "tenant-a" } },
      context,
    ) as Array<{ fact: { id: string } }>;

    expect(results.map((r) => r.fact.id)).toEqual(["tenant-a-fact"]);
  });
});
