/**
 * Tests for reflection dedupe corpus hydration with persistence
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import type { EmbeddingProvider } from "../services/embeddings/types.js";
import type { MemoryEntry } from "../types/memory.js";

const { loadReflectionDedupeCorpusVectors, VectorDB } = _testing;

// Mock logger that captures log messages
class TestLogger {
  logs: string[] = [];

  info(msg: string): void {
    this.logs.push(msg);
  }

  hasLog(substring: string): boolean {
    return this.logs.some((log) => log.includes(substring));
  }

  getLogsMatching(substring: string): string[] {
    return this.logs.filter((log) => log.includes(substring));
  }
}

// Mock embedding provider
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1536;
  readonly modelName = "text-embedding-test-v1";

  async embed(text: string): Promise<number[]> {
    if (text.includes("FAIL")) {
      throw new Error("Simulated embedding failure");
    }
    const vec = new Array(this.dimensions).fill(0);
    vec[0] = text.length % 100;
    vec[1] = (text.charCodeAt(0) || 0) % 100;
    const sum = vec[0] * vec[0] + vec[1] * vec[1];
    if (sum > 0) {
      const norm = Math.sqrt(sum);
      vec[0] /= norm;
      vec[1] /= norm;
    }
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? randomUUID(),
    text: overrides.text ?? "User prefers TypeScript over JavaScript for type safety",
    category: overrides.category ?? "preference",
    importance: overrides.importance ?? 0.7,
    entity: overrides.entity ?? null,
    key: overrides.key ?? null,
    value: overrides.value ?? null,
    source: overrides.source ?? "test",
    createdAt: overrides.createdAt ?? Date.now(),
    decayClass: overrides.decayClass ?? "stable",
    expiresAt: overrides.expiresAt ?? null,
    lastConfirmedAt: overrides.lastConfirmedAt ?? Date.now(),
    confidence: overrides.confidence ?? 0.7,
    embeddingModel: overrides.embeddingModel ?? null,
    ...overrides,
  };
}

describe("loadReflectionDedupeCorpusVectors - enhanced hydration", () => {
  let tmpDir: string;
  let vectorDb: InstanceType<typeof VectorDB>;
  let embeddings: MockEmbeddingProvider;
  let logger: TestLogger;

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    tmpDir = mkdtempSync(join(tmpdir(), "refl-dedupe-test-"));

    const vectorDbPath = join(tmpDir, "vectors.lance");

    vectorDb = new VectorDB(vectorDbPath, 1536, false);
    await vectorDb.ensureInitialized();

    embeddings = new MockEmbeddingProvider();

    logger = new TestLogger();
  });

  afterEach(async () => {
    await vectorDb.close();
    const { rmSync } = await import("node:fs");
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reuses cached Lance vectors when embeddingModel is null", async () => {
    const factId = randomUUID();
    const text = "User prefers early returns";
    const vector = new Array(1536).fill(0);
    vector[0] = 1;

    await vectorDb.store({
      id: factId,
      text,
      vector,
      importance: 0.9,
      category: "pattern",
    });

    const fact = makeEntry({
      id: factId,
      text,
      embeddingModel: null,
    });

    const result = await loadReflectionDedupeCorpusVectors([fact], embeddings, vectorDb, logger, "test", "test-op");

    expect(result).toHaveLength(1);
    expect(result[0]).not.toBeNull();
    expect(logger.hasLog("vector(s) reused from Lance index")).toBe(true);
    expect(logger.hasLog("hydrated via embedding API")).toBe(true);
  });

  it("persists API-hydrated vectors back to Lance", async () => {
    const fact = makeEntry({
      id: randomUUID(),
      text: "User prefers immutable data structures",
      embeddingModel: "text-embedding-test-v1",
    });

    const result = await loadReflectionDedupeCorpusVectors([fact], embeddings, vectorDb, logger, "test", "test-op");

    expect(result).toHaveLength(1);
    expect(result[0]).not.toBeNull();
    expect(logger.hasLog("hydrated via embedding API")).toBe(true);
    expect(logger.hasLog("persisted to Lance")).toBe(true);

    const logger2 = new TestLogger();
    const result2 = await loadReflectionDedupeCorpusVectors([fact], embeddings, vectorDb, logger2, "test2", "test-op");

    expect(result2).toHaveLength(1);
    expect(result2[0]).not.toBeNull();
    expect(logger2.hasLog("vector(s) reused from Lance index")).toBe(true);
    expect(logger2.hasLog("0 row(s) hydrated via embedding API")).toBe(true);
  });

  it("logs per-batch progress with detailed metrics", async () => {
    const facts = Array.from({ length: 120 }, (_, i) =>
      makeEntry({
        id: randomUUID(),
        text: `Pattern number ${i}`,
        embeddingModel: "text-embedding-test-v1",
      }),
    );

    await loadReflectionDedupeCorpusVectors(facts, embeddings, vectorDb, logger, "test", "test-op");

    const progressLogs = logger.getLogsMatching("dedupe corpus progress:");
    expect(progressLogs.length).toBeGreaterThan(0);

    const finalLog = progressLogs[progressLogs.length - 1];
    expect(finalLog).toMatch(/batch \d+\/\d+/);
    expect(finalLog).toMatch(/\d+\/\d+ processed/);
    expect(finalLog).toMatch(/persisted \d+/);
    expect(finalLog).toMatch(/persistFailures \d+/);
    expect(finalLog).toMatch(/embedFailures \d+/);
    expect(finalLog).toMatch(/batch=\d+ms/);
  });

  it("logs final summary with persistence counts", async () => {
    const facts = [
      makeEntry({ id: randomUUID(), text: "Pattern 1", embeddingModel: "text-embedding-test-v1" }),
      makeEntry({ id: randomUUID(), text: "Pattern 2", embeddingModel: "text-embedding-test-v1" }),
    ];

    await loadReflectionDedupeCorpusVectors(facts, embeddings, vectorDb, logger, "test", "test-op");

    expect(logger.hasLog("2 row(s) hydrated via embedding API")).toBe(true);
    expect(logger.hasLog("2 persisted to Lance")).toBe(true);
    expect(logger.hasLog("0 persist failure")).toBe(true);
    expect(logger.hasLog("non-null for cosine check")).toBe(true);
  });

  it("handles persist failures gracefully", async () => {
    vi.spyOn(vectorDb, "store").mockRejectedValueOnce(new Error("simulated persist failure"));

    const facts = [makeEntry({ id: randomUUID(), text: "Pattern 1", embeddingModel: "text-embedding-test-v1" })];

    const result = await loadReflectionDedupeCorpusVectors(facts, embeddings, vectorDb, logger, "test", "test-op");

    expect(result).toHaveLength(1);
    expect(result[0]).not.toBeNull();

    expect(logger.hasLog("persistFailures")).toBe(true);
    expect(logger.hasLog("1 persist failure")).toBe(true);
  });

  it("reduces API hydration count on subsequent runs", async () => {
    const facts = Array.from({ length: 50 }, (_, i) =>
      makeEntry({
        id: randomUUID(),
        text: `Pattern number ${i}`,
        embeddingModel: "text-embedding-test-v1",
      }),
    );

    const logger1 = new TestLogger();
    await loadReflectionDedupeCorpusVectors(facts, embeddings, vectorDb, logger1, "run1", "test-op");

    expect(logger1.hasLog("50 row(s) hydrated via embedding API")).toBe(true);
    expect(logger1.hasLog("50 persisted to Lance")).toBe(true);

    const logger2 = new TestLogger();
    await loadReflectionDedupeCorpusVectors(facts, embeddings, vectorDb, logger2, "run2", "test-op");

    expect(logger2.hasLog("50 vector(s) reused from Lance index")).toBe(true);
    expect(logger2.hasLog("0 row(s) hydrated via embedding API")).toBe(true);
    expect(logger2.hasLog("0 persisted to Lance")).toBe(true);
  });

  it("handles embedding failures without aborting", async () => {
    const facts = [
      makeEntry({ id: randomUUID(), text: "Normal pattern", embeddingModel: "text-embedding-test-v1" }),
      makeEntry({ id: randomUUID(), text: "FAIL pattern", embeddingModel: "text-embedding-test-v1" }),
      makeEntry({ id: randomUUID(), text: "Another normal", embeddingModel: "text-embedding-test-v1" }),
    ];

    const result = await loadReflectionDedupeCorpusVectors(facts, embeddings, vectorDb, logger, "test", "test-op");

    expect(result).toHaveLength(3);
    expect(result[0]).not.toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).not.toBeNull();

    expect(logger.hasLog("embed failure")).toBe(true);
    expect(logger.hasLog("2/3 non-null")).toBe(true);
  });

  it("includes batch duration in progress logs", async () => {
    const facts = Array.from({ length: 110 }, (_, i) =>
      makeEntry({ id: randomUUID(), text: `Pattern number ${i}`, embeddingModel: "text-embedding-test-v1" }),
    );

    await loadReflectionDedupeCorpusVectors(facts, embeddings, vectorDb, logger, "test", "test-op");

    const progressLogs = logger.getLogsMatching("dedupe corpus progress:");
    expect(progressLogs.length).toBeGreaterThan(0);

    for (const log of progressLogs) {
      expect(log).toMatch(/batch=\d+ms/);
    }
  });

  it("shows elapsed time in final summary", async () => {
    const facts = [makeEntry({ id: randomUUID(), text: "Pattern 1", embeddingModel: "text-embedding-test-v1" })];

    await loadReflectionDedupeCorpusVectors(facts, embeddings, vectorDb, logger, "test", "test-op");

    const summaryLog = logger.logs.find((log) => log.includes("dedupe corpus: completed") && log.includes("elapsed"));
    expect(summaryLog).toBeDefined();
  });
});
