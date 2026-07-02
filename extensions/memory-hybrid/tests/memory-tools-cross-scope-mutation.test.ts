// @ts-nocheck — registerMemoryTools uses `ClawdbotPluginApi` from `openclaw`, not available in
// the test environment; consistent with the pattern in wal-scope-payload.test.ts.
/**
 * Regression tests: memory_store's `supersedes` param, memory_forget, and memory_promote must not
 * be able to mutate a fact outside the caller's own scope. Before the fix, all three called
 * factsDb.delete/supersede/promoteScope directly with no scope check, so any caller who knew (or
 * guessed) another agent's fact id could supersede, hard-delete, or promote it to global scope.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { registerMemoryTools } from "../tools/memory-tools.js";
import { buildToolScopeFilter } from "../utils/scope-filter.js";

const { FactsDB } = _testing;

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session" },
  };
}

function makeMockVectorDb() {
  return {
    hasDuplicate: vi.fn().mockResolvedValue(false),
    store: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    close: vi.fn(),
  };
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue(new Array(4).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([]),
    dimensions: 4,
    modelName: "mock-model",
  };
}

function makeCfg() {
  return {
    captureMaxChars: 2000,
    categories: ["fact", "preference", "decision"],
    store: { classifyBeforeWrite: false },
    // trustToolScopeParams is NOT set (defaults falsy) — buildToolScopeFilter derives scope
    // purely from currentAgentIdRef, matching production's default multi-tenant posture.
    multiAgent: { orchestratorId: "main", defaultStoreScope: "global", strictAgentScoping: false },
    graph: {
      enabled: false,
      autoLink: false,
      autoLinkLimit: 5,
      autoLinkMinScore: 0.5,
      useInRecall: false,
      maxTraversalDepth: 2,
      coOccurrenceWeight: 0.5,
      autoSupersede: false,
    },
    graphRetrieval: { enabled: false, defaultExpand: false, maxExpandDepth: 3, maxExpandedResults: 20 },
    credentials: { enabled: false },
    autoRecall: { scopeFilter: null, summaryThreshold: 0, summaryMaxChars: 500 },
    distill: { reinforcementBoost: 0.1 },
    retrieval: { strategies: [], explicitBudgetTokens: 2000 },
    aliases: { enabled: false },
    procedures: { enabled: false },
    clusters: null,
  };
}

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-tools-cross-scope-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function setupToolsAs(currentAgent: string | null) {
  const api = makeMockApi();
  registerMemoryTools(
    {
      factsDb: factsDb as never,
      edictStore: null as never,
      vectorDb: makeMockVectorDb() as never,
      cfg: makeCfg() as never,
      embeddings: makeMockEmbeddings() as never,
      openai: {} as never,
      wal: null,
      credentialsDb: null,
      eventLog: null,
      lastProgressiveIndexIds: [],
      currentAgentIdRef: { value: currentAgent },
      pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
      aliasDb: null,
    },
    api as never,
    buildToolScopeFilter,
    async () => "wal-id",
    async () => {},
    async () => [],
  );
  return api;
}

describe("memory_forget cross-scope isolation", () => {
  it("does not delete a fact owned by a different agent scope", async () => {
    const otherAgentFact = factsDb.store({
      text: "Agent-2's private note",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "agent",
      scopeTarget: "agent-2",
    });

    const api = setupToolsAs("agent-1");
    const tool = api.getTool("memory_forget");
    const result = (await tool?.execute("call-1", { memoryId: otherAgentFact.id })) as {
      details?: { action?: string };
    };

    expect(result.details?.action).toBe("not_found");
    // The fact must still exist, untouched.
    expect(factsDb.getById(otherAgentFact.id)).not.toBeNull();
  });

  it("still deletes a fact the caller owns", async () => {
    const ownFact = factsDb.store({
      text: "Agent-1's own note",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "agent",
      scopeTarget: "agent-1",
    });

    const api = setupToolsAs("agent-1");
    const tool = api.getTool("memory_forget");
    const result = (await tool?.execute("call-1", { memoryId: ownFact.id })) as { details?: { action?: string } };

    expect(result.details?.action).toBe("deleted");
    expect(factsDb.getById(ownFact.id)).toBeNull();
  });

  it("excludes out-of-scope facts from the query-based search/auto-delete path", async () => {
    const otherAgentFact = factsDb.store({
      text: "Very unique searchable secret phrase xyzzyplugh",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "agent",
      scopeTarget: "agent-2",
    });

    const api = setupToolsAs("agent-1");
    const tool = api.getTool("memory_forget");
    const result = (await tool?.execute("call-1", { query: "xyzzyplugh" })) as { details?: { found?: number } };

    expect(result.details?.found).toBe(0);
    expect(factsDb.getById(otherAgentFact.id)).not.toBeNull();
  });
});

describe("memory_promote cross-scope isolation", () => {
  it("does not promote a fact owned by a different agent scope", async () => {
    const otherAgentFact = factsDb.store({
      text: "Agent-2's session secret",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "agent",
      scopeTarget: "agent-2",
    });

    const api = setupToolsAs("agent-1");
    const tool = api.getTool("memory_promote");
    const result = (await tool?.execute("call-1", { memoryId: otherAgentFact.id, scope: "global" })) as {
      details?: { error?: string };
    };

    expect(result.details?.error).toBe("not_found");
    const reloaded = factsDb.getById(otherAgentFact.id);
    expect(reloaded?.scope).toBe("agent");
    expect(reloaded?.scopeTarget).toBe("agent-2");
  });
});

describe("memory_store supersedes cross-scope isolation", () => {
  it("does not supersede a fact owned by a different agent scope", async () => {
    const otherAgentFact = factsDb.store({
      text: "Agent-2's fact that should survive",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "agent",
      scopeTarget: "agent-2",
    });

    const api = setupToolsAs("agent-1");
    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-1", {
      text: "Agent-1 attempting cross-scope supersede",
      importance: 0.6,
      scope: "agent",
      scopeTarget: "agent-1",
      supersedes: otherAgentFact.id,
    })) as { details?: { superseded?: string } };

    expect(result.details?.superseded).toBeUndefined();
    const reloaded = factsDb.getById(otherAgentFact.id);
    expect(reloaded?.supersededAt ?? null).toBeNull();
  });
});
