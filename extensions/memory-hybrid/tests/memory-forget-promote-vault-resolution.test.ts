// @ts-nocheck — registerMemoryTools uses `ClawdbotPluginApi` from `openclaw`, not available in
// the test environment; consistent with the pattern in wal-scope-payload.test.ts.
/**
 * Regression tests: memory_forget and memory_promote must resolve the caller's `vault` param the
 * same way memory_store/memory_recall/memory_pin/memory_snooze do. Before the fix, both tools
 * only ever operated on the default vault's factsDb/vectorDb, so a fact stored via
 * memory_store({vault:"work"}) could never be forgotten or promoted afterward — both silently
 * returned "not found" even though memory_recall({vault:"work"}) could find the same fact.
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
    vaults: { work: "/tmp/work.db" },
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
let defaultFactsDb: InstanceType<typeof FactsDB>;
let workFactsDb: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-vault-resolution-"));
  defaultFactsDb = new FactsDB(join(tmpDir, "default.db"));
  workFactsDb = new FactsDB(join(tmpDir, "work.db"));
});

afterEach(() => {
  defaultFactsDb.close();
  workFactsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function setupTools() {
  const api = makeMockApi();
  const workVectorDb = makeMockVectorDb();
  registerMemoryTools(
    {
      factsDb: defaultFactsDb as never,
      edictStore: null as never,
      vectorDb: makeMockVectorDb() as never,
      cfg: makeCfg() as never,
      embeddings: makeMockEmbeddings() as never,
      openai: {} as never,
      wal: null,
      credentialsDb: null,
      eventLog: null,
      lastProgressiveIndexIds: [],
      currentAgentIdRef: { value: "main" },
      pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
      aliasDb: null,
      resolveVault: (name?: string) => ({
        name: name ?? "default",
        factsDb: name === "work" ? workFactsDb : defaultFactsDb,
        vectorDb: name === "work" ? workVectorDb : makeMockVectorDb(),
        sqlitePath: "",
        lancePath: "",
      }),
      resolveVaultWal: () => null,
    } as never,
    api as never,
    buildToolScopeFilter,
    async () => "wal-id",
    async () => {},
    async () => [],
  );
  return api;
}

describe("memory_forget vault resolution", () => {
  it("deletes a fact stored in a named vault when vault is specified", async () => {
    const workFact = workFactsDb.store({
      text: "Work vault fact",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const api = setupTools();
    const tool = api.getTool("memory_forget");
    const result = (await tool?.execute("call-1", { memoryId: workFact.id, vault: "work" })) as {
      details?: { action?: string };
    };

    expect(result.details?.action).toBe("deleted");
    expect(workFactsDb.getById(workFact.id)).toBeNull();
  });

  it("does not find a named-vault fact when no vault param is given (default vault only)", async () => {
    const workFact = workFactsDb.store({
      text: "Work vault fact, untouched by default-vault forget",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const api = setupTools();
    const tool = api.getTool("memory_forget");
    const result = (await tool?.execute("call-1", { memoryId: workFact.id })) as { details?: { action?: string } };

    expect(result.details?.action).toBe("not_found");
    // The work-vault fact must be untouched.
    expect(workFactsDb.getById(workFact.id)).not.toBeNull();
  });
});

describe("memory_promote vault resolution", () => {
  it("promotes a fact stored in a named vault when vault is specified", async () => {
    const workFact = workFactsDb.store({
      text: "Work vault session fact",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
      scope: "session",
      scopeTarget: "sess-1",
    });

    const api = setupTools();
    const tool = api.getTool("memory_promote");
    const result = (await tool?.execute("call-1", {
      memoryId: workFact.id,
      scope: "global",
      vault: "work",
    })) as { details?: { action?: string } };

    expect(result.details?.action).toBe("promoted");
    expect(workFactsDb.getById(workFact.id)?.scope).toBe("global");
  });
});
