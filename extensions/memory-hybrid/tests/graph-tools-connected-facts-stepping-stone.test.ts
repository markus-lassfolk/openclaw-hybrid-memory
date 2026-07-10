/**
 * Regression test (#2067-followup) for tools/graph-tools.ts's memory_graph tool:
 *
 * `connectedIds` was computed via the raw, unscoped `factsDb.getConnectedFactIds()` and only
 * filtered by scope AFTER the BFS completed. This let a hidden (out-of-scope) fact serve as a
 * stepping-stone: visible A -> hidden B -> visible C traversed through B to reach C, and C still
 * came back in `connectedCount` even though no edge on that path was ever visible to the caller
 * -- indirectly confirming hidden B exists and is linked into the caller's own graph. Migrated to
 * a local scopedConnectedFactIds() BFS (mirroring routes/graphql-resolvers.ts's fix for the
 * equivalent GraphQL leak) that scope-checks every traversed edge, not just the final result set.
 */
import { describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { registerGraphTools } from "../tools/graph-tools.js";
import type { MemoryScope, ScopeFilter } from "../types/memory.js";

describe("memory_graph connected-facts stepping-stone leak (#2067-followup)", () => {
  type FakeFact = { id: string; text: string; scope: MemoryScope; scopeTarget: string | null };
  type FakeLink = { id: string; sourceFactId: string; targetFactId: string; linkType: string; strength: number };

  function makeApi() {
    const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
    return {
      registerTool(opts: Record<string, unknown>) {
        tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
      },
      getTool(name: string) {
        return tools.get(name);
      },
    };
  }

  function matchesScopeLookup(f: FakeFact, filter: ScopeFilter | null | undefined): boolean {
    if (!filter || (!filter.userId && !filter.agentId && !filter.sessionId)) return true;
    if (f.scope === "global") return true;
    const target = f.scopeTarget ?? null;
    return (
      (f.scope === "user" && (filter.userId ?? null) === target) ||
      (f.scope === "agent" && (filter.agentId ?? null) === target) ||
      (f.scope === "session" && (filter.sessionId ?? null) === target)
    );
  }

  function makeFactsDb(facts: FakeFact[], links: FakeLink[]) {
    const factMap = new Map(facts.map((f) => [f.id, f]));
    return {
      getById: vi.fn((id: string, opts?: { scopeFilter?: ScopeFilter | null }) => {
        const f = factMap.get(id);
        if (!f) return null;
        return matchesScopeLookup(f, opts?.scopeFilter) ? f : null;
      }),
      getLinksFrom: vi.fn((id: string) =>
        links
          .filter((l) => l.sourceFactId === id)
          .map(({ id: linkId, targetFactId, linkType, strength }) => ({ id: linkId, targetFactId, linkType, strength })),
      ),
      getLinksTo: vi.fn((id: string) =>
        links
          .filter((l) => l.targetFactId === id)
          .map(({ id: linkId, sourceFactId, linkType, strength }) => ({ id: linkId, sourceFactId, linkType, strength })),
      ),
      // Raw, unscoped, real multi-hop BFS -- exactly what the buggy code used to call directly
      // (and exactly why it leaked: it happily walks straight through a hidden intermediate
      // fact). Still present on the mock so a regression back to calling it directly would be
      // exercised, not just absent.
      getConnectedFactIds: vi.fn((ids: string[], maxDepth: number) => {
        const visited = new Set(ids);
        let frontier = new Set(ids);
        for (let depth = 0; depth < maxDepth && frontier.size > 0; depth++) {
          const next = new Set<string>();
          for (const l of links) {
            if (frontier.has(l.sourceFactId) && !visited.has(l.targetFactId)) {
              visited.add(l.targetFactId);
              next.add(l.targetFactId);
            }
            if (frontier.has(l.targetFactId) && !visited.has(l.sourceFactId)) {
              visited.add(l.sourceFactId);
              next.add(l.sourceFactId);
            }
          }
          frontier = next;
        }
        return [...visited];
      }),
      createLink: vi.fn(() => "new-link-id"),
      recordContradiction: vi.fn(() => "contradiction-id"),
      lookup: vi.fn(() => []),
    };
  }

  function setup(facts: FakeFact[], links: FakeLink[]) {
    const cfg = hybridConfigSchema.parse({ embedding: { provider: "onnx", model: "bge-m3", dimensions: 1024 } });
    cfg.graph.enabled = true;
    cfg.path.enabled = true;
    const factsDb = makeFactsDb(facts, links);
    const api = makeApi();
    registerGraphTools(
      {
        factsDb: factsDb as never,
        cfg,
        currentAgentIdRef: { value: "tenantA" },
        buildToolScopeFilter: (_params, currentAgent, config) =>
          currentAgent && currentAgent !== config.multiAgent.orchestratorId ? { agentId: currentAgent } : undefined,
      },
      api as never,
    );
    return { api, factsDb };
  }

  it("does not surface a fact reachable only through a hidden intermediate fact", async () => {
    const visibleA: FakeFact = { id: "a-fact", text: "Tenant A visible root", scope: "agent", scopeTarget: "tenantA" };
    const hiddenB: FakeFact = { id: "b-fact", text: "Tenant B private", scope: "agent", scopeTarget: "tenantB" };
    const visibleC: FakeFact = { id: "c-fact", text: "Global visible leaf", scope: "global", scopeTarget: null };
    const linkAB: FakeLink = {
      id: "link-a-b",
      sourceFactId: "a-fact",
      targetFactId: "b-fact",
      linkType: "RELATED_TO",
      strength: 1,
    };
    const linkBC: FakeLink = {
      id: "link-b-c",
      sourceFactId: "b-fact",
      targetFactId: "c-fact",
      linkType: "RELATED_TO",
      strength: 1,
    };
    const { api, factsDb } = setup([visibleA, hiddenB, visibleC], [linkAB, linkBC]);

    const result = (await api.getTool("memory_graph")?.execute("call-1", { factId: "a-fact", depth: 3 })) as {
      details: Record<string, unknown>;
    };

    // Only the seed (a-fact) should be counted as connected -- b-fact is hidden, so the BFS must
    // never traverse the a->b edge at all, and c-fact (only reachable via b) must never surface.
    expect(result.details.connectedCount).toBe(1);
    // The unscoped raw BFS must never even be called now that the fix routes through
    // getLinksFrom/getLinksTo with a per-edge scope check instead.
    expect(factsDb.getConnectedFactIds).not.toHaveBeenCalled();
  });
});
