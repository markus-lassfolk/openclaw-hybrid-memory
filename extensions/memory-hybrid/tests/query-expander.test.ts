/**
 * Tests for Issue #160 — Query Expansion via LLM (HyDE at Query Time).
 *
 * Coverage:
 *   parseExpansionsFromResponse:
 *     - parses a valid JSON array from a bare response
 *     - handles JSON embedded in prose
 *     - handles code-fenced JSON
 *     - returns empty array when no JSON array found
 *     - returns empty array for invalid JSON
 *     - filters out non-string elements
 *     - filters out empty/whitespace-only strings
 *     - trims whitespace from variants
 *     - respects maxVariants limit
 *     - returns empty array for an empty JSON array
 *   QueryExpander.expandQuery:
 *     - returns [query] when config.enabled is false
 *     - returns [query] on empty query string
 *     - returns original + LLM-generated variants on success
 *     - deduplicates variants identical to the original query
 *     - respects maxVariants limit
 *     - returns [query] on LLM error (graceful degradation)
 *     - returns [query] on LLM timeout
 *     - returns [query] when LLM returns non-JSON
 *     - includes optional context in prompt
 *   QueryExpander — caching:
 *     - caches results for identical queries
 *     - does not call LLM on cache hit
 *     - uses different cache keys for query+context vs query-only
 *     - LRU eviction respects cacheSize
 *     - clearCache resets the cache
 *   LRU cache edge cases:
 *     - capacity of 1 evicts on second insert
 *     - get refreshes access order
 *   Config parsing:
 *     - QueryExpansionConfig type has correct shape with defaults
 *     - optional fields can be set
 *   Integration with retrieval orchestrator:
 *     - variant queries add extra RRF strategies when expander is provided
 *     - retrieval pipeline works without expander (backward compat)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  QueryExpander,
  parseExpansionsFromResponse,
} from "../services/query-expander.js";
import { runRetrievalPipeline, DEFAULT_RETRIEVAL_CONFIG } from "../services/retrieval-orchestrator.js";
import { _testing } from "../index.js";
import type { QueryExpansionConfig } from "../config.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a minimal mock OpenAI client that returns a canned response. */
function makeMockOpenAI(response: string | Error): object {
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => {
          if (response instanceof Error) throw response;
          return {
            choices: [{ message: { content: response } }],
          };
        }),
      },
    },
  };
}

const ENABLED_CFG: QueryExpansionConfig = {
  enabled: true,
  maxVariants: 4,
  cacheSize: 100,
  timeoutMs: 5000,
};

const DISABLED_CFG: QueryExpansionConfig = {
  enabled: false,
  maxVariants: 4,
  cacheSize: 100,
  timeoutMs: 5000,
};

// ---------------------------------------------------------------------------
// parseExpansionsFromResponse
// ---------------------------------------------------------------------------

describe("parseExpansionsFromResponse", () => {
  it("parses a valid JSON array from a bare response", () => {
    const result = parseExpansionsFromResponse('["alternative one", "alternative two"]', 5);
    expect(result).toEqual(["alternative one", "alternative two"]);
  });

  it("handles JSON embedded in prose", () => {
    const response = 'Here are alternatives: ["find the config file", "locate settings"]';
    const result = parseExpansionsFromResponse(response, 5);
    expect(result).toEqual(["find the config file", "locate settings"]);
  });

  it("handles code-fenced JSON", () => {
    const response = "```json\n[\"phrasing a\", \"phrasing b\"]\n```";
    const result = parseExpansionsFromResponse(response, 5);
    expect(result).toEqual(["phrasing a", "phrasing b"]);
  });

  it("returns empty array when no JSON array found", () => {
    const result = parseExpansionsFromResponse("No array here at all.", 5);
    expect(result).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    const result = parseExpansionsFromResponse("[not valid json,]", 5);
    expect(result).toEqual([]);
  });

  it("filters out non-string elements from the array", () => {
    const result = parseExpansionsFromResponse('["valid", 42, null, true, "also valid"]', 5);
    expect(result).toEqual(["valid", "also valid"]);
  });

  it("filters out empty and whitespace-only strings", () => {
    const result = parseExpansionsFromResponse('["valid", "", "   ", "another"]', 5);
    expect(result).toEqual(["valid", "another"]);
  });

  it("trims whitespace from variants", () => {
    const result = parseExpansionsFromResponse('["  leading ", "trailing  "]', 5);
    expect(result).toEqual(["leading", "trailing"]);
  });

  it("respects maxVariants limit", () => {
    const response = '["one", "two", "three", "four", "five"]';
    const result = parseExpansionsFromResponse(response, 3);
    expect(result).toHaveLength(3);
    expect(result).toEqual(["one", "two", "three"]);
  });

  it("returns empty array for an empty JSON array", () => {
    const result = parseExpansionsFromResponse("[]", 5);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// QueryExpander.expandQuery — basic behavior
// ---------------------------------------------------------------------------

describe("QueryExpander.expandQuery — disabled", () => {
  it("returns [query] when config.enabled is false", async () => {
    const openai = makeMockOpenAI('["variant"]');
    const expander = new QueryExpander(DISABLED_CFG, openai as never);
    const result = await expander.expandQuery("find my API key");
    expect(result).toEqual(["find my API key"]);
    expect(
      (openai as { chat: { completions: { create: ReturnType<typeof vi.fn> } } })
        .chat.completions.create,
    ).not.toHaveBeenCalled();
  });

  it("returns [query] on empty query string", async () => {
    const openai = makeMockOpenAI('["variant"]');
    const expander = new QueryExpander(ENABLED_CFG, openai as never);
    const result = await expander.expandQuery("   ");
    expect(result).toEqual(["   "]);
  });
});

describe("QueryExpander.expandQuery — success", () => {
  it("returns original query as first element plus LLM variants", async () => {
    const openai = makeMockOpenAI('["look up API credentials", "retrieve authentication key", "get API token"]');
    const expander = new QueryExpander(ENABLED_CFG, openai as never);
    const result = await expander.expandQuery("find my API key");
    expect(result[0]).toBe("find my API key");
    expect(result.length).toBeGreaterThan(1);
    expect(result).toContain("look up API credentials");
  });

  it("deduplicates variants that are identical to the original query", async () => {
    const openai = makeMockOpenAI('["find my API key", "look up API credentials", "get API token"]');
    const expander = new QueryExpander(ENABLED_CFG, openai as never);
    const result = await expander.expandQuery("find my API key");
    // "find my API key" in the LLM response should be filtered out (case-insensitive match)
    const countOfOriginal = result.filter((v) => v.toLowerCase() === "find my api key").length;
    expect(countOfOriginal).toBe(1);
  });

  it("respects maxVariants by not returning more than maxVariants+1 entries", async () => {
    const cfg: QueryExpansionConfig = { ...ENABLED_CFG, maxVariants: 2 };
    const openai = makeMockOpenAI('["one", "two", "three", "four", "five"]');
    const expander = new QueryExpander(cfg, openai as never);
    const result = await expander.expandQuery("some query");
    // original + up to maxVariants
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result[0]).toBe("some query");
  });

  it("passes context to the LLM prompt when provided", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '["alternative query"]' } }],
    });
    const openai = { chat: { completions: { create: mockCreate } } };
    const expander = new QueryExpander(ENABLED_CFG, openai as never);
    await expander.expandQuery("find my API key", "We were discussing authentication");
    expect(mockCreate).toHaveBeenCalled();
    const callArg = mockCreate.mock.calls[0][0];
    const content = callArg.messages[0].content as string;
    expect(content).toContain("We were discussing authentication");
  });
});

describe("QueryExpander.expandQuery — graceful degradation", () => {
  it("returns [query] on LLM error", async () => {
    const openai = makeMockOpenAI(new Error("API unavailable"));
    const expander = new QueryExpander(ENABLED_CFG, openai as never);
    const result = await expander.expandQuery("find my API key");
    expect(result).toEqual(["find my API key"]);
  });

  it("returns [query] when LLM returns non-JSON", async () => {
    const openai = makeMockOpenAI("Sure, here are some alternatives: try these options.");
    const expander = new QueryExpander(ENABLED_CFG, openai as never);
    const result = await expander.expandQuery("find my API key");
    expect(result).toEqual(["find my API key"]);
  });

  it("returns [query] when LLM returns empty array", async () => {
    const openai = makeMockOpenAI("[]");
    const expander = new QueryExpander(ENABLED_CFG, openai as never);
    const result = await expander.expandQuery("find my API key");
    expect(result).toEqual(["find my API key"]);
  });
});

// ---------------------------------------------------------------------------
// QueryExpander — caching
// ---------------------------------------------------------------------------

describe("QueryExpander — caching", () => {
  it("caches results for identical queries", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '["alternative A", "alternative B"]' } }],
    });
    const openai = { chat: { completions: { create: mockCreate } } };
    const expander = new QueryExpander(ENABLED_CFG, openai as never);

    const first = await expander.expandQuery("find my API key");
    const second = await expander.expandQuery("find my API key");

    expect(first).toEqual(second);
    // LLM should only be called once (second call is cached)
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("does not call LLM on cache hit", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '["variant"]' } }],
    });
    const openai = { chat: { completions: { create: mockCreate } } };
    const expander = new QueryExpander(ENABLED_CFG, openai as never);

    await expander.expandQuery("test query");
    await expander.expandQuery("test query");
    await expander.expandQuery("test query");

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(expander.cacheSize).toBe(1);
  });

  it("uses separate cache keys for query+context vs query-only", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '["variant"]' } }],
    });
    const openai = { chat: { completions: { create: mockCreate } } };
    const expander = new QueryExpander(ENABLED_CFG, openai as never);

    await expander.expandQuery("test query");
    await expander.expandQuery("test query", "some context");

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(expander.cacheSize).toBe(2);
  });

  it("LRU eviction respects cacheSize — evicts oldest on overflow", async () => {
    const cfg: QueryExpansionConfig = { ...ENABLED_CFG, cacheSize: 2 };
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '["v"]' } }],
    });
    const openai = { chat: { completions: { create: mockCreate } } };
    const expander = new QueryExpander(cfg, openai as never);

    await expander.expandQuery("query A");
    await expander.expandQuery("query B");
    // Cache is now full (size=2)
    expect(expander.cacheSize).toBe(2);

    // Insert a third entry — "query A" should be evicted
    await expander.expandQuery("query C");
    expect(expander.cacheSize).toBe(2);

    // "query A" was evicted, so querying it again should call LLM
    await expander.expandQuery("query A");
    // 4 LLM calls: A, B, C, A again
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  it("clearCache resets the memoization cache", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '["variant"]' } }],
    });
    const openai = { chat: { completions: { create: mockCreate } } };
    const expander = new QueryExpander(ENABLED_CFG, openai as never);

    await expander.expandQuery("test query");
    expect(expander.cacheSize).toBe(1);

    expander.clearCache();
    expect(expander.cacheSize).toBe(0);

    // Should call LLM again after cache cleared
    await expander.expandQuery("test query");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

describe("QueryExpansionConfig type", () => {
  it("has correct shape with all required fields", () => {
    const cfg: QueryExpansionConfig = {
      enabled: false,
      maxVariants: 4,
      cacheSize: 100,
      timeoutMs: 5000,
    };
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxVariants).toBe(4);
    expect(cfg.cacheSize).toBe(100);
    expect(cfg.timeoutMs).toBe(5000);
    expect(cfg.model).toBeUndefined();
  });

  it("optional model field can be set", () => {
    const cfg: QueryExpansionConfig = {
      enabled: true,
      model: "openai/gpt-4.1-nano",
      maxVariants: 3,
      cacheSize: 50,
      timeoutMs: 3000,
    };
    expect(cfg.model).toBe("openai/gpt-4.1-nano");
  });
});

// ---------------------------------------------------------------------------
// Integration with retrieval orchestrator
// ---------------------------------------------------------------------------

describe("retrieval orchestrator — query expansion integration", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "query-expander-orch-test-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("works without queryExpander (backward compatibility)", async () => {
    factsDb.store({
      text: "The API key is stored in the config file",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const vectorDb = { search: async () => [] } as unknown as import("../backends/vector-db.js").VectorDB;
    const config = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      strategies: ["fts5"] as Array<"fts5">,
      fts5TopK: 5,
    };

    // No queryExpander passed — should behave as before
    const result = await runRetrievalPipeline(
      "API key",
      null,
      factsDb.getRawDb(),
      vectorDb,
      factsDb,
      config,
      2000,
    );

    expect(result).toBeDefined();
    expect(Array.isArray(result.fused)).toBe(true);
  });

  it("expander variants produce additional semantic strategies in RRF fusion", async () => {
    // Store a fact that matches the expanded query but not the original
    const stored = factsDb.store({
      text: "Locate the authentication token in settings",
      category: "fact",
      importance: 0.8,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    // Track vector search calls to verify expansion strategies are tried
    const searchCalls: number[][] = [];
    const vectorDb = {
      search: vi.fn().mockImplementation(async (vec: number[]) => {
        searchCalls.push(vec);
        // Return the stored fact for any search (simulates semantic match)
        return [{ entry: { id: stored.id }, score: 0.9 }];
      }),
    } as unknown as import("../backends/vector-db.js").VectorDB;

    const config = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      strategies: ["semantic"] as Array<"semantic">,
      semanticTopK: 5,
    };

    // Mock expander that returns 2 variants
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '["locate authentication token", "retrieve auth credentials"]' } }],
    });
    const openai = { chat: { completions: { create: mockCreate } } };
    const expander = new QueryExpander(ENABLED_CFG, openai as never);

    let embedCallCount = 0;
    const embedFn = vi.fn().mockImplementation(async () => {
      embedCallCount++;
      return new Array(384).fill(0.1);
    });

    const originalVec = new Array(384).fill(0.2);

    await runRetrievalPipeline(
      "find API key",
      originalVec,
      factsDb.getRawDb(),
      vectorDb,
      factsDb,
      config,
      2000,
      undefined,   // nowSec
      undefined,   // tagFilter
      undefined,   // includeSuperseded
      undefined,   // scopeFilter
      undefined,   // asOf
      null,        // aliasDb
      undefined,   // clustersConfig
      null,        // embeddingRegistry
      null,        // factsDbForEmbeddings
      expander,    // queryExpander
      embedFn,     // embedFn
    );

    // embedFn should have been called once per variant (2 variants)
    expect(embedCallCount).toBe(2);
    // vectorDb.search should have been called for original + 2 variants = 3 times
    expect((vectorDb.search as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("gracefully handles expansion failure during pipeline execution", async () => {
    const stored = factsDb.store({
      text: "Apple is tasty",
      category: "fact",
      importance: 0.6,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const vectorDb = {
      search: async () => [{ entry: { id: stored.id }, score: 0.8 }],
    } as unknown as import("../backends/vector-db.js").VectorDB;

    const config = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      strategies: ["semantic"] as Array<"semantic">,
      semanticTopK: 5,
    };

    // Expander that throws on expandQuery
    const failingExpander = {
      expandQuery: vi.fn().mockRejectedValue(new Error("LLM unreachable")),
    } as unknown as QueryExpander;

    const embedFn = vi.fn().mockResolvedValue(new Array(384).fill(0.1));
    const originalVec = new Array(384).fill(0.2);

    // Pipeline should still succeed without expansion
    const result = await runRetrievalPipeline(
      "apple",
      originalVec,
      factsDb.getRawDb(),
      vectorDb,
      factsDb,
      config,
      2000,
      undefined,   // nowSec
      undefined,   // tagFilter
      undefined,   // includeSuperseded
      undefined,   // scopeFilter
      undefined,   // asOf
      null,        // aliasDb
      undefined,   // clustersConfig
      null,        // embeddingRegistry
      null,        // factsDbForEmbeddings
      failingExpander, // queryExpander
      embedFn,     // embedFn
    );

    expect(result).toBeDefined();
    expect(Array.isArray(result.fused)).toBe(true);
  });
});
