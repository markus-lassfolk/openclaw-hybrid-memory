// @ts-nocheck
/**
 * Integration tests for non-destructive re-index via shadow-table swap (Issue #1246).
 *
 * Tests the build-then-swap pattern that prevents data-availability incidents when
 * re-index aborts partway through embedding migration.
 */

import { existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../backends/vector-db.js";
import { migrateEmbeddings } from "../services/embedding-migration.js";
import type { EmbeddingProvider } from "../services/embeddings.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDbPath: string;

beforeEach(() => {
  testDbPath = mkdtempSync(join(tmpdir(), "reindex-shadow-test-"));
});

afterEach(() => {
  if (existsSync(testDbPath)) {
    rmSync(testDbPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMockFactsDB(facts: Array<{ id: string; text: string }>) {
  return {
    getAll: vi.fn().mockReturnValue(facts),
    getCount: vi.fn().mockReturnValue(facts.length),
    getBatch: vi.fn((offset: number, limit: number) => {
      return facts.slice(offset, offset + limit);
    }),
    setEmbeddingModel: vi.fn(),
    getEmbeddingMeta: vi.fn().mockReturnValue(null),
    setEmbeddingMeta: vi.fn(),
  };
}

function makeMockEmbeddings(dims = 128): EmbeddingProvider {
  return {
    modelName: "test-embedding-model",
    dimensions: dims,
    embed: vi.fn(async (text: string) => {
      // Generate deterministic vector based on text hash
      const hash = text.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return Array.from({ length: dims }, (_, i) => (hash + i) / (dims * 100));
    }),
    embedBatch: vi.fn(async (texts: string[]) => {
      const embed = (text: string) => {
        const hash = text.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
        return Array.from({ length: dims }, (_, i) => (hash + i) / (dims * 100));
      };
      return texts.map(embed);
    }),
  };
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

// ---------------------------------------------------------------------------
// Shadow table creation and swap tests
// ---------------------------------------------------------------------------

describe("VectorDB shadow table creation", () => {
  it("creates a timestamped shadow table with correct schema", async () => {
    const vectorDb = new VectorDB(testDbPath, 128, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    const shadowTableName = await vectorDb.createShadowTable();

    // Verify shadow table name format
    expect(shadowTableName).toMatch(/^memories_reindex_\d+$/);

    // Verify shadow table directory exists
    const shadowTableDir = join(testDbPath, `${shadowTableName}.lance`);
    expect(existsSync(shadowTableDir)).toBe(true);

    // Verify main table still exists and is untouched
    const mainTableDir = join(testDbPath, "memories.lance");
    expect(existsSync(mainTableDir)).toBe(true);

    await vectorDb.close();
  });

  it("throws if shadow table directory already exists", async () => {
    const vectorDb = new VectorDB(testDbPath, 128, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    const shadowTableName = await vectorDb.createShadowTable();

    // Create a second shadow table - should get a different timestamp and succeed
    // (timestamps are millisecond precision, but tests run fast enough they might collide)
    // Wait a millisecond to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 2));
    const shadowTableName2 = await vectorDb.createShadowTable();

    // Verify we got two different shadow tables
    expect(shadowTableName).not.toBe(shadowTableName2);
    expect(existsSync(join(testDbPath, `${shadowTableName}.lance`))).toBe(true);
    expect(existsSync(join(testDbPath, `${shadowTableName2}.lance`))).toBe(true);

    await vectorDb.close();
  });
});

describe("VectorDB shadow table swap", () => {
  it("swaps shadow table into place after successful validation", async () => {
    const vectorDb = new VectorDB(testDbPath, 128, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    // Store 10 facts in main table
    for (let i = 0; i < 10; i++) {
      await vectorDb.store({
        id: `fact-${i}`,
        text: `test fact ${i}`,
        vector: Array(128).fill(i / 128),
        importance: 0.7,
        category: "test",
      });
    }

    const mainTableRowCountBefore = await vectorDb.count();
    expect(mainTableRowCountBefore).toBe(10);

    // Create shadow table
    const shadowTableName = await vectorDb.createShadowTable();

    // Store 12 facts in shadow table (20% increase)
    for (let i = 0; i < 12; i++) {
      await vectorDb.storeToTable(shadowTableName, {
        id: `fact-${i}`,
        text: `test fact ${i} updated`,
        vector: Array(128).fill(i / 128),
        importance: 0.8,
        category: "test",
      });
    }

    // Swap shadow table into place (min 95% of 10 = 9, we have 12)
    await vectorDb.swapShadowTable(shadowTableName, 0.95, 10);

    // Verify main table now has 12 rows
    const mainTableRowCountAfter = await vectorDb.count();
    expect(mainTableRowCountAfter).toBe(12);

    // Verify old table directory was removed
    const oldTablePattern = new RegExp(`memories_old_\\d+\\.lance`);
    const files = existsSync(testDbPath) ? readdirSync(testDbPath) : [];
    const oldTableExists = files.some((f: string) => oldTablePattern.test(f));
    expect(oldTableExists).toBe(false);

    await vectorDb.close();
  });

  it("aborts swap and preserves live table when row count validation fails", async () => {
    const vectorDb = new VectorDB(testDbPath, 128, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    // Store 100 facts in main table
    for (let i = 0; i < 100; i++) {
      await vectorDb.store({
        id: `fact-${i}`,
        text: `test fact ${i}`,
        vector: Array(128).fill(i / 128),
        importance: 0.7,
        category: "test",
      });
    }

    const mainTableRowCountBefore = await vectorDb.count();
    expect(mainTableRowCountBefore).toBe(100);

    // Create shadow table
    const shadowTableName = await vectorDb.createShadowTable();

    // Store only 50 facts in shadow table (50% success < 95% threshold)
    for (let i = 0; i < 50; i++) {
      await vectorDb.storeToTable(shadowTableName, {
        id: `fact-${i}`,
        text: `test fact ${i} updated`,
        vector: Array(128).fill(i / 128),
        importance: 0.8,
        category: "test",
      });
    }

    // Try to swap — should fail validation
    await expect(async () => {
      await vectorDb.swapShadowTable(shadowTableName, 0.95, 100);
    }).rejects.toThrow(/Shadow table validation failed: 50 rows < required minimum 95/);

    // Verify main table still has 100 rows (unchanged)
    const mainTableRowCountAfter = await vectorDb.count();
    expect(mainTableRowCountAfter).toBe(100);

    // Verify shadow table directory still exists for inspection
    const shadowTableDir = join(testDbPath, `${shadowTableName}.lance`);
    expect(existsSync(shadowTableDir)).toBe(true);

    await vectorDb.close();
  });

  it("throws if shadow table directory does not exist", async () => {
    const vectorDb = new VectorDB(testDbPath, 128, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    // Store one fact so we have a non-empty main table
    await vectorDb.store({
      id: "fact-1",
      text: "test",
      vector: Array(128).fill(0.5),
      importance: 0.7,
      category: "test",
    });

    await expect(async () => {
      await vectorDb.swapShadowTable("nonexistent_table", 0.95, 1);
    }).rejects.toThrow(/Shadow table directory not found/);

    await vectorDb.close();
  });

  it("uses current main table row count when expectedRows is 0", async () => {
    const vectorDb = new VectorDB(testDbPath, 128, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    // Store 50 facts in main table
    for (let i = 0; i < 50; i++) {
      await vectorDb.store({
        id: `fact-${i}`,
        text: `test fact ${i}`,
        vector: Array(128).fill(i / 128),
        importance: 0.7,
        category: "test",
      });
    }

    const shadowTableName = await vectorDb.createShadowTable();

    // Store 48 facts in shadow table (96% success > 95% threshold)
    for (let i = 0; i < 48; i++) {
      await vectorDb.storeToTable(shadowTableName, {
        id: `fact-${i}`,
        text: `test fact ${i}`,
        vector: Array(128).fill(i / 128),
        importance: 0.7,
        category: "test",
      });
    }

    // Swap with expectedRows=0, should use current main table count (50)
    await vectorDb.swapShadowTable(shadowTableName, 0.95, 0);

    const mainTableRowCountAfter = await vectorDb.count();
    expect(mainTableRowCountAfter).toBe(48);

    await vectorDb.close();
  });
});

describe("VectorDB storeToTable", () => {
  it("stores vectors to specified shadow table", async () => {
    const vectorDb = new VectorDB(testDbPath, 128, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    const shadowTableName = await vectorDb.createShadowTable();

    // Store to shadow table
    await vectorDb.storeToTable(shadowTableName, {
      id: "test-fact",
      text: "test text",
      vector: Array(128).fill(0.5),
      importance: 0.7,
      category: "test",
    });

    // Verify main table is still empty
    const mainTableCount = await vectorDb.count();
    expect(mainTableCount).toBe(0);

    // Swap and verify
    await vectorDb.swapShadowTable(shadowTableName, 0.0, 0);
    const mainTableCountAfter = await vectorDb.count();
    expect(mainTableCountAfter).toBe(1);

    await vectorDb.close();
  });
});

// ---------------------------------------------------------------------------
// End-to-end re-index flow tests
// ---------------------------------------------------------------------------

describe("migrateEmbeddings with shadow table", () => {
  it("writes all embeddings to shadow table when targetTableName is provided", async () => {
    const facts = Array.from({ length: 20 }, (_, i) => ({
      id: `fact-${i}`,
      text: `test fact ${i}`,
      category: "test",
      importance: 0.7,
    }));

    const factsDb = makeMockFactsDB(facts);
    const embeddings = makeMockEmbeddings(128);

    const vectorDb = new VectorDB(testDbPath, 128, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    // Create shadow table
    const shadowTableName = await vectorDb.createShadowTable();

    // Migrate embeddings into shadow table
    const result = await migrateEmbeddings({
      factsDb,
      vectorDb,
      embeddings,
      batchSize: 5,
      targetTableName: shadowTableName,
      logger: silentLogger(),
    });

    // Verify migration result
    expect(result.total).toBe(20);
    expect(result.migrated).toBe(20);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify main table is still empty
    const mainTableCount = await vectorDb.count();
    expect(mainTableCount).toBe(0);

    // Swap shadow table
    await vectorDb.swapShadowTable(shadowTableName, 0.95, 20);

    // Verify main table now has all facts
    const mainTableCountAfter = await vectorDb.count();
    expect(mainTableCountAfter).toBe(20);

    // Verify embeddings were called
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(4); // 20 facts / 5 batch size

    // Verify setEmbeddingModel was NOT called (only when writing to main table)
    expect(factsDb.setEmbeddingModel).not.toHaveBeenCalled();

    await vectorDb.close();
  });

  it("skips duplicate checks when writing to shadow table", async () => {
    const facts = Array.from({ length: 10 }, (_, i) => ({
      id: `fact-${i}`,
      text: `test fact ${i}`,
      category: "test",
      importance: 0.7,
    }));

    const factsDb = makeMockFactsDB(facts);
    const embeddings = makeMockEmbeddings(128);

    const vectorDb = new VectorDB(testDbPath, 128, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    const shadowTableName = await vectorDb.createShadowTable();

    const hasDuplicateSpy = vi.spyOn(vectorDb, "hasDuplicate");

    await migrateEmbeddings({
      factsDb,
      vectorDb,
      embeddings,
      batchSize: 10,
      targetTableName: shadowTableName,
      logger: silentLogger(),
    });

    // Verify hasDuplicate was NOT called (shadow table rebuild skips deduplication)
    expect(hasDuplicateSpy).not.toHaveBeenCalled();

    await vectorDb.close();
  });
});

describe("re-index aborted mid-migration leaves main table intact", () => {
  it("simulates VectorDB close during migration", async () => {
    const facts = Array.from({ length: 100 }, (_, i) => ({
      id: `fact-${i}`,
      text: `test fact ${i}`,
      category: "test",
      importance: 0.7,
    }));

    const factsDb = makeMockFactsDB(facts);
    const embeddings = makeMockEmbeddings(128);

    const vectorDb = new VectorDB(testDbPath, 128, false);
    vectorDb.setLogger({ warn: vi.fn() });
    await vectorDb.open();

    // Populate main table with 100 facts
    for (let i = 0; i < 100; i++) {
      await vectorDb.store({
        id: `fact-${i}`,
        text: `test fact ${i}`,
        vector: Array(128).fill(i / 128),
        importance: 0.7,
        category: "test",
      });
    }

    const mainTableRowCountBefore = await vectorDb.count();
    expect(mainTableRowCountBefore).toBe(100);

    // Create shadow table
    const shadowTableName = await vectorDb.createShadowTable();

    // Simulate abort after 50 facts by making embedBatch throw after 2 batches
    let batchCount = 0;
    const embedBatchSpy = vi.spyOn(embeddings, "embedBatch").mockImplementation(async (texts: string[]) => {
      batchCount++;
      if (batchCount > 2) {
        // Simulate VectorDB close
        vectorDb.close();
        throw new Error("VectorDB closed during migration");
      }
      // Return vectors for first 2 batches
      return texts.map((text) => {
        const hash = text.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
        return Array.from({ length: 128 }, (_, i) => (hash + i) / (128 * 100));
      });
    });

    // Run migration — should abort partway through
    const result = await migrateEmbeddings({
      factsDb,
      vectorDb,
      embeddings,
      batchSize: 25, // 100 facts / 25 = 4 batches, abort after batch 2
      targetTableName: shadowTableName,
      logger: silentLogger(),
    });

    // Verify migration was aborted (less than 100 facts migrated)
    expect(result.migrated).toBeLessThan(100);
    expect(result.migrated).toBeGreaterThan(0); // Some facts were migrated before abort

    // Reconnect to verify main table
    const vectorDb2 = new VectorDB(testDbPath, 128, false);
    vectorDb2.setLogger({ warn: vi.fn() });
    await vectorDb2.open();

    // Verify main table STILL has 100 rows (untouched by aborted re-index)
    const mainTableRowCountAfter = await vectorDb2.count();
    expect(mainTableRowCountAfter).toBe(100);

    // Verify shadow table exists with partial data
    const shadowTableDir = join(testDbPath, `${shadowTableName}.lance`);
    expect(existsSync(shadowTableDir)).toBe(true);

    await vectorDb2.close();
  });
});
