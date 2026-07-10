/**
 * Regression test (#2067-followup) for routes/graphql-resolvers.ts:
 *
 * `getAllLinks()` previously loaded the ENTIRE memory_links table with no SQL-level bound at
 * all, and was used by every top-level link-touching resolver (link/links/graph/stats,
 * scopedConnectedFactIds). Since node:sqlite calls are synchronous, a single request against a
 * large table could stall the whole GraphQL/dashboard HTTP process for every tenant sharing it.
 * `relatedFacts` also had no `limit` argument at all, unlike its siblings (facts/search/links/
 * entityFacts), so a wide traversal could force an unbounded response payload.
 */
import { describe, expect, it, vi } from "vitest";
import { resolvers } from "../routes/graphql-resolvers.js";

type ResolverArgs = Record<string, unknown>;
type ResolverContext = Parameters<typeof resolvers.Mutation.supersedeFact>[2];

describe("GraphQL links scan cap and relatedFacts limit (#2067-followup)", () => {
  function makeFact(id: string) {
    return { id, scope: "global", scopeTarget: null };
  }

  function makeFactsDb(linkRows: Array<Record<string, unknown>>, extraFacts: Array<{ id: string }> = []) {
    const facts = new Map(extraFacts.map((f) => [f.id, makeFact(f.id)]));
    const preparedSql: string[] = [];
    const allCalls: unknown[][] = [];
    return {
      factsDb: {
        getById: vi.fn((id: string) => facts.get(id) ?? null),
        getRawDb: vi.fn(() => ({
          prepare: vi.fn((sql: string) => {
            preparedSql.push(sql);
            return {
              all: vi.fn((...args: unknown[]) => {
                allCalls.push(args);
                return linkRows;
              }),
              get: vi.fn((id: string) => linkRows.find((row) => row.id === id)),
              run: vi.fn(() => ({ changes: 1 })),
            };
          }),
        })),
      },
      preparedSql,
      allCalls,
    };
  }

  it("getAllLinks binds a LIMIT clause instead of scanning the whole table unbounded", () => {
    const { factsDb, preparedSql, allCalls } = makeFactsDb([]);
    const context = { factsDb, scopeFilter: { userId: "tenantA" } } as unknown as ResolverContext;

    resolvers.Query.links(null, {} as ResolverArgs, context);

    expect(preparedSql.some((sql) => /LIMIT\s*\?/i.test(sql))).toBe(true);
    expect(allCalls.some((args) => typeof args[0] === "number" && (args[0] as number) > 0)).toBe(true);
  });

  it("relatedFacts respects an explicit limit argument", () => {
    const neighbors = Array.from({ length: 5 }, (_, i) => `neighbor-${i}`);
    const linkRows = neighbors.map((id, i) => ({
      id: `link-${i}`,
      source_fact_id: "root",
      target_fact_id: id,
      link_type: "RELATED_TO",
      strength: 1,
      created_at: i,
    }));
    const { factsDb } = makeFactsDb(linkRows, [{ id: "root" }, ...neighbors.map((id) => ({ id }))]);
    const context = { factsDb, scopeFilter: { userId: "tenantA" } } as unknown as ResolverContext;

    const result = resolvers.Query.relatedFacts(
      null,
      { factId: "root", maxDepth: 1, limit: 2 } as ResolverArgs,
      context,
    ) as Array<{ id: string }>;

    expect(result.length).toBe(2);
  });

  it("relatedFacts defaults to a bounded limit when none is given", () => {
    const neighbors = Array.from({ length: 3 }, (_, i) => `neighbor-${i}`);
    const linkRows = neighbors.map((id, i) => ({
      id: `link-${i}`,
      source_fact_id: "root",
      target_fact_id: id,
      link_type: "RELATED_TO",
      strength: 1,
      created_at: i,
    }));
    const { factsDb } = makeFactsDb(linkRows, [{ id: "root" }, ...neighbors.map((id) => ({ id }))]);
    const context = { factsDb, scopeFilter: { userId: "tenantA" } } as unknown as ResolverContext;

    const result = resolvers.Query.relatedFacts(
      null,
      { factId: "root", maxDepth: 1 } as ResolverArgs,
      context,
    ) as Array<{ id: string }>;

    expect(result.length).toBe(3);
  });
});
