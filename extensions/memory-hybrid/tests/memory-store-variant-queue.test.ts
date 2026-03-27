/**
 * Integration test: memory_store enqueues contextual variant generation (Issue #159).
 *
 * Tests that:
 * - Storing a fact with contextualVariants.enabled enqueues variant generation
 * - Generated variants are persisted via factsDb.storeVariant (via the queue callback)
 * - When variantQueue is null (disabled), no variants are generated
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _testing } from "../index.js";
import { ContextualVariantGenerator, VariantGenerationQueue } from "../services/contextual-variants.js";
import { registerMemoryTools } from "../tools/memory-tools.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockApi() {
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>, _options?: unknown) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "test-session-variant", agentId: "test-agent" },
  };
}

function makeMockVectorDb() {
  return {
    hasDuplicate: vi.fn().mockResolvedValue(false),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  };
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([]),
    dimensions: 384,
    modelName: "mock-model",
  };
}

/** Mock OpenAI that returns a JSON array of variant strings. */
function makeMockOpenAI(responseText: string) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: responseText } }],
        }),
      },
    },
  };
}

function makeBaseCfg() {
  return {
    captureMaxChars: 2000,
    categories: ["fact", "preference", "technical"],
    store: { classifyBeforeWrite: false },
    multiAgent: {
      orchestratorId: "main",
      defaultStoreScope: "global",
      strictAgentScoping: false,
    },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memory-store-variant-queue-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("memory_store — variant queue integration (Issue #159)", () => {
  it("enqueues variant generation after storing a fact and persists variants in factsDb", async () => {
    const api = makeMockApi();
    const vectorDb = makeMockVectorDb();
    const embeddings = makeMockEmbeddings();
    const cfg = makeBaseCfg();

    const variantsCfg = {
      enabled: true,
      maxVariantsPerFact: 2,
      maxPerMinute: 30,
    };

    const openai = makeMockOpenAI('["smart home server", "home automation infrastructure"]');
    const variantGenerator = new ContextualVariantGenerator(variantsCfg, openai as never);
    const variantQueue = new VariantGenerationQueue(variantGenerator, async (factId, variantType, variants) => {
      for (const v of variants) {
        factsDb.storeVariant(factId, variantType, v);
      }
    });

    registerMemoryTools(
      {
        factsDb: factsDb as never,
        vectorDb: vectorDb as never,
        cfg: cfg as never,
        embeddings: embeddings as never,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: "test-agent" },
        pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
        aliasDb: null,
        variantQueue,
      },
      api as never,
      (_params, _currentAgent, _cfg) => undefined,
      (_op, _data, _logger) => "wal-id",
      (_id, _logger) => undefined,
      async (_vdb, _fdb, _vec, _limit) => [],
    );

    const storeTool = api.getTool("memory_store");
    expect(storeTool).toBeDefined();

    const result = (await storeTool?.execute("call-1", {
      text: "HA runs on Proxmox VM 100 at 192.168.1.212",
      importance: 0.8,
      category: "technical",
    })) as { details: { id: string } };

    const factId = result.details.id;
    expect(factId).toBeTruthy();

    // Wait for the background queue to process
    await new Promise((r) => setTimeout(r, 150));

    const variants = factsDb.getVariants(factId);
    // Both contextual-means and contextual-search should have been generated
    expect(variants.length).toBeGreaterThan(0);
    const variantTypes = variants.map((v) => v.variantType);
    expect(variantTypes).toContain("contextual-means");
    expect(variantTypes).toContain("contextual-search");
  });

  it("stores no variants when variantQueue is null (disabled)", async () => {
    const api = makeMockApi();
    const vectorDb = makeMockVectorDb();
    const embeddings = makeMockEmbeddings();
    const cfg = makeBaseCfg();

    registerMemoryTools(
      {
        factsDb: factsDb as never,
        vectorDb: vectorDb as never,
        cfg: cfg as never,
        embeddings: embeddings as never,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: "test-agent" },
        pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
        aliasDb: null,
        variantQueue: null,
      },
      api as never,
      (_params, _currentAgent, _cfg) => undefined,
      (_op, _data, _logger) => "wal-id",
      (_id, _logger) => undefined,
      async (_vdb, _fdb, _vec, _limit) => [],
    );

    const storeTool = api.getTool("memory_store");
    const result = (await storeTool?.execute("call-2", {
      text: "The user prefers dark mode",
      importance: 0.7,
      category: "preference",
    })) as { details: { id: string } };

    const factId = result.details.id;
    await new Promise((r) => setTimeout(r, 50));

    const variants = factsDb.getVariants(factId);
    expect(variants).toHaveLength(0);
  });

  it("variant generation is non-blocking — memory_store returns before variants are stored", async () => {
    const api = makeMockApi();
    const vectorDb = makeMockVectorDb();
    const embeddings = makeMockEmbeddings();
    const cfg = makeBaseCfg();

    const variantsCfg = { enabled: true, maxVariantsPerFact: 2, maxPerMinute: 30 };

    // Slow mock: adds a small delay to simulate async LLM call
    const slowOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 50));
            return { choices: [{ message: { content: '["delayed variant"]' } }] };
          }),
        },
      },
    };

    const variantGenerator = new ContextualVariantGenerator(variantsCfg, slowOpenAI as never);
    const variantQueue = new VariantGenerationQueue(variantGenerator, async (factId, variantType, variants) => {
      for (const v of variants) {
        factsDb.storeVariant(factId, variantType, v);
      }
    });

    registerMemoryTools(
      {
        factsDb: factsDb as never,
        vectorDb: vectorDb as never,
        cfg: cfg as never,
        embeddings: embeddings as never,
        openai: {} as never,
        wal: null,
        credentialsDb: null,
        eventLog: null,
        lastProgressiveIndexIds: [],
        currentAgentIdRef: { value: "test-agent" },
        pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) } as never,
        aliasDb: null,
        variantQueue,
      },
      api as never,
      (_params, _currentAgent, _cfg) => undefined,
      (_op, _data, _logger) => "wal-id",
      (_id, _logger) => undefined,
      async (_vdb, _fdb, _vec, _limit) => [],
    );

    const storeTool = api.getTool("memory_store");
    const start = Date.now();
    const result = (await storeTool?.execute("call-3", {
      text: "Non-blocking fact store",
      importance: 0.7,
    })) as { details: { id: string } };
    const elapsed = Date.now() - start;

    // memory_store should return quickly (before the 50ms variant delay)
    expect(elapsed).toBeLessThan(200);
    expect(result.details.id).toBeTruthy();

    // After waiting, variants should be there
    await new Promise((r) => setTimeout(r, 300));
    const variants = factsDb.getVariants(result.details.id);
    expect(variants.length).toBeGreaterThan(0);
  });
});
