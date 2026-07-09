/**
 * Regression test (loop iteration 125) for routes/graphql-resolvers.ts's `Query.stats`:
 *
 * `oldestFactDate`/`newestFactDate` were computed via `Math.min(...facts.map(...))` /
 * `Math.max(...facts.map(...))`. `allFacts(context, true)` has no LIMIT (unlike every other
 * resolver here, which caps `limit`/`maxNodes`), so once a persistent memory store accumulates
 * more facts than V8's function-argument spread limit (~65k-125k), spreading the array into
 * Math.min/Math.max throws `RangeError: Maximum call stack size exceeded` on every `stats` query.
 */
import { describe, expect, it, vi } from "vitest";
import { resolvers } from "../routes/graphql-resolvers.js";

type ResolverContext = Parameters<typeof resolvers.Query.stats>[2];
type StatsResult = {
  totalFacts: number;
  oldestFactDate: number | null;
  newestFactDate: number | null;
};

function makeFact(id: string, createdAt: number) {
  return {
    id,
    text: `fact ${id}`,
    category: "fact",
    decayClass: "durable",
    importance: 0.5,
    confidence: 0.9,
    scope: "global",
    scopeTarget: null,
    createdAt,
    expiresAt: null,
    supersededAt: null,
    supersededBy: null,
    tags: [],
    entity: null,
    key: null,
    value: null,
  };
}

function makeContext(facts: ReturnType<typeof makeFact>[]): ResolverContext {
  const factsDb = {
    getAll: vi.fn(() => facts),
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

describe("GraphQL Query.stats oldest/newest date computation (loop iteration 125 regression)", () => {
  it("does not throw when the fact store exceeds V8's spread argument limit", () => {
    const LARGE_COUNT = 150_000;
    const facts = Array.from({ length: LARGE_COUNT }, (_, i) => makeFact(`fact-${i}`, 1000 + i));
    const context = makeContext(facts);

    let result: StatsResult | undefined;
    expect(() => {
      result = resolvers.Query.stats(null, {}, context) as StatsResult;
    }).not.toThrow();

    expect(result!.oldestFactDate).toBe(1000);
    expect(result!.newestFactDate).toBe(1000 + LARGE_COUNT - 1);
    expect(result!.totalFacts).toBe(LARGE_COUNT);
  });

  it("returns null oldest/newest for an empty store", () => {
    const context = makeContext([]);
    const result = resolvers.Query.stats(null, {}, context) as StatsResult;
    expect(result.oldestFactDate).toBeNull();
    expect(result.newestFactDate).toBeNull();
  });

  it("computes correct oldest/newest for a small mixed-order store", () => {
    const facts = [makeFact("b", 500), makeFact("a", 100), makeFact("c", 900)];
    const context = makeContext(facts);
    const result = resolvers.Query.stats(null, {}, context) as StatsResult;
    expect(result.oldestFactDate).toBe(100);
    expect(result.newestFactDate).toBe(900);
  });
});
