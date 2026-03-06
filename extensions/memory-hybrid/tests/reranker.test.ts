/**
 * Tests for Issue #161 — LLM Re-ranking of Retrieval Results.
 *
 * Coverage:
 *   buildRerankPrompt:
 *     - includes query in prompt
 *     - includes fact ID, text snippet, confidence, and stored date
 *     - truncates long fact text to 200 chars with ellipsis
 *     - handles multiple facts with correct numbering
 *   parseRankedIds:
 *     - parses a valid JSON array of IDs from a bare response
 *     - handles JSON embedded in prose
 *     - handles code-fenced JSON
 *     - returns empty array when no JSON array found
 *     - returns empty array for invalid JSON
 *     - filters out non-string elements
 *     - ignores empty strings
 *   rerankResults — disabled / edge cases:
 *     - returns original facts when config.enabled is false
 *     - returns original facts when facts array is empty
 *   rerankResults — success:
 *     - re-orders facts according to LLM response
 *     - facts omitted by LLM are appended after ranked ones (original order)
 *     - respects outputCount limit
 *     - facts beyond candidateCount are appended unchanged
 *   rerankResults — fallback / error handling:
 *     - returns original facts on LLM timeout (no truncation)
 *     - returns original facts on LLM error
 *     - falls back to full original order when LLM returns no valid IDs (consistent with error path)
 *   Integration with retrieval pipeline:
 *     - runRetrievalPipeline works without reranking params (backward compat)
 *     - runRetrievalPipeline calls reranking when enabled and openai provided
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  rerankResults,
  buildRerankPrompt,
  parseRankedIds,
  type ScoredFact,
} from "../services/reranker.js";
import { runRetrievalPipeline, DEFAULT_RETRIEVAL_CONFIG } from "../services/retrieval-orchestrator.js";
import { _testing } from "../index.js";
import type { RerankingConfig } from "../config.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFact(overrides: Partial<ScoredFact> = {}): ScoredFact {
  return {
    factId: "fact-1",
    text: "Some fact text",
    confidence: 0.9,
    storedDate: "2026-01-15",
    finalScore: 1.0,
    ...overrides,
  };
}

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

const ENABLED_CFG: RerankingConfig = {
  enabled: true,
  candidateCount: 50,
  outputCount: 20,
  timeoutMs: 10000,
};

const DISABLED_CFG: RerankingConfig = {
  enabled: false,
  candidateCount: 50,
  outputCount: 20,
  timeoutMs: 10000,
};

// ---------------------------------------------------------------------------
// buildRerankPrompt
// ---------------------------------------------------------------------------

describe("buildRerankPrompt", () => {
  it("includes the query in the prompt", () => {
    const facts = [makeFact()];
    const prompt = buildRerankPrompt("find my API key", facts);
    expect(prompt).toContain("find my API key");
  });

  it("includes fact ID, text snippet, confidence, and stored date", () => {
    const fact = makeFact({
      factId: "abc-123",
      text: "The sky is blue",
      confidence: 0.85,
      storedDate: "2026-02-10",
    });
    const prompt = buildRerankPrompt("sky color", [fact]);
    expect(prompt).toContain("abc-123");
    expect(prompt).toContain("The sky is blue");
    expect(prompt).toContain("0.85");
    expect(prompt).toContain("2026-02-10");
  });

  it("truncates long fact text to 200 chars with ellipsis", () => {
    const longText = "A".repeat(300);
    const fact = makeFact({ text: longText });
    const prompt = buildRerankPrompt("query", [fact]);
    // The snippet should be at most 200 chars (197 + "...")
    expect(prompt).toContain("A".repeat(197) + "...");
    expect(prompt).not.toContain("A".repeat(200));
  });

  it("numbers multiple facts sequentially", () => {
    const facts = [
      makeFact({ factId: "f1", text: "First fact" }),
      makeFact({ factId: "f2", text: "Second fact" }),
      makeFact({ factId: "f3", text: "Third fact" }),
    ];
    const prompt = buildRerankPrompt("query", facts);
    expect(prompt).toContain("1.");
    expect(prompt).toContain("2.");
    expect(prompt).toContain("3.");
  });

  it("includes all fact IDs in the prompt", () => {
    const facts = [
      makeFact({ factId: "id-alpha" }),
      makeFact({ factId: "id-beta" }),
    ];
    const prompt = buildRerankPrompt("test", facts);
    expect(prompt).toContain("id-alpha");
    expect(prompt).toContain("id-beta");
  });
});

// ---------------------------------------------------------------------------
// parseRankedIds
// ---------------------------------------------------------------------------

describe("parseRankedIds", () => {
  it("parses a valid JSON array of IDs from a bare response", () => {
    const result = parseRankedIds('["id-1", "id-2", "id-3"]');
    expect(result).toEqual(["id-1", "id-2", "id-3"]);
  });

  it("handles JSON embedded in prose", () => {
    const response = 'Here are the ranked IDs: ["id-a", "id-b"] based on relevance.';
    const result = parseRankedIds(response);
    expect(result).toEqual(["id-a", "id-b"]);
  });

  it("handles code-fenced JSON", () => {
    const response = "```json\n[\"id-x\", \"id-y\"]\n```";
    const result = parseRankedIds(response);
    expect(result).toEqual(["id-x", "id-y"]);
  });

  it("returns empty array when no JSON array found", () => {
    const result = parseRankedIds("No array here at all.");
    expect(result).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    const result = parseRankedIds("[not valid json,]");
    expect(result).toEqual([]);
  });

  it("filters out non-string elements", () => {
    const result = parseRankedIds('["id-1", 42, null, true, "id-2"]');
    expect(result).toEqual(["id-1", "id-2"]);
  });

  it("filters out empty strings", () => {
    const result = parseRankedIds('["id-1", "", "id-2"]');
    expect(result).toEqual(["id-1", "id-2"]);
  });

  it("parses first valid array when response has bracketed prose after JSON", () => {
    const response = '["id-1", "id-2"] I ranked id-1 first because [it was most relevant].';
    const result = parseRankedIds(response);
    expect(result).toEqual(["id-1", "id-2"]);
  });

  it("trims whitespace from IDs so lookup matches", () => {
    const result = parseRankedIds('["  id-a  ", "id-b ", " id-c"]');
    expect(result).toEqual(["id-a", "id-b", "id-c"]);
  });
});

// ---------------------------------------------------------------------------
// rerankResults — disabled / edge cases
// ---------------------------------------------------------------------------

describe("rerankResults — disabled", () => {
  it("returns original facts when config.enabled is false", async () => {
    const openai = makeMockOpenAI('["fact-2", "fact-1"]');
    const facts = [makeFact({ factId: "fact-1" }), makeFact({ factId: "fact-2" })];
    const result = await rerankResults("query", facts, DISABLED_CFG, openai as never);
    expect(result.map((f) => f.factId)).toEqual(["fact-1", "fact-2"]);
    expect(
      (openai as { chat: { completions: { create: ReturnType<typeof vi.fn> } } })
        .chat.completions.create,
    ).not.toHaveBeenCalled();
  });

  it("returns original facts when facts array is empty", async () => {
    const openai = makeMockOpenAI('["fact-1"]');
    const result = await rerankResults("query", [], ENABLED_CFG, openai as never);
    expect(result).toEqual([]);
    expect(
      (openai as { chat: { completions: { create: ReturnType<typeof vi.fn> } } })
        .chat.completions.create,
    ).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// rerankResults — success
// ---------------------------------------------------------------------------

describe("rerankResults — success", () => {
  it("re-orders facts according to LLM response", async () => {
    const openai = makeMockOpenAI('["fact-3", "fact-1", "fact-2"]');
    const facts = [
      makeFact({ factId: "fact-1", finalScore: 3 }),
      makeFact({ factId: "fact-2", finalScore: 2 }),
      makeFact({ factId: "fact-3", finalScore: 1 }),
    ];
    const result = await rerankResults("query", facts, { ...ENABLED_CFG, outputCount: 10 }, openai as never);
    expect(result.map((f) => f.factId)).toEqual(["fact-3", "fact-1", "fact-2"]);
  });

  it("appends facts omitted by LLM after the ranked ones in original order", async () => {
    // LLM only returns fact-1 and fact-3, omitting fact-2
    const openai = makeMockOpenAI('["fact-1", "fact-3"]');
    const facts = [
      makeFact({ factId: "fact-1" }),
      makeFact({ factId: "fact-2" }),
      makeFact({ factId: "fact-3" }),
    ];
    const result = await rerankResults("query", facts, { ...ENABLED_CFG, outputCount: 10 }, openai as never);
    expect(result.map((f) => f.factId)).toEqual(["fact-1", "fact-3", "fact-2"]);
  });

  it("respects outputCount limit", async () => {
    const openai = makeMockOpenAI('["fact-1", "fact-2", "fact-3", "fact-4", "fact-5"]');
    const facts = Array.from({ length: 5 }, (_, i) => makeFact({ factId: `fact-${i + 1}` }));
    const cfg: RerankingConfig = { ...ENABLED_CFG, outputCount: 3 };
    const result = await rerankResults("query", facts, cfg, openai as never);
    expect(result).toHaveLength(3);
  });

  it("appends facts beyond candidateCount unchanged after re-ranked candidates", async () => {
    // Only first 2 facts go to LLM (candidateCount: 2), fact-3 is in the tail
    const openai = makeMockOpenAI('["fact-2", "fact-1"]');
    const facts = [
      makeFact({ factId: "fact-1" }),
      makeFact({ factId: "fact-2" }),
      makeFact({ factId: "fact-3" }), // tail: beyond candidateCount
    ];
    const cfg: RerankingConfig = { ...ENABLED_CFG, candidateCount: 2, outputCount: 10 };
    const result = await rerankResults("query", facts, cfg, openai as never);
    expect(result.map((f) => f.factId)).toEqual(["fact-2", "fact-1", "fact-3"]);
  });

  it("preserves original order for omitted candidates before appending tail", async () => {
    // LLM omits fact-2 entirely
    const openai = makeMockOpenAI('["fact-3", "fact-1"]');
    const facts = [
      makeFact({ factId: "fact-1" }),
      makeFact({ factId: "fact-2" }), // omitted by LLM, appended after
      makeFact({ factId: "fact-3" }),
      makeFact({ factId: "fact-4" }), // tail (beyond candidateCount: 3)
    ];
    const cfg: RerankingConfig = { ...ENABLED_CFG, candidateCount: 3, outputCount: 10 };
    const result = await rerankResults("query", facts, cfg, openai as never);
    expect(result.map((f) => f.factId)).toEqual(["fact-3", "fact-1", "fact-2", "fact-4"]);
  });

  it("calls LLM with correct model when model is specified in config", async () => {
    const openai = makeMockOpenAI('["fact-1"]');
    const facts = [makeFact({ factId: "fact-1" })];
    const cfg: RerankingConfig = { ...ENABLED_CFG, model: "openai/gpt-4.1-mini" };
    await rerankResults("query", facts, cfg, openai as never);
    expect(
      (openai as { chat: { completions: { create: ReturnType<typeof vi.fn> } } })
        .chat.completions.create,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-4.1-mini" }),
      expect.anything(),
    );
  });

  it("uses default model openai/gpt-4.1-nano when no model specified", async () => {
    const openai = makeMockOpenAI('["fact-1"]');
    const facts = [makeFact({ factId: "fact-1" })];
    // No model in config
    const cfg: RerankingConfig = { enabled: true, candidateCount: 50, outputCount: 20, timeoutMs: 10000 };
    await rerankResults("query", facts, cfg, openai as never);
    expect(
      (openai as { chat: { completions: { create: ReturnType<typeof vi.fn> } } })
        .chat.completions.create,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-4.1-nano" }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// rerankResults — fallback / error handling
// ---------------------------------------------------------------------------

describe("rerankResults — fallback on error", () => {
  it("returns original facts (unsliced) on LLM error", async () => {
    const openai = makeMockOpenAI(new Error("API unavailable"));
    const facts = [
      makeFact({ factId: "fact-1" }),
      makeFact({ factId: "fact-2" }),
      makeFact({ factId: "fact-3" }),
    ];
    const result = await rerankResults("query", facts, ENABLED_CFG, openai as never);
    expect(result.map((f) => f.factId)).toEqual(["fact-1", "fact-2", "fact-3"]);
  });

  it("returns original facts (unsliced) on LLM timeout", async () => {
    // Simulate a timeout error (AbortError)
    const timeoutError = new Error("LLM request timeout after 10000ms (model: openai/gpt-4.1-nano)");
    timeoutError.name = "AbortError";
    const openai = makeMockOpenAI(timeoutError);
    const facts = [
      makeFact({ factId: "fact-1" }),
      makeFact({ factId: "fact-2" }),
    ];
    const result = await rerankResults("query", facts, ENABLED_CFG, openai as never);
    expect(result.map((f) => f.factId)).toEqual(["fact-1", "fact-2"]);
  });

  it("returns full original facts when LLM returns empty array (same as error fallback)", async () => {
    const openai = makeMockOpenAI("[]");
    const facts = Array.from({ length: 5 }, (_, i) => makeFact({ factId: `fact-${i + 1}` }));
    const cfg: RerankingConfig = { ...ENABLED_CFG, outputCount: 3 };
    const result = await rerankResults("query", facts, cfg, openai as never);
    expect(result).toHaveLength(5);
    expect(result[0].factId).toBe("fact-1");
  });

  it("returns full original facts when LLM returns non-JSON response (same as error fallback)", async () => {
    const openai = makeMockOpenAI("I cannot rank these results.");
    const facts = Array.from({ length: 5 }, (_, i) => makeFact({ factId: `fact-${i + 1}` }));
    const cfg: RerankingConfig = { ...ENABLED_CFG, outputCount: 2 };
    const result = await rerankResults("query", facts, cfg, openai as never);
    expect(result).toHaveLength(5);
    expect(result[0].factId).toBe("fact-1");
  });
});

// ---------------------------------------------------------------------------
// Config type shape
// ---------------------------------------------------------------------------

describe("RerankingConfig shape", () => {
  it("has the correct default fields", () => {
    const cfg: RerankingConfig = {
      enabled: false,
      candidateCount: 50,
      outputCount: 20,
      timeoutMs: 10000,
    };
    expect(cfg.enabled).toBe(false);
    expect(cfg.candidateCount).toBe(50);
    expect(cfg.outputCount).toBe(20);
    expect(cfg.timeoutMs).toBe(10000);
    expect(cfg.model).toBeUndefined();
  });

  it("accepts optional model field", () => {
    const cfg: RerankingConfig = {
      enabled: true,
      model: "openai/gpt-4.1-mini",
      candidateCount: 30,
      outputCount: 15,
      timeoutMs: 5000,
    };
    expect(cfg.model).toBe("openai/gpt-4.1-mini");
  });
});

// ---------------------------------------------------------------------------
// Integration with retrieval pipeline
// ---------------------------------------------------------------------------

describe("Integration — runRetrievalPipeline with re-ranking", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reranker-integration-test-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("works without rerankingConfig/openai params (backward compat)", async () => {
    factsDb.store({
      text: "Apple is a fruit",
      category: "fact",
      importance: 0.6,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const vectorDb = { search: async () => [] } as unknown as import("../backends/vector-db.js").VectorDB;
    const config = { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["fts5"] as Array<"fts5"> };

    // Should not throw — omitting re-ranking params is backward compatible
    const result = await runRetrievalPipeline("apple", null, factsDb.getRawDb(), vectorDb, factsDb, config, 2000);
    expect(result).toBeDefined();
  });

  it("applies re-ranking when enabled and openai is provided", async () => {
    const stored1 = factsDb.store({
      text: "Apple is a fruit",
      category: "fact",
      importance: 0.6,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    const stored2 = factsDb.store({
      text: "Apple pie is delicious",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    // LLM puts stored2 first (reversing the FTS5 order)
    const openai = makeMockOpenAI(`["${stored2.id}", "${stored1.id}"]`);
    const vectorDb = { search: async () => [] } as unknown as import("../backends/vector-db.js").VectorDB;
    const config = { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["fts5"] as Array<"fts5"> };
    const rerankingCfg: RerankingConfig = { enabled: true, candidateCount: 50, outputCount: 20, timeoutMs: 10000 };

    const result = await runRetrievalPipeline(
      "apple",
      null,
      factsDb.getRawDb(),
      vectorDb,
      factsDb,
      config,
      2000,
      undefined, // nowSec
      undefined, // tagFilter
      undefined, // includeSuperseded
      undefined, // scopeFilter
      undefined, // asOf
      undefined, // aliasDb
      undefined, // clustersConfig
      undefined, // embeddingRegistry
      undefined, // factsDbForEmbeddings
      undefined, // queryExpander
      undefined, // embedFn
      undefined, // queryExpansionContext
      rerankingCfg,
      openai as never,
    );

    // After re-ranking, stored2 should come first
    expect(result.fused[0]?.factId).toBe(stored2.id);
  });

  it("falls back to original order when re-ranking openai throws", async () => {
    const stored1 = factsDb.store({
      text: "Banana is yellow",
      category: "fact",
      importance: 0.6,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });

    const openai = makeMockOpenAI(new Error("Network error"));
    const vectorDb = { search: async () => [] } as unknown as import("../backends/vector-db.js").VectorDB;
    const config = { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["fts5"] as Array<"fts5"> };
    const rerankingCfg: RerankingConfig = { enabled: true, candidateCount: 50, outputCount: 20, timeoutMs: 10000 };

    // Should not throw
    const result = await runRetrievalPipeline(
      "banana",
      null,
      factsDb.getRawDb(),
      vectorDb,
      factsDb,
      config,
      2000,
      undefined, // nowSec
      undefined, // tagFilter
      undefined, // includeSuperseded
      undefined, // scopeFilter
      undefined, // asOf
      undefined, // aliasDb
      undefined, // clustersConfig
      undefined, // embeddingRegistry
      undefined, // factsDbForEmbeddings
      undefined, // queryExpander
      undefined, // embedFn
      undefined, // queryExpansionContext
      rerankingCfg,
      openai as never,
    );

    // Should still return the fact (fallback order preserved)
    const ids = result.fused.map((r) => r.factId);
    expect(ids).toContain(stored1.id);
  });
});
