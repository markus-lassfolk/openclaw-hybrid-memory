import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { VectorDB } from "../backends/vector-db.js";
import { _testing } from "../index.js";
import { runRetrievalPipeline, DEFAULT_RETRIEVAL_CONFIG } from "../services/retrieval-orchestrator.js";
import { validateQueryForMemoryLookup } from "../services/query-validator.js";

const { FactsDB } = _testing;

describe("validateQueryForMemoryLookup", () => {
  it("rejects obvious conversational filler", () => {
    expect(validateQueryForMemoryLookup("thanks!")).toEqual({
      requiresLookup: false,
      reason: "conversational-filler",
    });
  });

  it("allows likely memory lookup queries", () => {
    expect(validateQueryForMemoryLookup("where is the API key stored")).toEqual({
      requiresLookup: true,
      reason: "memory-lookup-candidate",
    });
  });
});

describe("VectorDB semantic query cache", () => {
  let tmpDir: string;
  let vectorDb: VectorDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "semantic-query-cache-"));
    vectorDb = new VectorDB(join(tmpDir, "lance"), 3);
  });

  afterEach(() => {
    vectorDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves semantic cache entries by similarity", async () => {
    await vectorDb.storeSemanticQueryCache({
      queryText: "where is the api key stored",
      vector: [1, 0, 0],
      factIds: ["fact-1", "fact-2"],
      filterKey: "test",
    });

    const match = await vectorDb.getSemanticQueryCacheMatch([1, 0, 0], {
      filterKey: "test",
      minSimilarity: 0.95,
      ttlMs: 60_000,
    });

    expect(match?.factIds).toEqual(["fact-1", "fact-2"]);
  });

  it("ignores expired semantic cache entries", async () => {
    await vectorDb.storeSemanticQueryCache({
      queryText: "stale query",
      vector: [1, 0, 0],
      factIds: ["fact-1"],
      filterKey: "test",
      cachedAt: Math.floor(Date.now() / 1000) - 600,
    });

    const match = await vectorDb.getSemanticQueryCacheMatch([1, 0, 0], {
      filterKey: "test",
      ttlMs: 1_000,
    });

    expect(match).toBeNull();
  });

  it("self-heals semantic cache schema mismatches after embedding dimension changes", async () => {
    await vectorDb.storeSemanticQueryCache({
      queryText: "old dimension",
      vector: [1, 0, 0],
      factIds: ["fact-legacy"],
      filterKey: "test",
    });

    vectorDb.close();
    vectorDb = new VectorDB(join(tmpDir, "lance"), 4);

    await vectorDb.storeSemanticQueryCache({
      queryText: "new dimension",
      vector: [0, 0, 0, 1],
      factIds: ["fact-new"],
      filterKey: "test",
    });

    const match = await vectorDb.getSemanticQueryCacheMatch([0, 0, 0, 1], {
      filterKey: "test",
      minSimilarity: 0.95,
      ttlMs: 60_000,
    });

    expect(match?.factIds).toEqual(["fact-new"]);
  });

  it("caps semantic cache growth per filter key", async () => {
    const baseCachedAt = Math.floor(Date.now() / 1000);

    for (let index = 0; index < 105; index++) {
      await vectorDb.storeSemanticQueryCache({
        queryText: `query-${index}`,
        vector: [1, 0, 0],
        factIds: [`fact-${index}`],
        filterKey: "bounded",
        cachedAt: baseCachedAt + index,
      });
    }

    const cacheTable = (vectorDb as any).getSemanticQueryCacheTable();
    const rows = await cacheTable.query().where("filterKey = 'bounded'").select(["cachedAt"]).toArray();
    const cachedAtValues = rows.map((row: { cachedAt: number }) => Number(row.cachedAt)).sort((a, b) => a - b);

    expect(rows.length).toBeLessThanOrEqual(100);
    expect(cachedAtValues[0]).toBe(baseCachedAt + 5);
    expect(cachedAtValues.at(-1)).toBe(baseCachedAt + 104);
  });
});

describe("runRetrievalPipeline production RAG additions", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "production-rag-test-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns cached semantic results before retrieval strategies run", async () => {
    const stored = factsDb.store({
      text: "The API key is in config.yml",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const vectorDb = {
      search: vi.fn(),
      getSemanticQueryCacheMatch: vi.fn().mockResolvedValue({
        factIds: [stored.id],
        similarity: 0.99,
      }),
      storeSemanticQueryCache: vi.fn(),
    } as unknown as VectorDB;

    const result = await runRetrievalPipeline("where is my api key", [1, 0, 0], factsDb.getRawDb(), vectorDb, factsDb, {
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["semantic", "fts5"] },
    });

    expect(result.fused[0]?.factId).toBe(stored.id);
    expect(vectorDb.search as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(vectorDb.storeSemanticQueryCache as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rewrites the query when all graded documents are irrelevant", async () => {
    const apple = factsDb.store({
      text: "Apple is a fruit",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const banana = factsDb.store({
      text: "Banana is yellow",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const grader = {
      gradeDocuments: vi
        .fn()
        .mockResolvedValueOnce([{ factId: apple.id, answer: "no", relevant: false }])
        .mockResolvedValueOnce([{ factId: banana.id, answer: "yes", relevant: true }]),
      rewriteQuery: vi.fn().mockResolvedValue("banana"),
    };

    const vectorDb = {
      search: vi.fn(),
      getSemanticQueryCacheMatch: vi.fn().mockResolvedValue(null),
      storeSemanticQueryCache: vi.fn(),
    } as unknown as VectorDB;

    const result = await runRetrievalPipeline("apple", null, factsDb.getRawDb(), vectorDb, factsDb, {
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["fts5"] },
      documentGrader: grader as never,
    });

    expect(result.fused[0]?.factId).toBe(banana.id);
    expect(grader.rewriteQuery).toHaveBeenCalledTimes(1);
  });

  it("prefers fewer relevant rewritten results over larger irrelevant result sets", async () => {
    const apple = factsDb.store({
      text: "Apple is a fruit",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    factsDb.store({
      text: "Apple pie uses cinnamon",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const banana = factsDb.store({
      text: "Banana bread recipe",
      category: "fact",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const grader = {
      gradeDocuments: vi
        .fn()
        .mockResolvedValueOnce([
          { factId: apple.id, answer: "no", relevant: false },
          { factId: banana.id, answer: "no", relevant: false },
        ])
        .mockResolvedValueOnce([{ factId: banana.id, answer: "yes", relevant: true }]),
      rewriteQuery: vi.fn().mockResolvedValue("banana bread"),
    };

    const vectorDb = {
      search: vi.fn(),
      getSemanticQueryCacheMatch: vi.fn().mockResolvedValue(null),
      storeSemanticQueryCache: vi.fn(),
    } as unknown as VectorDB;

    const result = await runRetrievalPipeline("apple", null, factsDb.getRawDb(), vectorDb, factsDb, {
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["fts5"], fts5TopK: 10 },
      documentGrader: grader as never,
    });

    expect(result.fused).toHaveLength(1);
    expect(result.fused[0]?.factId).toBe(banana.id);
  });

  it("uses distinct semantic cache keys when grading-related behavior changes", async () => {
    const vectorDb = {
      search: vi.fn().mockResolvedValue([]),
      getSemanticQueryCacheMatch: vi.fn().mockResolvedValue(null),
      storeSemanticQueryCache: vi.fn(),
    } as unknown as VectorDB;

    await runRetrievalPipeline("query", [1, 0, 0], factsDb.getRawDb(), vectorDb, factsDb, {
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["fts5"] },
      documentGradingConfig: { enabled: false, timeoutMs: 10_000 },
    });

    await runRetrievalPipeline("query", [1, 0, 0], factsDb.getRawDb(), vectorDb, factsDb, {
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["fts5"] },
      documentGradingConfig: { enabled: true, model: "openai/gpt-4.1-nano", timeoutMs: 5_000 },
      adaptiveOpenai: {} as never,
      rerankingConfig: { enabled: true, candidateCount: 5, outputCount: 3, timeoutMs: 5_000 },
      rerankingOpenai: {} as never,
      aliasDb: {} as never,
      queryExpander: {
        getMode: () => "conditional",
        getThreshold: () => 0.12,
      } as never,
      queryExpansionContext: "recent conversation context",
      embeddingRegistry: {
        getPrimaryModel: () => ({ name: "text-embedding-3-small", provider: "OpenAI", dimensions: 1536 }),
        getModels: () => [{ name: "nomic-embed-text", provider: "ollama", dimensions: 768, role: "domain" }],
        isMultiModel: () => true,
      } as never,
      factsDbForEmbeddings: {} as never,
    });

    const lookupCalls = (vectorDb.getSemanticQueryCacheMatch as ReturnType<typeof vi.fn>).mock.calls;
    expect(lookupCalls[0]?.[1]?.filterKey).not.toBe(lookupCalls[1]?.[1]?.filterKey);
  });
});
