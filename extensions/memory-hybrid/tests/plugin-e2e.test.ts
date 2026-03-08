/**
 * End-to-end tests for full plugin functionality verification.
 *
 * Ensures:
 * - Plugin registration succeeds and core tools are registered
 * - Store → recall by id → recall by query flow works with real FactsDB + VectorDB
 * - No surprises: expected response shapes and persistence across tool calls
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import memoryHybridPlugin from "../index.js";
import { registerTools } from "../setup/register-tools.js";
import { initializeDatabases, closeOldDatabases } from "../setup/init-databases.js";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";

const { FactsDB, VectorDB, findSimilarByEmbedding } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMBEDDING_DIM = 1536; // text-embedding-3-small

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>, _options?: unknown) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    registerService: vi.fn(),
    registerCli: vi.fn(),
    registerLifecycleHook: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "e2e-session", agentId: "e2e-agent" },
    config: {},
  };
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue(new Array(EMBEDDING_DIM).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([]),
    dimensions: EMBEDDING_DIM,
    modelName: "text-embedding-3-small",
    activeProvider: "openai",
  };
}

/** Minimal valid config (same as config.test.ts validBase). */
function getMinimalConfig(overrides: Record<string, unknown> = {}) {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. Plugin registration e2e: register() succeeds and core tools are present
// ---------------------------------------------------------------------------

describe("Plugin registration e2e", () => {
  let tmpDir: string;
  let api: ReturnType<typeof makeMockApi>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-e2e-reg-"));
    api = makeMockApi();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("register() does not throw and core memory tools are registered", () => {
    const pluginConfig = getMinimalConfig({
      sqlitePath: join(tmpDir, "facts.db"),
      lanceDbPath: join(tmpDir, "lancedb"),
    });
    const mockApi = {
      ...api,
      pluginConfig,
      resolvePath: (p: string) => (p.startsWith("/") || /^[A-Z]:/.test(p) ? p : join(tmpDir, p)),
    };
    expect(() => memoryHybridPlugin.register(mockApi as never)).not.toThrow();

    expect(mockApi.getTool("memory_store")).toBeDefined();
    expect(mockApi.getTool("memory_recall")).toBeDefined();
    expect(mockApi.getTool("memory_forget")).toBeDefined();
    expect(mockApi.getTool("memory_promote")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Store → recall (by id) → recall (by query) with real DBs and mock embeddings
// ---------------------------------------------------------------------------

describe("Store and recall e2e (real FactsDB + VectorDB, mock embeddings)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;
  let api: ReturnType<typeof makeMockApi>;
  let cfg: ReturnType<typeof getMinimalConfig>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-e2e-store-recall-"));
    const sqlitePath = join(tmpDir, "facts.db");
    const lancePath = join(tmpDir, "lancedb");
    cfg = getMinimalConfig({
      sqlitePath,
      lanceDbPath: lancePath,
      store: { fuzzyDedupe: false, classifyBeforeWrite: false },
    });
    factsDb = new FactsDB(sqlitePath, { fuzzyDedupe: false });
    vectorDb = new VectorDB(lancePath, EMBEDDING_DIM, false);
    api = makeMockApi();
  });

  afterEach(() => {
    vectorDb.close();
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memory_store then memory_recall by id returns the stored fact", async () => {
    const embeddings = makeMockEmbeddings();
    const ctx = {
      factsDb,
      vectorDb,
      cfg,
      embeddings,
      embeddingRegistry: null,
      openai: { chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [] }) } } },
      wal: null,
      credentialsDb: null,
      proposalsDb: null,
      eventLog: null,
      provenanceService: null,
      aliasDb: null,
      issueStore: null,
      workflowStore: null,
      crystallizationStore: null,
      toolProposalStore: null,
      verificationStore: null,
      variantQueue: null,
      lastProgressiveIndexIds: [] as string[],
      currentAgentIdRef: { value: "e2e-agent" },
      pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) },
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      timers: { proposalsPruneTimer: { value: null as ReturnType<typeof setInterval> | null } },
      buildToolScopeFilter: () => undefined,
      walWrite: () => "wal-id",
      walRemove: () => undefined,
      findSimilarByEmbedding,
      runReflection: vi.fn().mockResolvedValue({ patterns: [], meta: {} }),
      runReflectionRules: vi.fn().mockResolvedValue({ patterns: [] }),
      runReflectionMeta: vi.fn().mockResolvedValue({}),
      pythonBridge: null,
    };
    registerTools(ctx as never, api as never);

    const storeTool = api.getTool("memory_store");
    const recallTool = api.getTool("memory_recall");
    expect(storeTool).toBeDefined();
    expect(recallTool).toBeDefined();

    const text = "E2E test fact: server IP is 10.0.0.42";
    const storeResult = (await storeTool!.execute("call-1", {
      text,
      importance: 0.8,
      category: "fact",
    })) as { content?: { type: string; text: string }[]; details?: { id?: string; action?: string } };

    expect(storeResult.details?.id).toBeDefined();
    expect(storeResult.details?.action).toBe("created");
    const factId = storeResult.details!.id!;

    const recallByIdResult = (await recallTool!.execute("call-2", { id: factId })) as {
      content?: { type: string; text: string }[];
      details?: { count: number; memories?: { id: string; text: string }[] };
    };
    expect(recallByIdResult.details?.count).toBe(1);
    expect(recallByIdResult.details?.memories?.[0]?.text).toBe(text);
    expect(recallByIdResult.content?.[0]?.text).toContain(text);
  });

  it("memory_recall by query returns the stored fact (semantic path)", async () => {
    const embeddings = makeMockEmbeddings();
    const ctx = {
      factsDb,
      vectorDb,
      cfg,
      embeddings,
      embeddingRegistry: null,
      openai: { chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [] }) } } },
      wal: null,
      credentialsDb: null,
      proposalsDb: null,
      eventLog: null,
      provenanceService: null,
      aliasDb: null,
      issueStore: null,
      workflowStore: null,
      crystallizationStore: null,
      toolProposalStore: null,
      verificationStore: null,
      variantQueue: null,
      lastProgressiveIndexIds: [] as string[],
      currentAgentIdRef: { value: "e2e-agent" },
      pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) },
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      timers: { proposalsPruneTimer: { value: null as ReturnType<typeof setInterval> | null } },
      buildToolScopeFilter: () => undefined,
      walWrite: () => "wal-id",
      walRemove: () => undefined,
      findSimilarByEmbedding,
      runReflection: vi.fn().mockResolvedValue({ patterns: [], meta: {} }),
      runReflectionRules: vi.fn().mockResolvedValue({ patterns: [] }),
      runReflectionMeta: vi.fn().mockResolvedValue({}),
      pythonBridge: null,
    };
    registerTools(ctx as never, api as never);

    const storeTool = api.getTool("memory_store");
    const recallTool = api.getTool("memory_recall");
    const uniqueText = "E2E unique phrase: banana server port 9999";
    await storeTool!.execute("call-1", { text: uniqueText, importance: 0.9, category: "technical" });

    const recallByQueryResult = (await recallTool!.execute("call-2", {
      query: "banana server port",
      limit: 5,
    })) as { content?: { type: string; text: string }[]; details?: { count: number; memories?: { text: string }[] } };

    expect(recallByQueryResult.details?.count).toBeGreaterThanOrEqual(1);
    const texts = (recallByQueryResult.details?.memories ?? []).map((m) => m.text);
    expect(texts.some((t) => t.includes("banana server port 9999"))).toBe(true);
  });

  it("memory_forget by memoryId removes the fact", async () => {
    const embeddings = makeMockEmbeddings();
    const ctx = {
      factsDb,
      vectorDb,
      cfg,
      embeddings,
      embeddingRegistry: null,
      openai: { chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [] }) } } },
      wal: null,
      credentialsDb: null,
      proposalsDb: null,
      eventLog: null,
      provenanceService: null,
      aliasDb: null,
      issueStore: null,
      workflowStore: null,
      crystallizationStore: null,
      toolProposalStore: null,
      verificationStore: null,
      variantQueue: null,
      lastProgressiveIndexIds: [] as string[],
      currentAgentIdRef: { value: "e2e-agent" },
      pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) },
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      timers: { proposalsPruneTimer: { value: null as ReturnType<typeof setInterval> | null } },
      buildToolScopeFilter: () => undefined,
      walWrite: () => "wal-id",
      walRemove: () => undefined,
      findSimilarByEmbedding,
      runReflection: vi.fn().mockResolvedValue({ patterns: [], meta: {} }),
      runReflectionRules: vi.fn().mockResolvedValue({ patterns: [] }),
      runReflectionMeta: vi.fn().mockResolvedValue({}),
      pythonBridge: null,
    };
    registerTools(ctx as never, api as never);

    const storeTool = api.getTool("memory_store");
    const recallTool = api.getTool("memory_recall");
    const forgetTool = api.getTool("memory_forget");

    const storeResult = (await storeTool!.execute("call-1", {
      text: "To be forgotten",
      importance: 0.5,
    })) as { details?: { id: string } };
    const id = storeResult.details!.id;

    const beforeForget = (await recallTool!.execute("call-2", { id })) as { details?: { count: number } };
    expect(beforeForget.details?.count).toBe(1);

    await forgetTool!.execute("call-3", { memoryId: id });
    const afterForget = (await recallTool!.execute("call-4", { id })) as { details?: { count: number } };
    expect(afterForget.details?.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Full init-databases + register flow (no tool execution) — sanity check
// ---------------------------------------------------------------------------

describe("Init-databases e2e", () => {
  let tmpDir: string;
  let api: ReturnType<typeof makeMockApi>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plugin-e2e-init-"));
    api = makeMockApi();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializeDatabases returns all required stores and closeOldDatabases does not throw", () => {
    const pluginConfig = getMinimalConfig({
      sqlitePath: join(tmpDir, "facts.db"),
      lanceDbPath: join(tmpDir, "lancedb"),
      credentials: { enabled: false },
      wal: { enabled: false },
      personaProposals: { enabled: false },
      verification: { enabled: false },
      provenance: { enabled: false },
    });
    const mockApi = {
      ...api,
      pluginConfig,
      resolvePath: (p: string) => (p.startsWith("/") || /^[A-Z]:/.test(p) ? p : join(tmpDir, p)),
      config: {},
    };
    const ctx = initializeDatabases(pluginConfig, mockApi as never);
    expect(ctx.factsDb).toBeDefined();
    expect(ctx.vectorDb).toBeDefined();
    expect(ctx.embeddings).toBeDefined();
    expect(ctx.resolvedSqlitePath).toBe(join(tmpDir, "facts.db"));
    expect(ctx.resolvedLancePath).toBe(join(tmpDir, "lancedb"));

    expect(() =>
      closeOldDatabases({
        factsDb: ctx.factsDb,
        vectorDb: ctx.vectorDb,
        credentialsDb: ctx.credentialsDb,
        proposalsDb: ctx.proposalsDb,
        eventLog: ctx.eventLog,
        aliasDb: ctx.aliasDb,
        issueStore: ctx.issueStore,
        workflowStore: ctx.workflowStore,
        crystallizationStore: ctx.crystallizationStore,
        toolProposalStore: ctx.toolProposalStore,
        verificationStore: ctx.verificationStore,
        provenanceService: ctx.provenanceService,
      }),
    ).not.toThrow();
  });
});
