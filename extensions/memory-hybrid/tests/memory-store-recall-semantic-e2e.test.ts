/**
 * End-to-end tests for memory_store/memory_recall through the real agent-tool-contract layer,
 * using a deterministic, semantically-meaningful embedding instead of the constant-vector stand-ins
 * every other e2e file uses (e.g. `new Array(DIM).fill(0.1)`). With identical vectors for every
 * fact, ranking is undefined — these tests exercise the actual embed -> index -> ANN-search ->
 * rank pipeline with vectors that genuinely differ by content, so a wrong ranking would fail here
 * even though it can't fail against a constant-vector mock.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";
import { registerTools } from "../setup/register-tools.js";

const { FactsDB, VectorDB, findSimilarByEmbedding } = _testing;

const EMBEDDING_DIM = 32;

/** Deterministic bag-of-words embedding: texts sharing more words get closer (higher cosine
 * similarity) vectors. Not a real semantic model, but genuinely non-constant — it exercises the
 * real ranking mechanics (closer vector -> ranks higher) that a constant-vector mock cannot. */
function textToEmbedding(text: string): number[] {
  const vec = new Array(EMBEDDING_DIM).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
    vec[hash % EMBEDDING_DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function makeSemanticEmbeddings() {
  return {
    embed: vi.fn(async (text: string) => textToEmbedding(text)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map((t) => textToEmbedding(t))),
    dimensions: EMBEDDING_DIM,
    modelName: "test-bow-embedding",
    activeProvider: "test",
  };
}

function makeMockApi() {
  let registeredService: { stop?: () => unknown } | null = null;
  const tools = new Map<string, { execute: (...args: unknown[]) => unknown }>();
  return {
    registerTool(opts: Record<string, unknown>, _options?: unknown) {
      tools.set(opts.name as string, { execute: opts.execute as (...args: unknown[]) => unknown });
    },
    getTool(name: string) {
      return tools.get(name);
    },
    registerService: vi.fn((svc) => {
      registeredService = svc;
    }),
    _stopRegisteredService: async () => {
      const serviceToStop = registeredService;
      registeredService = null;
      await serviceToStop?.stop?.();
    },
    registerCli: vi.fn(),
    registerLifecycleHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    context: { sessionId: "e2e-semantic-session", agentId: "e2e-semantic-agent" },
    config: {},
  };
}

function getMinimalConfig(overrides: Record<string, unknown> = {}) {
  return hybridConfigSchema.parse({
    embedding: {
      apiKey: "sk-test-key-that-is-long-enough-to-pass",
      model: "text-embedding-3-small",
    },
    ...overrides,
  });
}

function buildE2EContext(opts: {
  tmpDir: string;
  factsDb: InstanceType<typeof FactsDB>;
  vectorDb: InstanceType<typeof VectorDB>;
  cfg: ReturnType<typeof getMinimalConfig>;
}) {
  const { tmpDir, factsDb, vectorDb, cfg } = opts;
  return {
    factsDb,
    vectorDb,
    cfg,
    embeddings: makeSemanticEmbeddings(),
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
    currentAgentIdRef: { value: "e2e-semantic-agent" },
    pendingLLMWarnings: { drain: vi.fn().mockReturnValue([]) },
    resolvedSqlitePath: join(tmpDir, "facts.db"),
    timers: { proposalsPruneTimer: { value: null as ReturnType<typeof setInterval> | null } },
    buildToolScopeFilter: () => undefined,
    walWrite: async () => "wal-id",
    walRemove: async () => undefined,
    findSimilarByEmbedding,
    runReflection: vi.fn().mockResolvedValue({ patterns: [], meta: {} }),
    runReflectionRules: vi.fn().mockResolvedValue({ patterns: [] }),
    runReflectionMeta: vi.fn().mockResolvedValue({}),
    pythonBridge: null,
  };
}

describe("Semantic recall ranking e2e (real FactsDB + VectorDB, non-constant embeddings)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;
  let api: ReturnType<typeof makeMockApi>;
  let cfg: ReturnType<typeof getMinimalConfig>;

  const dbFact = "The production database server uses PostgreSQL fifteen with streaming replication";
  const deployFact = "Deployments go through a blue green rollout with canary traffic shifting";
  const coffeeFact = "The office coffee machine needs descaling every month or it clogs";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-semantic-e2e-"));
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

  afterEach(async () => {
    vectorDb.close();
    factsDb.close();
    await api._stopRegisteredService?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function storeThreeTopics() {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg }) as never, api as never);
    const storeTool = api.getTool("memory_store");
    await storeTool?.execute("s1", { text: dbFact, importance: 0.7, category: "fact" });
    await storeTool?.execute("s2", { text: deployFact, importance: 0.7, category: "fact" });
    await storeTool?.execute("s3", { text: coffeeFact, importance: 0.7, category: "fact" });
  }

  it("ranks the topically-relevant fact first among three unrelated facts", async () => {
    await storeThreeTopics();
    const recallTool = api.getTool("memory_recall");

    const dbResult = (await recallTool?.execute("r1", {
      query: "postgres database replication server",
      limit: 3,
    })) as { details?: { memories?: { text: string }[] } };
    expect(dbResult.details?.memories?.[0]?.text).toBe(dbFact);

    const deployResult = (await recallTool?.execute("r2", {
      query: "blue green deployment canary rollout",
      limit: 3,
    })) as { details?: { memories?: { text: string }[] } };
    expect(deployResult.details?.memories?.[0]?.text).toBe(deployFact);
  });

  it("does not rank an unrelated fact above the topically-relevant one (QA follow-up)", async () => {
    await storeThreeTopics();
    const recallTool = api.getTool("memory_recall");

    const result = (await recallTool?.execute("r3", { query: "database server replication", limit: 3 })) as {
      details?: { memories?: { text: string }[] };
    };
    const memories = result.details?.memories ?? [];
    const dbRank = memories.findIndex((m) => m.text === dbFact);
    const coffeeRank = memories.findIndex((m) => m.text === coffeeFact);
    expect(dbRank).toBeGreaterThanOrEqual(0);
    // The unrelated coffee fact must never outrank the topically relevant one, whether or not it
    // appears in the result set at all.
    if (coffeeRank !== -1) expect(dbRank).toBeLessThan(coffeeRank);
  });

  it("full round trip: store -> semantic recall finds it -> forget -> recall no longer finds it", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg }) as never, api as never);
    const storeTool = api.getTool("memory_store");
    const recallTool = api.getTool("memory_recall");
    const forgetTool = api.getTool("memory_forget");

    const text = "The billing service retries failed webhook deliveries with exponential backoff";
    const storeResult = (await storeTool?.execute("s1", {
      text,
      importance: 0.8,
      category: "fact",
    })) as { details?: { id?: string } };
    const factId = storeResult.details?.id;
    expect(factId).toBeDefined();

    const foundResult = (await recallTool?.execute("r1", {
      query: "webhook retry exponential backoff",
      limit: 5,
    })) as { details?: { memories?: { id: string; text: string }[] } };
    expect(foundResult.details?.memories?.some((m) => m.id === factId)).toBe(true);

    await forgetTool?.execute("f1", { memoryId: factId });

    const afterForgetResult = (await recallTool?.execute("r2", {
      query: "webhook retry exponential backoff",
      limit: 5,
    })) as { details?: { memories?: { id: string }[] } };
    expect(afterForgetResult.details?.memories?.some((m) => m.id === factId) ?? false).toBe(false);

    const vectorIds = await vectorDb.getAllIds();
    expect(vectorIds).not.toContain(factId);
  });

  it("memory_record_episode then memory_search_episodes round trip finds the recorded episode", async () => {
    registerTools(buildE2EContext({ tmpDir, factsDb, vectorDb, cfg }) as never, api as never);
    const recordTool = api.getTool("memory_record_episode");
    const searchTool = api.getTool("memory_search_episodes");

    const event = "Deployed hybrid-memory v2026.7.216 to production";
    const recordResult = (await recordTool?.execute("e1", {
      event,
      outcome: "success",
      context: "Routine release, no incidents",
    })) as { details?: { episode?: { id: string; event: string } } };
    expect(recordResult.details?.episode?.id).toBeDefined();

    const searchResult = (await searchTool?.execute("e2", {
      query: "deployed hybrid-memory",
      outcome: ["success"],
      limit: 10,
    })) as { details?: { found: number; episodes?: { id: string; event: string }[] } };
    expect(searchResult.details?.found).toBeGreaterThanOrEqual(1);
    expect(searchResult.details?.episodes?.some((e) => e.id === recordResult.details?.episode?.id)).toBe(true);
  });
});
