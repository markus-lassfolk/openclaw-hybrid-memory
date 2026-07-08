// @ts-nocheck — registerMemoryTools uses `ClawdbotPluginApi` from `openclaw`, not available in
// the test environment; consistent with the pattern in memory-forget-promote-vault-resolution.test.ts.
/**
 * Regression test (loop iteration 30): memory_store's storeActiveCanonicalVector wrapper ignored
 * the caller's `vault` parameter — it always wrote the fact's embedding into the plugin's
 * *default*-vault LanceDB (closed over once at plugin init), even when the fact row itself was
 * correctly inserted into a named vault's SQLite DB via resolveToolVaultBackends. This silently
 * broke vault isolation: a fact stored in a named vault could never be found by semantic/hybrid
 * recall from that same vault (only keyword/FTS still worked), while the default vault's LanceDB
 * accumulated an orphan vector tied to a factId that doesn't exist in its own facts.db.
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
  tmpDir = mkdtempSync(join(tmpdir(), "memory-store-vault-vector-"));
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
  const defaultVectorDb = makeMockVectorDb();
  const workVectorDb = makeMockVectorDb();
  registerMemoryTools(
    {
      factsDb: defaultFactsDb as never,
      edictStore: null as never,
      vectorDb: defaultVectorDb as never,
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
        vectorDb: name === "work" ? workVectorDb : defaultVectorDb,
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
  return { api, defaultVectorDb, workVectorDb };
}

describe("memory_store vault vector isolation (loop iteration 30 regression)", () => {
  it("stores the embedding in the named vault's vectorDb, not the default vault's", async () => {
    const { api, defaultVectorDb, workVectorDb } = setupTools();
    const storeTool = api.getTool("memory_store");

    await storeTool?.execute("call-vault-store", {
      text: "Work vault deployment note that is long enough to embed.",
      importance: 0.6,
      vault: "work",
    });

    expect(workVectorDb.store).toHaveBeenCalled();
    expect(defaultVectorDb.store).not.toHaveBeenCalled();
  });

  it("stores the embedding in the default vault's vectorDb when no vault is given", async () => {
    const { api, defaultVectorDb, workVectorDb } = setupTools();
    const storeTool = api.getTool("memory_store");

    await storeTool?.execute("call-default-store", {
      text: "Default vault note that is long enough to embed.",
      importance: 0.6,
    });

    expect(defaultVectorDb.store).toHaveBeenCalled();
    expect(workVectorDb.store).not.toHaveBeenCalled();
  });
});
