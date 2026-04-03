/**
 * Tests for Issue #149 — Multi-hook Retrieval Aliases.
 *
 * Coverage:
 *   AliasDB:
 *     - constructor creates fact_aliases table
 *     - count() returns 0 for empty DB
 *     - count() returns correct count after stores
 *     - store() inserts a row and returns a UUID id
 *     - getByFactId() returns aliases for known factId
 *     - getByFactId() returns empty array for unknown factId
 *     - deleteByFactId() removes all aliases for a fact
 *     - deleteByFactId() does not affect other facts
 *     - search() returns empty for empty DB
 *     - search() finds high-similarity alias (exact match → score ≈ 1)
 *     - search() excludes results below minScore
 *     - search() deduplicates factId (keeps best score)
 *     - search() respects limit parameter
 *     - search() returns results sorted descending by score
 *   generateAliases:
 *     - returns parsed lines from LLM response
 *     - deduplicates identical aliases
 *     - excludes original fact text from aliases
 *     - strips numbering/bullets from lines
 *     - returns empty array on LLM error
 *     - respects maxAliases limit
 *   storeAliases:
 *     - stores embeddings for each generated alias
 *     - is a no-op when config.enabled is false
 *     - handles embedding failure gracefully (partial store)
 *   searchAliasStrategy:
 *     - returns ranked results matching AliasDB results
 *     - returns empty array for empty DB
 *     - source field is "aliases"
 *   cosineSimilarity:
 *     - returns 1.0 for identical vectors
 *     - returns 0 for orthogonal vectors
 *     - returns 0 for empty / mismatched length
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AliasesConfig } from "../config.js";
import { cosineSimilarity } from "../services/ambient-retrieval.js";
import { AliasDB, generateAliases, searchAliasStrategy, storeAliases } from "../services/retrieval-aliases.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "alias-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Ignore cleanup failures in CI (ENOTEMPTY race condition)
  }
});

function makeDb(): AliasDB {
  const id = randomUUID();
  return new AliasDB(join(tmpDir, `${id}.db`), join(tmpDir, `${id}.lance`), 4);
}

/** Build a unit vector in `dims` dimensions along axis 0. */
function unitVec(dims = 4): number[] {
  const v = new Array(dims).fill(0);
  v[0] = 1;
  return v;
}

/** Build a unit vector along axis 1. Orthogonal to unitVec(). */
function orthVec(dims = 4): number[] {
  const v = new Array(dims).fill(0);
  v[1] = 1;
  return v;
}

const ENABLED_CFG: AliasesConfig = {
  enabled: true,
  maxAliases: 3,
};

const DISABLED_CFG: AliasesConfig = {
  enabled: false,
  maxAliases: 3,
};

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical non-zero vectors", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(unitVec(), orthVec())).toBeCloseTo(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched-length vectors", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for zero vector (denom = 0)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AliasDB
// ---------------------------------------------------------------------------

describe("AliasDB constructor", () => {
  it("creates the fact_aliases table on construction", () => {
    const db = makeDb();
    expect(db.count()).toBe(0);
    db.close();
  });
});

describe("AliasDB.count", () => {
  it("returns 0 for empty DB", () => {
    const db = makeDb();
    expect(db.count()).toBe(0);
    db.close();
  });

  it("returns correct count after storing aliases", () => {
    const db = makeDb();
    const factId = randomUUID();
    db.store(factId, "alias one", unitVec());
    db.store(factId, "alias two", orthVec());
    expect(db.count()).toBe(2);
    db.close();
  });
});

describe("AliasDB.store", () => {
  it("inserts a row and returns a UUID-shaped id", () => {
    const db = makeDb();
    const id = db.store(randomUUID(), "test alias", unitVec());
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(10);
    expect(db.count()).toBe(1);
    db.close();
  });

  it("stores multiple aliases for the same factId", () => {
    const db = makeDb();
    const factId = randomUUID();
    db.store(factId, "alias a", unitVec());
    db.store(factId, "alias b", orthVec());
    expect(db.getByFactId(factId)).toHaveLength(2);
    db.close();
  });
});

describe("AliasDB.getByFactId", () => {
  it("returns all aliases for a known factId", () => {
    const db = makeDb();
    const factId = randomUUID();
    db.store(factId, "phrase one", unitVec());
    db.store(factId, "phrase two", orthVec());
    const rows = db.getByFactId(factId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.aliasText).sort()).toEqual(["phrase one", "phrase two"].sort());
    db.close();
  });

  it("returns empty array for unknown factId", () => {
    const db = makeDb();
    expect(db.getByFactId(randomUUID())).toEqual([]);
    db.close();
  });

  it("matches factId case-insensitively", () => {
    const db = makeDb();
    const factId = randomUUID().toUpperCase();
    db.store(factId, "phrase one", unitVec());
    const rows = db.getByFactId(factId.toLowerCase());
    expect(rows).toHaveLength(1);
    expect(rows[0].factId).toBe(factId.toLowerCase());
    db.close();
  });
});

describe("AliasDB.deleteByFactId", () => {
  it("removes all aliases for a fact", () => {
    const db = makeDb();
    const factId = randomUUID();
    db.store(factId, "alias 1", unitVec());
    db.store(factId, "alias 2", orthVec());
    expect(db.count()).toBe(2);
    db.deleteByFactId(factId);
    expect(db.count()).toBe(0);
    db.close();
  });

  it("does not affect aliases for other facts", () => {
    const db = makeDb();
    const factA = randomUUID();
    const factB = randomUUID();
    db.store(factA, "alias for A", unitVec());
    db.store(factB, "alias for B", orthVec());
    db.deleteByFactId(factA);
    expect(db.count()).toBe(1);
    expect(db.getByFactId(factB)).toHaveLength(1);
    db.close();
  });

  it("deletes aliases case-insensitively", () => {
    const db = makeDb();
    const factId = randomUUID().toUpperCase();
    db.store(factId, "alias 1", unitVec());
    expect(db.count()).toBe(1);
    db.deleteByFactId(factId.toLowerCase());
    expect(db.count()).toBe(0);
    db.close();
  });
});

describe("AliasDB.search", () => {
  it("returns empty for empty DB", async () => {
    const db = makeDb();
    expect(await db.search(unitVec(), 5, 0.3)).toEqual([]);
    db.close();
  });

  it("finds alias with near-perfect cosine match (same vector)", async () => {
    const db = makeDb();
    const factId = randomUUID();
    db.store(factId, "exact alias", unitVec());
    const results = await db.search(unitVec(), 5, 0.3);
    expect(results).toHaveLength(1);
    expect(results[0].factId).toBe(factId);
    expect(results[0].score).toBeCloseTo(1.0);
    db.close();
  });

  it("excludes results below minScore", async () => {
    const db = makeDb();
    const factId = randomUUID();
    // Store orthogonal vector → similarity ≈ 0
    db.store(factId, "orthogonal", orthVec());
    const results = await db.search(unitVec(), 5, 0.5);
    expect(results).toHaveLength(0);
    db.close();
  });

  it("deduplicates factId: keeps only best score", async () => {
    const db = makeDb();
    const factId = randomUUID();
    // Two aliases for the same fact: one close, one not
    db.store(factId, "close alias", unitVec());
    const weakVec = [0.9, 0.1, 0, 0]; // normalise when scoring
    db.store(factId, "weak alias", weakVec);
    const results = await db.search(unitVec(), 5, 0.3);
    // Should deduplicate to one result
    expect(results).toHaveLength(1);
    expect(results[0].factId).toBe(factId);
    // Score should be the best (≈1.0)
    expect(results[0].score).toBeGreaterThan(0.9);
    db.close();
  });

  it("respects limit parameter", async () => {
    const db = makeDb();
    // Three facts, each with an alias similar to unitVec
    for (let i = 0; i < 3; i++) {
      const v = unitVec();
      v[0] = 1 - i * 0.01; // slight variation
      v[1] = i * 0.01;
      db.store(randomUUID(), `alias ${i}`, v);
    }
    const results = await db.search(unitVec(), 2, 0.3);
    expect(results.length).toBeLessThanOrEqual(2);
    db.close();
  });

  it("returns results sorted descending by score", async () => {
    const db = makeDb();
    // fact A: exactly matches unitVec (score ≈ 1)
    const factA = randomUUID();
    db.store(factA, "best", unitVec());
    // fact B: partially matches (score < 1)
    const factB = randomUUID();
    db.store(factB, "partial", [1, 1, 0, 0]);
    const results = await db.search(unitVec(), 5, 0.3);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    db.close();
  });
});

describe("AliasDB close lifecycle (#1009)", () => {
  it("defers SQLite close until an in-flight Lance-backed search finishes", async () => {
    const db = makeDb();
    const fid = randomUUID();
    db.store(fid, "alias row", unitVec());
    (db as unknown as { aliasCountCache: number | null }).aliasCountCache = 1000;

    const searchPromise = db.search(unitVec(), 5, 0.01);
    await new Promise<void>((resolve) => setImmediate(resolve));
    db.close();
    const results = await searchPromise;
    expect(Array.isArray(results)).toBe(true);
    expect(() => db.count()).not.toThrow();
    expect(db.count()).toBe(0);
  });

  it("closes immediately when idle and subsequent ops are safe no-ops", () => {
    const db = makeDb();
    db.store(randomUUID(), "x", unitVec());
    db.close();
    expect(db.count()).toBe(0);
    expect(db.getByFactId(randomUUID())).toEqual([]);
    expect(db.store(randomUUID(), "late", unitVec())).toBe("");
  });
});

// ---------------------------------------------------------------------------
// generateAliases
// ---------------------------------------------------------------------------

describe("generateAliases", () => {
  it("returns parsed lines from a successful LLM response", async () => {
    const mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "Alternative one\nAlternative two\nAlternative three" } }],
          }),
        },
      },
    } as unknown as import("openai").default;

    const aliases = await generateAliases("The user prefers dark mode.", mockOpenAI, "test-model", 5);
    expect(aliases).toContain("Alternative one");
    expect(aliases).toContain("Alternative two");
    expect(aliases).toContain("Alternative three");
  });

  it("deduplicates identical lines", async () => {
    const mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "Same line\nSame line\nOther line" } }],
          }),
        },
      },
    } as unknown as import("openai").default;

    const aliases = await generateAliases("Fact", mockOpenAI, "test-model", 5);
    expect(aliases.filter((a) => a === "Same line")).toHaveLength(1);
  });

  it("excludes the original fact text from aliases", async () => {
    const factText = "The user prefers vim.";
    const mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: `${factText}\nUser likes vim.\nVim is the preferred editor.` } }],
          }),
        },
      },
    } as unknown as import("openai").default;

    const aliases = await generateAliases(factText, mockOpenAI, "test-model", 5);
    expect(aliases).not.toContain(factText);
    expect(aliases).toContain("User likes vim.");
  });

  it("strips leading numbering and bullets from lines", async () => {
    const mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "1. First alias\n- Second alias\n* Third alias\n2) Fourth alias" } }],
          }),
        },
      },
    } as unknown as import("openai").default;

    const aliases = await generateAliases("Fact", mockOpenAI, "test-model", 5);
    expect(aliases).toContain("First alias");
    expect(aliases).toContain("Second alias");
    expect(aliases).toContain("Third alias");
    expect(aliases).toContain("Fourth alias");
  });

  it("returns empty array on LLM error", async () => {
    const mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
        },
      },
    } as unknown as import("openai").default;

    const aliases = await generateAliases("Fact", mockOpenAI, "test-model", 5);
    expect(aliases).toEqual([]);
  });

  it("respects maxAliases limit", async () => {
    const mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "A\nB\nC\nD\nE\nF\nG" } }],
          }),
        },
      },
    } as unknown as import("openai").default;

    const aliases = await generateAliases("Fact", mockOpenAI, "test-model", 3);
    expect(aliases.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// storeAliases
// ---------------------------------------------------------------------------

describe("storeAliases", () => {
  it("stores an embedding for each generated alias", async () => {
    const factId = randomUUID();
    const db = makeDb();

    const mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "Alias alpha\nAlias beta" } }],
          }),
        },
      },
    } as unknown as import("openai").default;

    const mockEmbeddings = {
      embed: vi.fn().mockResolvedValue(unitVec()),
    } as unknown as import("../services/embeddings.js").EmbeddingProvider;

    await storeAliases(factId, "Original fact", ENABLED_CFG, "test-model", mockOpenAI, mockEmbeddings, db);

    expect(db.count()).toBe(2);
    expect(db.getByFactId(factId)).toHaveLength(2);
    db.close();
  });

  it("is a no-op when config.enabled is false", async () => {
    const db = makeDb();
    const mockOpenAI = {} as unknown as import("openai").default;
    const mockEmbeddings = { embed: vi.fn() } as unknown as import("../services/embeddings.js").EmbeddingProvider;

    await storeAliases(randomUUID(), "Fact", DISABLED_CFG, "test-model", mockOpenAI, mockEmbeddings, db);

    expect(db.count()).toBe(0);
    expect(mockEmbeddings.embed).not.toHaveBeenCalled();
    db.close();
  });

  it("skips an alias when embedding fails but stores successful ones", async () => {
    const factId = randomUUID();
    const db = makeDb();

    const mockOpenAI = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "Good alias\nAnother good alias" } }],
          }),
        },
      },
    } as unknown as import("openai").default;

    let callCount = 0;
    const mockEmbeddings = {
      embed: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error("Embedding API down");
        return Promise.resolve(unitVec());
      }),
    } as unknown as import("../services/embeddings.js").EmbeddingProvider;

    const warnings: string[] = [];
    await storeAliases(factId, "Original", ENABLED_CFG, "test-model", mockOpenAI, mockEmbeddings, db, (msg) =>
      warnings.push(msg),
    );

    // Second alias should be stored despite first failing
    expect(db.count()).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// searchAliasStrategy
// ---------------------------------------------------------------------------

describe("searchAliasStrategy", () => {
  it("returns empty for empty DB", async () => {
    const db = makeDb();
    const results = await searchAliasStrategy(db, unitVec(), 5);
    expect(results).toEqual([]);
    db.close();
  });

  it("returns ranked results matching DB search results", async () => {
    const db = makeDb();
    const factId = randomUUID();
    db.store(factId, "alias one", unitVec());

    const results = await searchAliasStrategy(db, unitVec(), 5);
    expect(results).toHaveLength(1);
    expect(results[0].factId).toBe(factId);
    expect(results[0].rank).toBe(1);
    db.close();
  });

  it("sets source field to 'aliases'", async () => {
    const db = makeDb();
    db.store(randomUUID(), "alias", unitVec());

    const results = await searchAliasStrategy(db, unitVec(), 5);
    expect(results[0].source).toBe("aliases");
    db.close();
  });

  it("assigns ascending ranks starting at 1", async () => {
    const db = makeDb();
    // Add two facts with similar vectors
    db.store(randomUUID(), "best", unitVec());
    db.store(randomUUID(), "second best", [1, 0.1, 0, 0]);

    const results = await searchAliasStrategy(db, unitVec(), 5);
    expect(results.length).toBeGreaterThanOrEqual(2);
    const ranks = results.map((r) => r.rank);
    expect(ranks[0]).toBe(1);
    expect(ranks[1]).toBe(2);
    db.close();
  });
});
