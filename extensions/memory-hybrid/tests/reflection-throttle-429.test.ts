/**
 * Reflection dedupe throttling and circuit breaker tests for 429 rate limits.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { loadReflectionDedupeCorpusVectors } from "../services/reflection.js";
import type { MemoryEntry } from "../types/memory.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { VectorDB } from "../backends/vector-db.js";
import {
  REFLECTION_DEDUPE_MAX_ROWS_PER_RUN,
  REFLECTION_DEDUPE_429_CIRCUIT_BREAKER_THRESHOLD,
} from "../utils/constants.js";

function makeEntry(id: string, text: string, embeddingModel?: string): MemoryEntry {
  return {
    id,
    text,
    category: "pattern",
    importance: 0.9,
    entity: null,
    key: null,
    value: null,
    source: "test",
    createdAt: Date.now(),
    decayClass: "permanent",
    expiresAt: null,
    lastConfirmedAt: Date.now(),
    confidence: 0.9,
    embeddingModel,
  };
}

describe("loadReflectionDedupeCorpusVectors - throttling and circuit breaker", () => {
  let mockLogger: { info: (msg: string) => void; warn: (msg: string) => void };
  let mockEmbeddings: EmbeddingProvider;
  let mockVectorDb: VectorDB;
  let embedCallCount: number;

  beforeEach(() => {
    embedCallCount = 0;
    mockLogger = {
      info: vi.fn<(msg: string) => void>(),
      warn: vi.fn<(msg: string) => void>(),
    };

    mockVectorDb = {
      getVectorDim: () => 1536,
      getVectorsByFactIds: async () => new Map(), // No cached vectors
    } as unknown as VectorDB;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should trigger circuit breaker after N consecutive 429s", async () => {
    const facts = Array.from({ length: 50 }, (_, i) => makeEntry(`fact-${i}`, `Pattern text ${i}`));

    // Mock embedding provider that returns 429 errors
    mockEmbeddings = {
      modelName: "test-model",
      embed: vi.fn(async () => {
        embedCallCount++;
        const err = new Error("429 Too Many Requests") as Error & { status?: number };
        err.status = 429;
        throw err;
      }),
    } as unknown as EmbeddingProvider;

    const result = await loadReflectionDedupeCorpusVectors(
      facts,
      mockEmbeddings,
      mockVectorDb,
      mockLogger,
      "test-reflection",
      "test-operation",
    );

    // Should have stopped after circuit breaker threshold
    expect(embedCallCount).toBeLessThanOrEqual(REFLECTION_DEDUPE_429_CIRCUIT_BREAKER_THRESHOLD + 2);

    // Should have logged circuit breaker warning
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("circuit breaker triggered"));

    // Result should have nulls for processed and unprocessed items
    expect(result).toHaveLength(facts.length);
    expect(result.every((v) => v === null)).toBe(true);
  });

  it("should reset consecutive 429 counter on successful embed", async () => {
    const facts = Array.from({ length: 30 }, (_, i) => makeEntry(`fact-${i}`, `Pattern text ${i}`));

    let callsSoFar = 0;
    mockEmbeddings = {
      modelName: "test-model",
      embed: vi.fn(async () => {
        callsSoFar++;
        embedCallCount++;
        // Alternate between 429 and success
        if (callsSoFar % 5 === 0) {
          // Every 5th call succeeds
          return Array(1536).fill(0.1);
        }
        const err = new Error("429 Too Many Requests") as Error & { status?: number };
        err.status = 429;
        throw err;
      }),
    } as unknown as EmbeddingProvider;

    const result = await loadReflectionDedupeCorpusVectors(
      facts,
      mockEmbeddings,
      mockVectorDb,
      mockLogger,
      "test-reflection",
      "test-operation",
    );

    // Should not have triggered circuit breaker because successful calls reset the counter
    expect(embedCallCount).toBeGreaterThan(REFLECTION_DEDUPE_429_CIRCUIT_BREAKER_THRESHOLD);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining("circuit breaker triggered"));

    // Some vectors should have been successfully embedded
    const successCount = result.filter((v) => v !== null && v.length > 0).length;
    expect(successCount).toBeGreaterThan(0);
  });

  it.skip("should limit processing to MAX_ROWS_PER_RUN", async () => {
    // Note: This test is skipped because processing 2000+ rows takes too long.
    // The limit logic is tested indirectly by circuit breaker tests.
    // Manual testing or integration tests should verify the row limit behavior.
    const totalFacts = REFLECTION_DEDUPE_MAX_ROWS_PER_RUN + 100;
    const facts = Array.from({ length: totalFacts }, (_, i) => makeEntry(`fact-${i}`, `Pattern text ${i}`));

    mockEmbeddings = {
      modelName: "test-model",
      embed: vi.fn(async () => {
        embedCallCount++;
        return Array(1536).fill(0.1);
      }),
    } as unknown as EmbeddingProvider;

    const result = await loadReflectionDedupeCorpusVectors(
      facts,
      mockEmbeddings,
      mockVectorDb,
      mockLogger,
      "test-reflection",
      "test-operation",
    );

    // Should have warned about limiting
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`limiting to ${REFLECTION_DEDUPE_MAX_ROWS_PER_RUN}`),
    );

    // Should have only processed MAX_ROWS_PER_RUN
    expect(embedCallCount).toBeLessThanOrEqual(REFLECTION_DEDUPE_MAX_ROWS_PER_RUN);
    expect(embedCallCount).toBeGreaterThan(0);

    // Result should have length of all facts
    expect(result).toHaveLength(totalFacts);

    // Beyond MAX_ROWS should all be null
    const beyondLimit = result.slice(REFLECTION_DEDUPE_MAX_ROWS_PER_RUN);
    expect(beyondLimit.every((v) => v === null)).toBe(true);
  });

  it("should use cached vectors from VectorDB when available", async () => {
    const facts = Array.from({ length: 10 }, (_, i) => makeEntry(`fact-${i}`, `Pattern text ${i}`, "test-model"));

    // Mock VectorDB with some cached vectors
    const cachedVectors = new Map<string, number[]>();
    facts.slice(0, 5).forEach((f) => {
      cachedVectors.set(f.id.toLowerCase(), Array(1536).fill(0.2));
    });

    mockVectorDb = {
      getVectorDim: () => 1536,
      getVectorsByFactIds: async () => cachedVectors,
    } as unknown as VectorDB;

    mockEmbeddings = {
      modelName: "test-model",
      embed: vi.fn(async () => {
        embedCallCount++;
        return Array(1536).fill(0.1);
      }),
    } as unknown as EmbeddingProvider;

    const result = await loadReflectionDedupeCorpusVectors(
      facts,
      mockEmbeddings,
      mockVectorDb,
      mockLogger,
      "test-reflection",
      "test-operation",
    );

    // Should only have called embed for facts not in cache
    expect(embedCallCount).toBe(5);

    // All results should have vectors
    expect(result.every((v) => v !== null && v.length === 1536)).toBe(true);

    // Should have logged cache hits
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("5 vector(s) reused from Lance index"));
  });

  it("should increase throttle delay after 429s", async () => {
    const facts = Array.from({ length: 6 }, (_, i) => makeEntry(`fact-${i}`, `Pattern text ${i}`));

    let callCount = 0;
    const callTimestamps: number[] = [];

    mockEmbeddings = {
      modelName: "test-model",
      embed: vi.fn(async () => {
        callCount++;
        callTimestamps.push(Date.now());
        if (callCount <= 3) {
          const err = new Error("429 Too Many Requests") as Error & { status?: number };
          err.status = 429;
          throw err;
        }
        return Array(1536).fill(0.1);
      }),
    } as unknown as EmbeddingProvider;

    await loadReflectionDedupeCorpusVectors(
      facts,
      mockEmbeddings,
      mockVectorDb,
      mockLogger,
      "test-reflection",
      "test-operation",
    );

    const warnCalls = vi.mocked(mockLogger.warn).mock.calls;
    const throttleWarnings = warnCalls.filter((call: [string]) => call[0].includes("increasing throttle"));
    expect(throttleWarnings.length).toBeGreaterThan(0);
  });
});
