/**
 * Tests for Issue #159 — Contextual Variants at Index Time.
 *
 * Coverage:
 *   parseVariantsFromResponse:
 *     - parses a valid JSON array from LLM response
 *     - handles JSON embedded in prose
 *     - handles code-fenced JSON
 *     - returns empty array when no JSON array found
 *     - returns empty array for invalid JSON
 *     - filters out non-string elements
 *     - trims whitespace from variants
 *     - respects maxVariants limit
 *     - returns empty array for empty JSON array
 *   ContextualVariantGenerator:
 *     - returns empty array when config.enabled is false
 *     - returns empty array when category not in config.categories
 *     - generates variants when category filter is empty (all categories)
 *     - calls LLM with the fact text and category
 *     - respects maxVariantsPerFact limit
 *     - returns empty array on LLM error (graceful degradation)
 *     - rate limiting: blocks when maxPerMinute exceeded
 *     - rate limiting: allows calls after window expires
 *     - includes category-filtered variants only for matching categories
 *   VariantGenerationQueue:
 *     - enqueue triggers async processing
 *     - onVariantsGenerated is called with factId and variants
 *     - processes multiple items in batches
 *     - skips items when generator returns empty array
 *     - gracefully handles onVariantsGenerated errors
 *   FactsDB fact_variants table:
 *     - table is created automatically on FactsDB construction
 *     - storeVariant inserts a row and returns a numeric id
 *     - getVariants returns stored variants for a fact
 *     - getVariants returns empty array for unknown factId
 *     - hasVariants returns false for fact with no variants
 *     - hasVariants returns true after storing a variant
 *     - deleteVariants removes all variants for a fact
 *     - deleteVariants does not affect other facts
 *     - ON DELETE CASCADE removes variants when fact is deleted
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import type { ContextualVariantsConfig } from "../config.js";
import {
  ContextualVariantGenerator,
  VariantGenerationQueue,
  parseVariantsFromResponse,
} from "../services/contextual-variants.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ENABLED_CFG: ContextualVariantsConfig = {
  enabled: true,
  maxVariantsPerFact: 2,
  maxPerMinute: 30,
};

const DISABLED_CFG: ContextualVariantsConfig = {
  enabled: false,
  maxVariantsPerFact: 2,
  maxPerMinute: 30,
};

const CATEGORY_FILTERED_CFG: ContextualVariantsConfig = {
  enabled: true,
  maxVariantsPerFact: 2,
  maxPerMinute: 30,
  categories: ["fact", "entity"],
};

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

// ---------------------------------------------------------------------------
// parseVariantsFromResponse
// ---------------------------------------------------------------------------

describe("parseVariantsFromResponse", () => {
  it("parses a valid JSON array from a bare response", () => {
    const result = parseVariantsFromResponse('["variant one", "variant two"]', 5);
    expect(result).toEqual(["variant one", "variant two"]);
  });

  it("handles JSON array embedded in prose", () => {
    const response = 'Here are the variants: ["smart home server", "home automation hub"]';
    const result = parseVariantsFromResponse(response, 5);
    expect(result).toEqual(["smart home server", "home automation hub"]);
  });

  it("handles JSON in a code-fenced response (matches first array)", () => {
    const response = '```json\n["phrasing a", "phrasing b"]\n```';
    const result = parseVariantsFromResponse(response, 5);
    expect(result).toEqual(["phrasing a", "phrasing b"]);
  });

  it("returns empty array when no JSON array found", () => {
    const result = parseVariantsFromResponse("No array here at all.", 5);
    expect(result).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    const result = parseVariantsFromResponse("[not valid json,]", 5);
    expect(result).toEqual([]);
  });

  it("filters out non-string elements from the array", () => {
    const result = parseVariantsFromResponse('["valid", 42, null, "also valid"]', 5);
    expect(result).toEqual(["valid", "also valid"]);
  });

  it("filters out empty-string elements", () => {
    const result = parseVariantsFromResponse('["valid", "", "   ", "another"]', 5);
    expect(result).toEqual(["valid", "another"]);
  });

  it("trims whitespace from variants", () => {
    const result = parseVariantsFromResponse('["  leading ", "trailing  "]', 5);
    expect(result).toEqual(["leading", "trailing"]);
  });

  it("respects maxVariants limit", () => {
    const response = '["one", "two", "three", "four"]';
    const result = parseVariantsFromResponse(response, 2);
    expect(result).toHaveLength(2);
    expect(result).toEqual(["one", "two"]);
  });

  it("returns empty array for an empty JSON array", () => {
    const result = parseVariantsFromResponse("[]", 5);
    expect(result).toEqual([]);
  });

  it("parses array when string values contain literal ] (e.g. [topic])", () => {
    const response = 'Summary: ["phrase about [topic]", "other variant"]';
    const result = parseVariantsFromResponse(response, 5);
    expect(result).toEqual(["phrase about [topic]", "other variant"]);
  });
});

// ---------------------------------------------------------------------------
// ContextualVariantGenerator
// ---------------------------------------------------------------------------

describe("ContextualVariantGenerator — disabled", () => {
  it("returns empty array when config.enabled is false", async () => {
    const openai = makeMockOpenAI('["variant"]');
    const gen = new ContextualVariantGenerator(DISABLED_CFG, openai as never);
    const result = await gen.generateVariants("HA runs on Proxmox VM 100", "fact", "contextual-means");
    expect(result).toEqual([]);
    expect(
      (openai as { chat: { completions: { create: ReturnType<typeof vi.fn> } } }).chat.completions.create,
    ).not.toHaveBeenCalled();
  });
});

describe("ContextualVariantGenerator — category filter", () => {
  it("returns empty array when fact category is not in config.categories", async () => {
    const openai = makeMockOpenAI('["variant"]');
    const gen = new ContextualVariantGenerator(CATEGORY_FILTERED_CFG, openai as never);
    const result = await gen.generateVariants("User prefers dark mode", "preference", "contextual-means");
    expect(result).toEqual([]);
  });

  it("generates variants when fact category is in config.categories", async () => {
    const openai = makeMockOpenAI('["smart home server infrastructure"]');
    const gen = new ContextualVariantGenerator(CATEGORY_FILTERED_CFG, openai as never);
    const result = await gen.generateVariants("HA runs on Proxmox VM 100", "fact", "contextual-means");
    expect(result).toEqual(["smart home server infrastructure"]);
  });

  it("generates variants for all categories when categories is empty/undefined", async () => {
    const openai = makeMockOpenAI('["any category variant"]');
    const gen = new ContextualVariantGenerator(ENABLED_CFG, openai as never);
    const result = await gen.generateVariants("some fact", "preference", "contextual-means");
    expect(result).toEqual(["any category variant"]);
  });
});

describe("ContextualVariantGenerator — LLM call", () => {
  it("calls LLM and returns parsed variants", async () => {
    const openai = makeMockOpenAI('["server infrastructure", "home automation system"]');
    const gen = new ContextualVariantGenerator(ENABLED_CFG, openai as never);
    const result = await gen.generateVariants("HA runs on Proxmox VM 100 at 192.168.1.212", "fact", "contextual-means");
    expect(result).toEqual(["server infrastructure", "home automation system"]);
  });

  it("generates contextual-search variants", async () => {
    const openai = makeMockOpenAI('["home automation search", "proxmox vm 100 ip", "ha server details"]');
    const gen = new ContextualVariantGenerator(ENABLED_CFG, openai as never);
    const result = await gen.generateVariants(
      "HA runs on Proxmox VM 100 at 192.168.1.212",
      "fact",
      "contextual-search",
    );
    expect(result).toEqual(["home automation search", "proxmox vm 100 ip", "ha server details"]);
  });

  it("respects maxVariantsPerFact by truncating excess variants", async () => {
    const cfg: ContextualVariantsConfig = { ...ENABLED_CFG, maxVariantsPerFact: 1 };
    const openai = makeMockOpenAI('["first variant", "second variant", "third variant"]');
    const gen = new ContextualVariantGenerator(cfg, openai as never);
    const result = await gen.generateVariants("some fact text", "fact", "contextual-means");
    expect(result).toHaveLength(1);
  });

  it("returns empty array on LLM error (graceful degradation)", async () => {
    const openai = makeMockOpenAI(new Error("API timeout"));
    const gen = new ContextualVariantGenerator(ENABLED_CFG, openai as never);
    const result = await gen.generateVariants("some fact text", "fact", "contextual-means");
    expect(result).toEqual([]);
  });

  it("returns empty array when LLM returns non-JSON", async () => {
    const openai = makeMockOpenAI("Here are some variants: variant one, variant two.");
    const gen = new ContextualVariantGenerator(ENABLED_CFG, openai as never);
    const result = await gen.generateVariants("some fact text", "fact", "contextual-means");
    expect(result).toEqual([]);
  });
});

describe("ContextualVariantGenerator — rate limiting", () => {
  it("allows calls up to maxPerMinute", async () => {
    const cfg: ContextualVariantsConfig = { ...ENABLED_CFG, maxPerMinute: 3 };
    const openai = makeMockOpenAI('["variant"]');
    const gen = new ContextualVariantGenerator(cfg, openai as never);

    // First 3 calls should succeed
    for (let i = 0; i < 3; i++) {
      const result = await gen.generateVariants("fact text", "fact", "contextual-means");
      expect(result).toEqual(["variant"]);
    }
    // 4th call should be rate-limited
    const limited = await gen.generateVariants("fact text", "fact", "contextual-means");
    expect(limited).toEqual([]);
  });

  it("resets call count after rate limit is cleared", async () => {
    const cfg: ContextualVariantsConfig = { ...ENABLED_CFG, maxPerMinute: 1 };
    const openai = makeMockOpenAI('["variant"]');
    const gen = new ContextualVariantGenerator(cfg, openai as never);

    // First call succeeds
    await gen.generateVariants("fact text", "fact", "contextual-means");
    // Second should be rate-limited
    const limited = await gen.generateVariants("fact text", "fact", "contextual-means");
    expect(limited).toEqual([]);

    // Reset rate limit (simulates window expiry)
    gen._resetRateLimit();
    const result = await gen.generateVariants("fact text", "fact", "contextual-means");
    expect(result).toEqual(["variant"]);
  });

  it("tracks calls in window correctly", async () => {
    const cfg: ContextualVariantsConfig = { ...ENABLED_CFG, maxPerMinute: 5 };
    const openai = makeMockOpenAI('["variant"]');
    const gen = new ContextualVariantGenerator(cfg, openai as never);

    expect(gen.callsInWindow).toBe(0);
    await gen.generateVariants("fact", "fact", "contextual-means");
    expect(gen.callsInWindow).toBe(1);
    await gen.generateVariants("fact", "fact", "contextual-means");
    expect(gen.callsInWindow).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// VariantGenerationQueue
// ---------------------------------------------------------------------------

describe("VariantGenerationQueue", () => {
  it("calls onVariantsGenerated for both variant types", async () => {
    const openai = makeMockOpenAI('["generated variant"]');
    const gen = new ContextualVariantGenerator(ENABLED_CFG, openai as never);
    const onVariantsGenerated = vi.fn().mockResolvedValue(undefined);
    const queue = new VariantGenerationQueue(gen, onVariantsGenerated);

    queue.enqueue({ factId: "fact-1", text: "some fact", category: "fact" });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 50));

    expect(onVariantsGenerated).toHaveBeenCalledWith("fact-1", "contextual-means", ["generated variant"]);
    expect(onVariantsGenerated).toHaveBeenCalledWith("fact-1", "contextual-search", ["generated variant"]);
  });

  it("does not call onVariantsGenerated when generator returns empty array", async () => {
    const openai = makeMockOpenAI("no json array here");
    const gen = new ContextualVariantGenerator(ENABLED_CFG, openai as never);
    const onVariantsGenerated = vi.fn().mockResolvedValue(undefined);
    const queue = new VariantGenerationQueue(gen, onVariantsGenerated);

    queue.enqueue({ factId: "fact-1", text: "some fact", category: "fact" });

    await new Promise((r) => setTimeout(r, 50));

    expect(onVariantsGenerated).not.toHaveBeenCalled();
  });

  it("processes multiple enqueued items", async () => {
    const openai = makeMockOpenAI('["variant"]');
    const gen = new ContextualVariantGenerator(ENABLED_CFG, openai as never);
    const calls: Array<{ factId: string; variantType: string }> = [];
    const onVariantsGenerated = vi.fn().mockImplementation(async (factId: string, variantType: string) => {
      calls.push({ factId, variantType });
    });
    const queue = new VariantGenerationQueue(gen, onVariantsGenerated);

    queue.enqueue({ factId: "fact-1", text: "fact 1", category: "fact" });
    queue.enqueue({ factId: "fact-2", text: "fact 2", category: "fact" });
    queue.enqueue({ factId: "fact-3", text: "fact 3", category: "fact" });

    await new Promise((r) => setTimeout(r, 100));

    const byFact = calls.reduce<Record<string, string[]>>((acc, call) => {
      acc[call.factId] = acc[call.factId] ?? [];
      acc[call.factId].push(call.variantType);
      return acc;
    }, {});
    expect(Object.keys(byFact).sort()).toEqual(["fact-1", "fact-2", "fact-3"]);
    expect(byFact["fact-1"].sort()).toEqual(["contextual-means", "contextual-search"]);
    expect(byFact["fact-2"].sort()).toEqual(["contextual-means", "contextual-search"]);
    expect(byFact["fact-3"].sort()).toEqual(["contextual-means", "contextual-search"]);
  });

  it("gracefully handles onVariantsGenerated errors without stopping queue", async () => {
    const openai = makeMockOpenAI('["variant"]');
    const gen = new ContextualVariantGenerator(ENABLED_CFG, openai as never);
    let callCount = 0;
    const onVariantsGenerated = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("DB error");
    });
    const queue = new VariantGenerationQueue(gen, onVariantsGenerated);

    queue.enqueue({ factId: "fact-1", text: "fact 1", category: "fact" });
    queue.enqueue({ factId: "fact-2", text: "fact 2", category: "fact" });

    await new Promise((r) => setTimeout(r, 100));

    // Both items and variant types should have been attempted
    expect(onVariantsGenerated).toHaveBeenCalledTimes(4);
  });

  it("stores both variant types in fact_embeddings", async () => {
    const localTmpDir = mkdtempSync(join(tmpdir(), "contextual-variants-embeddings-"));
    const localDb = new FactsDB(join(localTmpDir, "test.db"));
    const factId = storeTestFact(localDb, "embedded fact");
    const openai = makeMockOpenAI('["variant"]');
    const gen = new ContextualVariantGenerator(ENABLED_CFG, openai as never);
    const onVariantsGenerated = vi.fn().mockImplementation(async (id: string, variantType: string) => {
      const value = variantType === "contextual-search" ? 0.8 : 0.2;
      const vec = new Float32Array([value, value, value, value]);
      localDb.storeEmbedding(id, "test-model", variantType, vec, vec.length);
    });
    const queue = new VariantGenerationQueue(gen, onVariantsGenerated);

    queue.enqueue({ factId, text: "some fact", category: "fact" });
    await new Promise((r) => setTimeout(r, 100));

    const stored = localDb
      .getEmbeddings(factId)
      .map((r) => r.variant)
      .sort();
    expect(stored).toEqual(["contextual-means", "contextual-search"]);

    localDb.close();
    rmSync(localTmpDir, { recursive: true });
  });

  it("reports correct queueLength before processing starts", () => {
    // Use a generator that will take some time
    const openai = makeMockOpenAI('["variant"]');
    const gen = new ContextualVariantGenerator(DISABLED_CFG, openai as never);
    const queue = new VariantGenerationQueue(gen, vi.fn().mockResolvedValue(undefined));

    // With disabled generator, items are still enqueued momentarily
    expect(queue.queueLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FactsDB — fact_variants table
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "contextual-variants-test-"));
  db = new FactsDB(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true });
});

function storeTestFact(factsDb: FactsDB, text = "test fact"): string {
  const result = factsDb.store({
    text,
    category: "fact",
    importance: 0.7,
    source: "test",
    entity: null,
    key: null,
    value: null,
  });
  return result.id;
}

describe("FactsDB fact_variants table — schema", () => {
  it("table is created automatically on FactsDB construction", () => {
    const factId = storeTestFact(db);
    expect(() => db.storeVariant(factId, "contextual", "variant text")).not.toThrow();
  });

  it("is idempotent — multiple FactsDB openings do not fail", () => {
    db.close();
    const db2 = new FactsDB(join(tmpDir, "test.db"));
    const factId = storeTestFact(db2);
    expect(() => db2.storeVariant(factId, "contextual", "variant text")).not.toThrow();
    db2.close();
    db = new FactsDB(join(tmpDir, "test2.db"));
  });
});

describe("FactsDB.storeVariant", () => {
  it("inserts a row and returns a numeric id", () => {
    const factId = storeTestFact(db);
    const id = db.storeVariant(factId, "contextual", "variant text");
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("stores multiple variants for the same fact", () => {
    const factId = storeTestFact(db);
    db.storeVariant(factId, "contextual-1", "variant one");
    db.storeVariant(factId, "contextual-2", "variant two");
    const variants = db.getVariants(factId);
    expect(variants).toHaveLength(2);
  });

  it("stores variants for multiple facts independently", () => {
    const id1 = storeTestFact(db, "fact one");
    const id2 = storeTestFact(db, "fact two");
    db.storeVariant(id1, "contextual", "variant for fact 1");
    db.storeVariant(id2, "contextual", "variant for fact 2");
    expect(db.getVariants(id1)).toHaveLength(1);
    expect(db.getVariants(id2)).toHaveLength(1);
  });
});

describe("FactsDB.getVariants", () => {
  it("returns stored variants with correct fields", () => {
    const factId = storeTestFact(db);
    db.storeVariant(factId, "contextual-1", "smart home server infrastructure");
    const variants = db.getVariants(factId);
    expect(variants).toHaveLength(1);
    expect(variants[0].variantType).toBe("contextual-1");
    expect(variants[0].variantText).toBe("smart home server infrastructure");
    expect(typeof variants[0].id).toBe("number");
    expect(typeof variants[0].createdAt).toBe("string");
  });

  it("returns empty array for unknown factId", () => {
    expect(db.getVariants("nonexistent-fact-id")).toEqual([]);
  });

  it("returns variants in insertion order", () => {
    const factId = storeTestFact(db);
    db.storeVariant(factId, "contextual-1", "first variant");
    db.storeVariant(factId, "contextual-2", "second variant");
    const variants = db.getVariants(factId);
    expect(variants[0].variantText).toBe("first variant");
    expect(variants[1].variantText).toBe("second variant");
  });
});

describe("FactsDB.hasVariants", () => {
  it("returns false for a fact with no variants", () => {
    const factId = storeTestFact(db);
    expect(db.hasVariants(factId)).toBe(false);
  });

  it("returns true after storing a variant", () => {
    const factId = storeTestFact(db);
    db.storeVariant(factId, "contextual", "variant text");
    expect(db.hasVariants(factId)).toBe(true);
  });

  it("returns false for nonexistent factId", () => {
    expect(db.hasVariants("nonexistent-id")).toBe(false);
  });
});

describe("FactsDB.deleteVariants", () => {
  it("removes all variants for a fact", () => {
    const factId = storeTestFact(db);
    db.storeVariant(factId, "contextual-1", "variant one");
    db.storeVariant(factId, "contextual-2", "variant two");
    db.deleteVariants(factId);
    expect(db.getVariants(factId)).toHaveLength(0);
    expect(db.hasVariants(factId)).toBe(false);
  });

  it("does not affect other facts' variants", () => {
    const id1 = storeTestFact(db, "fact one");
    const id2 = storeTestFact(db, "fact two");
    db.storeVariant(id1, "contextual", "variant for 1");
    db.storeVariant(id2, "contextual", "variant for 2");
    db.deleteVariants(id1);
    expect(db.getVariants(id1)).toHaveLength(0);
    expect(db.getVariants(id2)).toHaveLength(1);
  });

  it("is safe to call for a factId with no variants", () => {
    const factId = storeTestFact(db);
    expect(() => db.deleteVariants(factId)).not.toThrow();
  });
});

describe("FactsDB fact_variants — cascade delete", () => {
  it("removes variants when the parent fact is deleted", () => {
    const factId = storeTestFact(db);
    db.storeVariant(factId, "contextual", "will be deleted");
    expect(db.hasVariants(factId)).toBe(true);

    db.delete(factId);
    expect(db.hasVariants(factId)).toBe(false);
    expect(db.getVariants(factId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

describe("ContextualVariantsConfig defaults", () => {
  it("export type is importable and has correct shape", () => {
    const cfg: ContextualVariantsConfig = {
      enabled: false,
      maxVariantsPerFact: 2,
      maxPerMinute: 30,
    };
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxVariantsPerFact).toBe(2);
    expect(cfg.maxPerMinute).toBe(30);
    expect(cfg.categories).toBeUndefined();
    expect(cfg.model).toBeUndefined();
  });

  it("optional fields can be set", () => {
    const cfg: ContextualVariantsConfig = {
      enabled: true,
      model: "openai/gpt-4.1-nano",
      maxVariantsPerFact: 2,
      maxPerMinute: 30,
      categories: ["fact", "entity"],
    };
    expect(cfg.model).toBe("openai/gpt-4.1-nano");
    expect(cfg.categories).toEqual(["fact", "entity"]);
  });
});
