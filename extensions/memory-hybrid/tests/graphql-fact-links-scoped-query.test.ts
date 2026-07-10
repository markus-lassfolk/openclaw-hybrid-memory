import { describe, expect, it, vi } from "vitest";
import { resolvers } from "../routes/graphql-resolvers.js";

type ResolverArgs = Record<string, unknown>;
type ResolverContext = Parameters<typeof resolvers.Mutation.supersedeFact>[2];

/**
 * Regression coverage (#2067-followup): Fact.links/Fact.linkedFrom previously loaded the entire
 * memory_links table via getAllLinks() on every parent fact resolved, instead of a bounded,
 * parameterized query scoped to that one fact's id -- an O(N * table-size) scan for a `facts {
 * links { ... } }` query over N facts. Both resolvers must now query with a WHERE clause bound to
 * the parent fact's id, not an unfiltered `SELECT * FROM memory_links`.
 */
describe("GraphQL Fact.links/linkedFrom use a bounded, parameterized query (#2067-followup)", () => {
  function makeFactsDb() {
    const preparedSql: string[] = [];
    const allArgs: unknown[][] = [];
    const factsDb = {
      getById: vi.fn(() => ({ id: "any", scope: "global", scopeTarget: null })),
      getRawDb: vi.fn(() => ({
        prepare: vi.fn((sql: string) => {
          preparedSql.push(sql);
          return {
            all: vi.fn((...args: unknown[]) => {
              allArgs.push(args);
              return [];
            }),
          };
        }),
      })),
    };
    return { factsDb, preparedSql, allArgs };
  }

  it("Fact.links queries with a WHERE source_fact_id = ? clause bound to the parent fact's id", () => {
    const { factsDb, preparedSql, allArgs } = makeFactsDb();
    const context = { factsDb, scopeFilter: {} } as unknown as ResolverContext;

    resolvers.Fact.links({ id: "fact-123" } as ResolverArgs, {} as ResolverArgs, context);

    expect(preparedSql.some((sql) => /WHERE\s+source_fact_id\s*=\s*\?/i.test(sql))).toBe(true);
    // A full unscoped table load (no WHERE clause at all) must not be issued for a single parent.
    expect(preparedSql.some((sql) => !/WHERE/i.test(sql))).toBe(false);
    expect(allArgs.some((args) => args[0] === "fact-123")).toBe(true);
  });

  it("Fact.linkedFrom queries with a WHERE target_fact_id = ? clause bound to the parent fact's id", () => {
    const { factsDb, preparedSql, allArgs } = makeFactsDb();
    const context = { factsDb, scopeFilter: {} } as unknown as ResolverContext;

    resolvers.Fact.linkedFrom({ id: "fact-456" } as ResolverArgs, {} as ResolverArgs, context);

    expect(preparedSql.some((sql) => /WHERE\s+target_fact_id\s*=\s*\?/i.test(sql))).toBe(true);
    expect(preparedSql.some((sql) => !/WHERE/i.test(sql))).toBe(false);
    expect(allArgs.some((args) => args[0] === "fact-456")).toBe(true);
  });
});
