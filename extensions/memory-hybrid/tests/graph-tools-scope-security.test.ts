import { describe, expect, it, vi } from "vitest";
import { scopedRowMatchesFilter } from "../backends/facts-db/scope-sql.js";
import { hybridConfigSchema } from "../config.js";
import { registerGraphTools } from "../tools/graph-tools.js";
import type { MemoryScope, ScopeFilter } from "../types/memory.js";

/**
 * Regression coverage for the cross-tenant leak in memory_link/memory_graph/memory_path (loop
 * iteration 8): the graph tools historically had no scope-filter wiring at all — unlike
 * tools/memory/*, which threads a scope filter through every factsDb call. memory_links carries
 * no scope column of its own (it connects two independently-scoped facts), so a scoped fact
 * linked from an in-scope one must still never surface via graph exploration or linking.
 */
describe("graph tools scope enforcement", () => {
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

  function makeFactsDb(facts: FakeFact[], links: FakeLink[]) {
    const factMap = new Map(facts.map((f) => [f.id, f]));
    return {
      getById: vi.fn((id: string, opts?: { scopeFilter?: ScopeFilter | null }) => {
        const f = factMap.get(id);
        if (!f) return null;
        return scopedRowMatchesFilter(f.scope, f.scopeTarget, opts?.scopeFilter) ? f : null;
      }),
      getLinksFrom: vi.fn((id: string) =>
        links
          .filter((l) => l.sourceFactId === id)
          .map(({ id: linkId, targetFactId, linkType, strength }) => ({
            id: linkId,
            targetFactId,
            linkType,
            strength,
          })),
      ),
      getLinksTo: vi.fn((id: string) =>
        links
          .filter((l) => l.targetFactId === id)
          .map(({ id: linkId, sourceFactId, linkType, strength }) => ({
            id: linkId,
            sourceFactId,
            linkType,
            strength,
          })),
      ),
      createLink: vi.fn(() => "new-link-id"),
      recordContradiction: vi.fn(() => "contradiction-id"),
      getConnectedFactIds: vi.fn((ids: string[]) => {
        const out = new Set(ids);
        for (const l of links) {
          if (ids.includes(l.sourceFactId)) out.add(l.targetFactId);
          if (ids.includes(l.targetFactId)) out.add(l.sourceFactId);
        }
        return [...out];
      }),
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

  const ownFact: FakeFact = { id: "own-1", text: "Tenant A's own fact", scope: "agent", scopeTarget: "tenantA" };
  const foreignFact: FakeFact = {
    id: "foreign-1",
    text: "Tenant B's private fact",
    scope: "agent",
    scopeTarget: "tenantB",
  };
  const link: FakeLink = {
    id: "link-1",
    sourceFactId: "own-1",
    targetFactId: "foreign-1",
    linkType: "RELATED_TO",
    strength: 0.8,
  };

  it("memory_link refuses to link to an out-of-scope fact", async () => {
    const { api, factsDb } = setup([ownFact, foreignFact], []);
    const result = (await api.getTool("memory_link")?.execute("call-1", {
      sourceFact: "own-1",
      targetFact: "foreign-1",
      linkType: "RELATED_TO",
    })) as { details: Record<string, unknown> };
    expect(result.details.error).toBe("target_not_found");
    expect(factsDb.createLink).not.toHaveBeenCalled();
  });

  it("memory_graph omits an out-of-scope linked fact from direct links and connected count", async () => {
    const { api } = setup([ownFact, foreignFact], [link]);
    const result = (await api.getTool("memory_graph")?.execute("call-1", { factId: "own-1" })) as {
      content: Array<{ text: string }>;
      details: Record<string, unknown>;
    };
    expect(result.content[0].text).not.toContain("Tenant B's private fact");
    expect(result.details.outbound).toBe(0);
    // connectedCount includes the anchor fact itself (own-1) from the fake BFS seed set — the
    // out-of-scope foreign-1 must be the only thing filtered out.
    expect(result.details.connectedCount).toBe(1);
  });

  it("memory_path cannot resolve an out-of-scope fact id as an endpoint", async () => {
    const { api } = setup([ownFact, foreignFact], [link]);
    const result = (await api.getTool("memory_path")?.execute("call-1", {
      from: "own-1",
      to: "foreign-1",
    })) as { details: Record<string, unknown> };
    expect(result.details.error).toBe("to_not_found");
  });
});
