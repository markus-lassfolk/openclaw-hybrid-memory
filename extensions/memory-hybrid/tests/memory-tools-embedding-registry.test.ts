// @ts-nocheck
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/retrieval-orchestrator.js", () => ({
  buildExplicitSemanticQueryVector: vi.fn().mockResolvedValue({
    queryVector: [0.1, 0.2, 0.3, 0.4],
    warning: null,
  }),
  runRetrievalPipeline: vi.fn().mockResolvedValue({
    fused: [],
    packed: [],
    packedFactIds: [],
    entries: [],
  }),
  runExplicitDeepRetrieval: vi.fn().mockResolvedValue({
    fused: [],
    packed: [],
    packedFactIds: [],
    entries: [],
  }),
}));

import { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { hybridConfigSchema } from "../config.js";
import { createPendingLLMWarnings } from "../services/chat.js";
import { buildEmbeddingRegistry } from "../services/embedding-registry.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import { runExplicitDeepRetrieval } from "../services/retrieval-orchestrator.js";
import { registerMemoryTools } from "../tools/memory-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockApi() {
  const tools: Map<string, { opts: Record<string, unknown>; execute: (...args: unknown[]) => unknown }> = new Map();
  return {
    registerTool(opts: Record<string, unknown>, _options?: Record<string, unknown>) {
      tools.set(opts.name as string, { opts, execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    getToolNames() {
      return [...tools.keys()];
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session" },
  };
}

function makeCfg(overrides: Record<string, unknown> = {}) {
  return hybridConfigSchema.parse({
    embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
    store: { classifyBeforeWrite: false },
    graph: { enabled: false },
    queryExpansion: { enabled: false },
    ...overrides,
  });
}

function makeMockEmbeddings(): EmbeddingProvider {
  return {
    modelName: "text-embedding-3-small",
    dimensions: 4,
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
    embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
  };
}

function makeMockVectorDb(): VectorDB {
  return {
    hasDuplicate: vi.fn().mockResolvedValue(false),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
  } as unknown as VectorDB;
}

const noopScopeFilter = () => undefined;
const walWrite = async () => "wal-id";
const walRemove = async () => {};
const findSimilarByEmbedding = async () => [];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-tools-embed-registry-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory tools embedding registry wiring", () => {
  it("registers provider-safe episodic and edict tool names (no dots)", () => {
    const api = makeMockApi();
    const embeddings = makeMockEmbeddings();
    const embeddingRegistry = buildEmbeddingRegistry(embeddings, embeddings.modelName, []);
    const cfg = makeCfg();
    const vectorDb = makeMockVectorDb();

    registerMemoryTools(
      {
        factsDb,
        vectorDb,
        cfg,
        embeddings,
        embeddingRegistry,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: null },
        pendingLLMWarnings: createPendingLLMWarnings(),
      },
      api as never,
      noopScopeFilter as never,
      walWrite,
      walRemove,
      findSimilarByEmbedding as never,
    );

    const names = api.getToolNames();
    expect(names).toContain("memory_record_episode");
    expect(names).toContain("memory_search_episodes");
    expect(names).toContain("memory_add_edict");
    expect(names).toContain("memory_list_edicts");
    expect(names).toContain("memory_get_edicts");
    expect(names).toContain("memory_update_edict");
    expect(names).toContain("memory_remove_edict");
    expect(names).toContain("memory_edict_stats");
    expect(names.every((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name))).toBe(true);
  });

  it("passes embeddingRegistry to runRetrievalPipeline", async () => {
    const api = makeMockApi();
    const embeddings = makeMockEmbeddings();
    const embeddingRegistry = buildEmbeddingRegistry(embeddings, embeddings.modelName, []);
    const cfg = makeCfg();
    const vectorDb = makeMockVectorDb();

    registerMemoryTools(
      {
        factsDb,
        vectorDb,
        cfg,
        embeddings,
        embeddingRegistry,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: null },
        pendingLLMWarnings: createPendingLLMWarnings(),
      },
      api as never,
      noopScopeFilter as never,
      walWrite,
      walRemove,
      findSimilarByEmbedding as never,
    );

    const tool = api.getTool("memory_recall");
    expect(tool).toBeTruthy();
    await tool?.execute("tool-call", { query: "where is the API key stored", limit: 5 });

    const runMock = vi.mocked(runExplicitDeepRetrieval);
    expect(runMock).toHaveBeenCalled();
    const call = runMock.mock.calls[0];
    expect(call[5]?.embeddingRegistry).toBe(embeddingRegistry);
    expect(call[5]?.factsDbForEmbeddings).toBe(factsDb);
  });

  it("stores embeddings for all registered models", async () => {
    const api = makeMockApi();
    const embeddings = makeMockEmbeddings();
    const embeddingRegistry = buildEmbeddingRegistry(embeddings, embeddings.modelName, [
      { name: "nomic-embed-text", provider: "ollama", dimensions: 3, role: "domain" },
    ]);
    const cfg = makeCfg();
    const vectorDb = makeMockVectorDb();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ embeddings: [[0.9, 0.1, 0.2]] }),
      text: async () => "",
    } as Response);
    vi.stubGlobal("fetch", mockFetch);

    registerMemoryTools(
      {
        factsDb,
        vectorDb,
        cfg,
        embeddings,
        embeddingRegistry,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: null },
        pendingLLMWarnings: createPendingLLMWarnings(),
      },
      api as never,
      noopScopeFilter as never,
      walWrite,
      walRemove,
      findSimilarByEmbedding as never,
    );

    const tool = api.getTool("memory_store");
    expect(tool).toBeTruthy();
    const result = await tool?.execute("tool-call", { text: "hello", category: "fact", importance: 0.6 });
    const id = (result as { details?: { id?: string } }).details?.id;
    expect(id).toBeTruthy();

    const stored = factsDb.getEmbeddings(id!);
    const models = stored.map((r) => r.model).sort();
    expect(models).toEqual(["nomic-embed-text", "text-embedding-3-small"]);
  });
});
