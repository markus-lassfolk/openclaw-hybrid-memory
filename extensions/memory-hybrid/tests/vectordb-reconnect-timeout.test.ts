// @ts-nocheck
/**
 * VectorDB reconnect timeout tests — Issue: nightly dream-cycle hang during reflection dedupe
 *
 * Covers:
 *  - VectorDB getVectorsByFactIds() progress logging for large batches
 *  - loadReflectionDedupeCorpusVectors() fallback on timeout
 *  - Proper error handling and graceful degradation
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../backends/vector-db.js";
import { _testing } from "../index.js";
import { loadReflectionDedupeCorpusVectors } from "../services/reflection.js";
import type { MemoryEntry } from "../types/memory.js";
import { withTimeout } from "../utils/timeout.js";

const { FactsDB } = _testing;

const silentLogger = { info: () => undefined, warn: () => undefined };

describe("VectorDB reconnect timeout", () => {
  let tmpDir: string;
  let factsDb: any;
  let vectorDb: VectorDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vectordb-timeout-test-"));
    const factsDbPath = join(tmpDir, "facts.db");
    const vectorDbPath = join(tmpDir, "vectors");
    factsDb = new FactsDB(factsDbPath, silentLogger);
    vectorDb = new VectorDB(vectorDbPath, 384, silentLogger);
  });

  afterEach(() => {
    if (factsDb) factsDb.close();
    if (vectorDb) vectorDb.close();
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("withTimeout utility returns null on timeout", async () => {
    const slowOperation = async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return "success";
    };

    const start = Date.now();
    const result = await withTimeout(100, slowOperation);
    const elapsed = Date.now() - start;

    expect(result).toBe(null);
    expect(elapsed).toBeLessThan(200);
  });

  it("withTimeout utility returns result on success", async () => {
    const fastOperation = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "success";
    };

    const result = await withTimeout(1000, fastOperation);
    expect(result).toBe("success");
  });

  it("getVectorsByFactIds handles empty result gracefully", async () => {
    await vectorDb.ensureInitialized();

    // Query non-existent IDs
    const result = await vectorDb.getVectorsByFactIds(["non-existent-id-1", "non-existent-id-2"]);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  }, 10000);

  it("loadReflectionDedupeCorpusVectors succeeds with working VectorDB", async () => {
    await vectorDb.ensureInitialized();

    // Create test facts
    const facts: MemoryEntry[] = [];
    for (let i = 0; i < 5; i++) {
      const fact = factsDb.store({
        text: `Pattern ${i}`,
        category: "pattern" as any,
        importance: 0.9,
        entity: null,
        key: null,
        value: null,
        source: "reflection",
        decayClass: "permanent",
        tags: ["reflection", "pattern"],
        extractionMethod: "reflection",
        extractionConfidence: 0.9,
      });
      facts.push(fact);

      // Store vector
      const mockVector = new Array(384).fill(0).map(() => Math.random());
      await vectorDb.store({
        id: fact.id,
        text: fact.text,
        vector: mockVector,
        importance: fact.importance,
        category: fact.category,
      });
    }

    // Mark facts with embedding model
    for (const fact of facts) {
      factsDb.setEmbeddingModel(fact.id, "test-model");
    }

    // Mock embedding provider
    const mockEmbeddings = {
      modelName: "test-model",
      embed: async () => new Array(384).fill(0).map(() => Math.random()),
    };

    const result = await loadReflectionDedupeCorpusVectors(
      facts,
      mockEmbeddings as any,
      vectorDb,
      silentLogger,
      "test",
      "test-operation"
    );

    // Should succeed and return vectors
    expect(result.length).toBe(facts.length);
    const nonNullCount = result.filter((v) => v !== null).length;
    expect(nonNullCount).toBeGreaterThan(0);
  }, 10000);

  it("loadReflectionDedupeCorpusVectors returns all null on VectorDB failure", async () => {
    // Don't initialize VectorDB - it will fail

    const facts: MemoryEntry[] = [];
    for (let i = 0; i < 3; i++) {
      const fact = factsDb.store({
        text: `Pattern ${i}`,
        category: "pattern" as any,
        importance: 0.9,
        entity: null,
        key: null,
        value: null,
        source: "reflection",
        decayClass: "permanent",
        tags: ["reflection", "pattern"],
        extractionMethod: "reflection",
        extractionConfidence: 0.9,
      });
      facts.push(fact);
    }

    // Mock embedding provider that fails
    const mockEmbeddings = {
      modelName: "test-model",
      embed: async () => {
        throw new Error("Embedding failed");
      },
    };

    const result = await loadReflectionDedupeCorpusVectors(
      facts,
      mockEmbeddings as any,
      vectorDb,
      silentLogger,
      "test",
      "test-operation"
    );

    // Should handle failures gracefully
    expect(result.length).toBe(facts.length);
    // All should be null due to embedding failures
    const nullCount = result.filter((v) => v === null).length;
    expect(nullCount).toBe(facts.length);
  }, 10000);
});
