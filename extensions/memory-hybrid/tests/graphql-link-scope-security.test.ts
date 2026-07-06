import { describe, expect, it, vi } from "vitest";
import { isLinkVisible, resolvers } from "../routes/graphql-resolvers.js";
import { isFactPayloadVisible } from "../routes/graphql-server.js";

type ResolverArgs = Record<string, unknown>;
type ResolverContext = Parameters<typeof resolvers.Mutation.supersedeFact>[2];

/**
 * Regression coverage for the cross-tenant GraphQL link/subscription leak (loop iteration 7):
 * memory_links carries no scope column of its own, so `Query.link`/`Query.links`,
 * `createLink`/`deleteLink`, and the fact/link subscriptions must derive visibility from the
 * endpoints' own scoped facts rather than skipping scope checks entirely.
 */
describe("GraphQL link/subscription scope enforcement", () => {
  const tenantAFact: { id: string; scope: string; scopeTarget: string | null } = {
    id: "a-fact",
    scope: "user",
    scopeTarget: "tenantA",
  };
  const tenantBFact: { id: string; scope: string; scopeTarget: string | null } = {
    id: "b-fact",
    scope: "user",
    scopeTarget: "tenantB",
  };
  const globalFact: { id: string; scope: string; scopeTarget: string | null } = {
    id: "g-fact",
    scope: "global",
    scopeTarget: null,
  };

  function makeFactsDb(getRawRows: Array<Record<string, unknown>> = []) {
    const facts = new Map([
      [tenantAFact.id, tenantAFact],
      [tenantBFact.id, tenantBFact],
      [globalFact.id, globalFact],
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
      createLink: vi.fn(() => "new-link-id"),
    };
  }

  it("isLinkVisible requires BOTH endpoints to resolve under the scope filter", () => {
    const factsDb = makeFactsDb();
    const scopeFilter = { userId: "tenantA" };
    expect(isLinkVisible(factsDb as never, { sourceId: "a-fact", targetId: "g-fact" }, scopeFilter)).toBe(true);
    expect(isLinkVisible(factsDb as never, { sourceId: "a-fact", targetId: "b-fact" }, scopeFilter)).toBe(false);
    expect(isLinkVisible(factsDb as never, { sourceId: "b-fact", targetId: "g-fact" }, scopeFilter)).toBe(false);
  });

  it("Query.link returns null when the link connects an out-of-scope fact", () => {
    const factsDb = makeFactsDb([
      {
        id: "link-1",
        source_fact_id: "a-fact",
        target_fact_id: "b-fact",
        link_type: "RELATED_TO",
        strength: 1,
        created_at: 0,
      },
    ]);
    const context = { factsDb, scopeFilter: { userId: "tenantA" } } as unknown as ResolverContext;
    expect(resolvers.Query.link(null, { id: "link-1" } as ResolverArgs, context)).toBeNull();
  });

  it("Query.links filters out links with an out-of-scope endpoint", () => {
    const factsDb = makeFactsDb([
      {
        id: "link-visible",
        source_fact_id: "a-fact",
        target_fact_id: "g-fact",
        link_type: "RELATED_TO",
        strength: 1,
        created_at: 1,
      },
      {
        id: "link-hidden",
        source_fact_id: "a-fact",
        target_fact_id: "b-fact",
        link_type: "RELATED_TO",
        strength: 1,
        created_at: 2,
      },
    ]);
    const context = { factsDb, scopeFilter: { userId: "tenantA" } } as unknown as ResolverContext;
    const result = resolvers.Query.links(null, {} as ResolverArgs, context) as Array<{ id: string }>;
    expect(result.map((link) => link.id)).toEqual(["link-visible"]);
  });

  it("createLink rejects an out-of-scope endpoint instead of planting a cross-tenant link", () => {
    const factsDb = makeFactsDb();
    const context = { factsDb, scopeFilter: { userId: "tenantA" } } as unknown as ResolverContext;
    expect(() =>
      resolvers.Mutation.createLink(null, { sourceId: "a-fact", targetId: "b-fact" } as ResolverArgs, context),
    ).toThrow(/not found/);
    expect(factsDb.createLink).not.toHaveBeenCalled();
  });

  it("deleteLink refuses to delete a link it cannot fully see", () => {
    const factsDb = makeFactsDb([
      {
        id: "link-1",
        source_fact_id: "a-fact",
        target_fact_id: "b-fact",
        link_type: "RELATED_TO",
        strength: 1,
        created_at: 0,
      },
    ]);
    const context = { factsDb, scopeFilter: { userId: "tenantA" } } as unknown as ResolverContext;
    expect(resolvers.Mutation.deleteLink(null, { id: "link-1" } as ResolverArgs, context)).toBe(false);
  });

  it("isFactPayloadVisible blocks a subscription payload scoped to a different tenant", () => {
    expect(isFactPayloadVisible(tenantBFact, undefined, { userId: "tenantA" })).toBe(false);
    expect(isFactPayloadVisible(tenantAFact, undefined, { userId: "tenantA" })).toBe(true);
    expect(isFactPayloadVisible(globalFact, undefined, { userId: "tenantA" })).toBe(true);
  });
});
