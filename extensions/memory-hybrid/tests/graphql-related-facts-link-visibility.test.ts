import { describe, expect, it, vi } from "vitest";
import { resolvers } from "../routes/graphql-resolvers.js";

type ResolverArgs = Record<string, unknown>;
type ResolverContext = Parameters<typeof resolvers.Mutation.supersedeFact>[2];

/**
 * Regression coverage for the cross-tenant GraphQL `relatedFacts` BFS leak (loop iteration 21):
 * with `linkTypes` supplied, the previous implementation filtered links only by linkType and
 * walked every link through `visited`, then dropped out-of-scope facts at the final
 * `getById(...scopeFilter)` post-filter. A visible fact A linked to hidden B linked to
 * visible C therefore surfaced C (and indirectly confirmed B exists), even though no fully
 * visible link path A -> C existed. The fix pre-filters `relevantLinks` with `isLinkVisible`
 * so the BFS never even considers a link whose endpoint is outside the caller's scope.
 */
describe("GraphQL relatedFacts link-visibility filter (typed BFS)", () => {
  const tenantAFact = { id: "a-fact", scope: "user", scopeTarget: "tenantA" };
  const tenantBFact = { id: "b-fact", scope: "user", scopeTarget: "tenantB" };
  const farTenantAFact = { id: "far-a-fact", scope: "user", scopeTarget: "tenantA" };
  const globalFact = { id: "g-fact", scope: "global", scopeTarget: null };

  function makeFactsDb(
    getRawRows: Array<Record<string, unknown>>,
    extraFacts: Array<{ id: string; scope: string; scopeTarget: string | null }> = [],
  ) {
    const facts = new Map<string, { id: string; scope: string; scopeTarget: string | null }>([
      [tenantAFact.id, tenantAFact],
      [tenantBFact.id, tenantBFact],
      [globalFact.id, globalFact],
      ...extraFacts.map((fact) => [fact.id, fact] as const),
    ]);
    return {
      getById: vi.fn((id: string, opts?: { scopeFilter?: { userId?: string } }) => {
        const fact = facts.get(id);
        if (!fact) return null;
        if (fact.scope === "global") return fact;
        if (!opts?.scopeFilter?.userId) return null;
        return fact.scopeTarget === opts.scopeFilter.userId ? fact : null;
      }),
      getRawDb: vi.fn(() => ({
        prepare: vi.fn(() => ({
          all: vi.fn(() => getRawRows),
          run: vi.fn(() => ({ changes: 1 })),
        })),
      })),
      getConnectedFactIds: vi.fn(() => []),
    };
  }

  it("does not surface a path that has no fully visible links (loop iteration 21 regression)", () => {
    // Visible A -> hidden B -> visible C. With the link-visibility filter in place the BFS
    // never adds B (and therefore never adds C through B). Without the fix, C would still
    // surface through B even though A->B and B->C each have a hidden endpoint.
    const factsDb = makeFactsDb(
      [
        {
          id: "link-a-b",
          source_fact_id: "a-fact",
          target_fact_id: "b-fact",
          link_type: "RELATED_TO",
          strength: 1,
          created_at: 1,
        },
        {
          id: "link-b-far",
          source_fact_id: "b-fact",
          target_fact_id: "far-a-fact",
          link_type: "RELATED_TO",
          strength: 1,
          created_at: 2,
        },
      ],
      [farTenantAFact],
    );
    const context = { factsDb, scopeFilter: { userId: "tenantA" } } as unknown as ResolverContext;

    const result = resolvers.Query.relatedFacts(
      null,
      { factId: "a-fact", maxDepth: 3, linkTypes: ["RELATED_TO"] } as ResolverArgs,
      context,
    ) as Array<{ id: string }>;

    expect(result.map((fact) => fact.id).sort()).toEqual([]);
  });

  it("does not let hidden B confirm its existence as an intermediate node", () => {
    // A -> B (hidden) -> g-fact (global). With the fix, g-fact must NOT come back because the
    // only path traverses hidden B. Without the fix, B is in visited, g-fact is added via B, and
    // the post-filter only drops B but keeps g-fact — which also indirectly confirms B exists.
    const factsDb = makeFactsDb([
      {
        id: "link-a-b",
        source_fact_id: "a-fact",
        target_fact_id: "b-fact",
        link_type: "RELATED_TO",
        strength: 1,
        created_at: 1,
      },
      {
        id: "link-b-g",
        source_fact_id: "b-fact",
        target_fact_id: "g-fact",
        link_type: "RELATED_TO",
        strength: 1,
        created_at: 2,
      },
    ]);
    const context = { factsDb, scopeFilter: { userId: "tenantA" } } as unknown as ResolverContext;

    const result = resolvers.Query.relatedFacts(
      null,
      { factId: "a-fact", maxDepth: 3, linkTypes: ["RELATED_TO"] } as ResolverArgs,
      context,
    ) as Array<{ id: string }>;

    expect(result.map((fact) => fact.id).sort()).toEqual([]);
  });

  it("still traverses visible links correctly when both endpoints are in scope", () => {
    // A (visible) -> g-fact (global) -> far-a-fact (visible). All endpoints visible, BFS
    // should surface both g-fact and far-a-fact. This guards against the fix over-reaching and
    // breaking the existing happy path from the loop-iteration 19 regression test.
    const factsDb = makeFactsDb(
      [
        {
          id: "link-a-g",
          source_fact_id: "a-fact",
          target_fact_id: "g-fact",
          link_type: "RELATED_TO",
          strength: 1,
          created_at: 1,
        },
        {
          id: "link-g-far",
          source_fact_id: "g-fact",
          target_fact_id: "far-a-fact",
          link_type: "RELATED_TO",
          strength: 1,
          created_at: 2,
        },
      ],
      [farTenantAFact],
    );
    const context = { factsDb, scopeFilter: { userId: "tenantA" } } as unknown as ResolverContext;

    const result = resolvers.Query.relatedFacts(
      null,
      { factId: "a-fact", maxDepth: 3, linkTypes: ["RELATED_TO"] } as ResolverArgs,
      context,
    ) as Array<{ id: string }>;

    expect(result.map((fact) => fact.id).sort()).toEqual(["far-a-fact", "g-fact"]);
  });
});
