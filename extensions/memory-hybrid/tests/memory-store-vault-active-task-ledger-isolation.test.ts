// @ts-nocheck — registerMemoryTools uses `ClawdbotPluginApi` from `openclaw`, not available in
// the test environment; consistent with the pattern in memory-store-vault-vector-isolation.test.ts.
/**
 * Regression test (loop iteration 68): register-store-tools.ts's syncProjectStoreToActiveTaskLedger
 * wrapper always closed over the plugin's *default*-vault factsDb/vectorDb (captured once at
 * registerStoreTools() init), even when memory_store's own fact write correctly went to a named
 * vault via resolveToolVaultBackends. A `memory_store` call with category "project" and a
 * ledger-tracked key (e.g. "next") targeting a named vault would mirror its active-task ledger
 * fact into the *default* vault's FactsDB instead of the named vault's — silently splitting the
 * project-task ledger across vaults and leaving the named vault's own ledger view incomplete.
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
    categories: ["fact", "preference", "decision", "project"],
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
    // Enables the active-task ledger mirror path under test (mirrorMemoryStoreToActiveTaskLedger
    // requires activeTask.enabled && activeTask.ledger === "facts").
    activeTask: { enabled: true, ledger: "facts", filePath: "ACTIVE-TASKS.md" },
  };
}

let tmpDir: string;
let defaultFactsDb: InstanceType<typeof FactsDB>;
let workFactsDb: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-store-vault-ledger-"));
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
  return { api };
}

describe("memory_store vault active-task-ledger isolation (loop iteration 68 regression)", () => {
  it("mirrors the active-task ledger fact into the named vault's factsDb, not the default vault's", async () => {
    const { api } = setupTools();
    const storeTool = api.getTool("memory_store");

    await storeTool?.execute("call-vault-ledger-store", {
      text: "Project task next-step note.",
      importance: 0.6,
      vault: "work",
      category: "project",
      entity: "work-vault-task",
      key: "next",
      value: "Run the deploy script",
      scope: "global",
    });

    const workLedgerFact = workFactsDb
      .list(20, {})
      .find((f) => f.entity === "work-vault-task" && f.key === "next" && f.source === "active-task");
    const defaultLedgerFact = defaultFactsDb
      .list(20, {})
      .find((f) => f.entity === "work-vault-task" && f.key === "next" && f.source === "active-task");

    expect(workLedgerFact).toBeDefined();
    expect(workLedgerFact?.value).toBe("Run the deploy script");
    expect(defaultLedgerFact).toBeUndefined();
  });

  it("mirrors the active-task ledger fact into the default vault's factsDb when no vault is given", async () => {
    const { api } = setupTools();
    const storeTool = api.getTool("memory_store");

    await storeTool?.execute("call-default-ledger-store", {
      text: "Project task next-step note.",
      importance: 0.6,
      category: "project",
      entity: "default-vault-task",
      key: "next",
      value: "Ship the release",
      scope: "global",
    });

    const defaultLedgerFact = defaultFactsDb
      .list(20, {})
      .find((f) => f.entity === "default-vault-task" && f.key === "next" && f.source === "active-task");
    const workLedgerFact = workFactsDb
      .list(20, {})
      .find((f) => f.entity === "default-vault-task" && f.key === "next" && f.source === "active-task");

    expect(defaultLedgerFact).toBeDefined();
    expect(defaultLedgerFact?.value).toBe("Ship the release");
    expect(workLedgerFact).toBeUndefined();
  });
});
