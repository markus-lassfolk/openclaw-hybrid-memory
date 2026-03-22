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
      packedFactIds: ["fact-1"],
      filterKey: "test",
    });

    const match = await vectorDb.getSemanticQueryCacheMatch([1, 0, 0], {
      filterKey: "test",
      minSimilarity: 0.95,
      ttlMs: 60_000,
    });

    expect(match?.factIds).toEqual(["fact-1", "fact-2"]);
    expect(match?.packedFactIds).toEqual(["fact-1"]);
  });

  it("ignores expired semantic cache entries", async () => {
    await vectorDb.storeSemanticQueryCache({
      queryText: "stale query",
      vector: [1, 0, 0],
      factIds: ["fact-1"],
      packedFactIds: ["fact-1"],
      filterKey: "test",
      cachedAt: Math.floor(Date.now() / 1000) - 600,
    });

    const match = await vectorDb.getSemanticQueryCacheMatch([1, 0, 0], {
      filterKey: "test",
      ttlMs: 1_000,
    });

    expect(match).toBeNull();
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
        packedFactIds: [stored.id],
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
});
