import { describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { registerVerificationTools } from "../tools/verification-tools.js";
import type { MemoryScope, ScopeFilter } from "../types/memory.js";

/**
 * Regression coverage for the cross-tenant leak in memory_verify/memory_verification_status
 * (loop iteration 9): both called factsDb.getById with no scope filter, so a caller could verify
 * (copying its full text into the verification store) or probe the status of a fact belonging
 * to a different tenant/scope.
 */
describe("verification tools scope enforcement", () => {
  type FakeFact = { id: string; text: string; scope: MemoryScope; scopeTarget: string | null };

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

  /** Mirrors applyLookupFilters in backends/facts-db/fact-read-queries.ts: an omitted/empty
   * scopeFilter is PERMISSIVE (no filtering at all) — only a non-empty filter restricts by scope. */
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

  function makeFactsDb(facts: FakeFact[]) {
    const factMap = new Map(facts.map((f) => [f.id, f]));
    return {
      getById: vi.fn((id: string, opts?: { scopeFilter?: ScopeFilter | null }) => {
        const f = factMap.get(id);
        if (!f) return null;
        return matchesScopeLookup(f, opts?.scopeFilter) ? f : null;
      }),
    };
  }

  function makeVerificationStore() {
    return {
      getVerified: vi.fn(() => null),
      verify: vi.fn(() => "verification-id"),
    };
  }

  function setup(facts: FakeFact[]) {
    const cfg = hybridConfigSchema.parse({ embedding: { provider: "onnx", model: "bge-m3", dimensions: 1024 } });
    const factsDb = makeFactsDb(facts);
    const verificationStore = makeVerificationStore();
    const api = makeApi();
    registerVerificationTools(
      {
        factsDb: factsDb as never,
        verificationStore: verificationStore as never,
        cfg,
        currentAgentIdRef: { value: "tenantA" },
        buildToolScopeFilter: (_params, currentAgent, config) =>
          currentAgent && currentAgent !== config.multiAgent.orchestratorId ? { agentId: currentAgent } : undefined,
      },
      api as never,
    );
    return { api, factsDb, verificationStore };
  }

  const foreignFact: FakeFact = {
    id: "foreign-1",
    text: "Tenant B's private fact",
    scope: "agent",
    scopeTarget: "tenantB",
  };

  it("memory_verify refuses to copy an out-of-scope fact's text into the verification store", async () => {
    const { api, verificationStore } = setup([foreignFact]);
    const result = (await api.getTool("memory_verify")?.execute("call-1", { factId: "foreign-1" })) as {
      details: Record<string, unknown>;
    };
    expect(result.details.error).toBe("not_found");
    expect(verificationStore.verify).not.toHaveBeenCalled();
  });

  it("memory_verification_status reports not_verified for an out-of-scope fact instead of leaking its status", async () => {
    const { api, verificationStore } = setup([foreignFact]);
    const result = (await api.getTool("memory_verification_status")?.execute("call-1", {
      factId: "foreign-1",
    })) as { details: Record<string, unknown> };
    expect(result.details.status).toBe("not_verified");
    expect(verificationStore.getVerified).not.toHaveBeenCalled();
  });
});
