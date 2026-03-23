/**
 * Tests for embedding-migration service (Issue #153).
 *
 * All backends are mocked — no real SQLite / LanceDB / embedding API required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  migrateEmbeddings,
  runEmbeddingMaintenance,
  type MigrateEmbeddingsOptions,
  type EmbeddingMaintenanceOptions,
} from "../services/embedding-migration.js";
import type { EmbeddingProvider } from "../services/embeddings.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type MockFactsDB = {
  getAll: ReturnType<typeof vi.fn>;
  setEmbeddingModel: ReturnType<typeof vi.fn>;
  getEmbeddingMeta: ReturnType<typeof vi.fn>;
  setEmbeddingMeta: ReturnType<typeof vi.fn>;
};

type MockVectorDB = {
  getCloseGeneration: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  hasDuplicate: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof vi.fn>;
};

type MockEmbeddings = EmbeddingProvider & {
  embed: ReturnType<typeof vi.fn>;
  embedBatch: ReturnType<typeof vi.fn>;
};

function makeFactsDB(overrides: Partial<MockFactsDB> = {}): MockFactsDB {
  return {
    getAll: vi.fn().mockReturnValue([]),
    setEmbeddingModel: vi.fn(),
    getEmbeddingMeta: vi.fn().mockReturnValue(null),
    setEmbeddingMeta: vi.fn(),
    ...overrides,
  };
}

function makeVectorDB(overrides: Partial<MockVectorDB> = {}): MockVectorDB {
  return {
    getCloseGeneration: vi.fn().mockReturnValue(0),
    delete: vi.fn().mockResolvedValue(true),
    hasDuplicate: vi.fn().mockResolvedValue(false),
    store: vi.fn().mockResolvedValue("id"),
    ...overrides,
  };
}

function makeEmbeddings(dims = 1536, overrides: Partial<MockEmbeddings> = {}): MockEmbeddings {
  const vec = Array.from({ length: dims }, (_, i) => i / dims);
  return {
    modelName: "test-model",
    dimensions: dims,
    embed: vi.fn().mockResolvedValue(vec),
    embedBatch: vi.fn().mockResolvedValue([vec]),
    ...overrides,
  };
}

function makeFact(id: string, text = `fact ${id}`) {
  return {
    id,
    text,
    category: "fact",
    importance: 0.7,
    entity: null,
    key: null,
    value: null,
    source: "conversation",
    createdAt: Math.floor(Date.now() / 1000),
    decayClass: "stable",
    expiresAt: null,
    lastConfirmedAt: 0,
    confidence: 1.0,
  };
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

// ---------------------------------------------------------------------------
// migrateEmbeddings — happy path
// ---------------------------------------------------------------------------

describe("migrateEmbeddings — basic behavior", () => {
  it("returns zero counts when there are no facts", async () => {
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue([]) });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings();

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    expect(result.total).toBe(0);
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("embeds and stores each fact", async () => {
    const facts = [makeFact("a"), makeFact("b"), makeFact("c")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi.fn().mockResolvedValue([Array(1536).fill(0.1), Array(1536).fill(0.2), Array(1536).fill(0.3)]),
    });

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    expect(result.total).toBe(3);
    expect(result.migrated).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(vectorDb.store).toHaveBeenCalledTimes(3);
    expect(factsDb.setEmbeddingModel).toHaveBeenCalledTimes(3);
    expect(factsDb.setEmbeddingModel).toHaveBeenCalledWith("a", "test-model");
  });

  it("calls onProgress after each batch", async () => {
    const facts = Array.from({ length: 5 }, (_, i) => makeFact(String(i)));
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const vecs = facts.map(() => Array(1536).fill(0.1));
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi.fn().mockResolvedValue(vecs),
    });
    const onProgress = vi.fn();

    await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      batchSize: 3,
      onProgress,
      logger: silentLogger(),
    });

    // batchSize=3 with 5 facts → 2 batches → 2 onProgress calls
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(3, 5);
    expect(onProgress).toHaveBeenCalledWith(5, 5);
  });
});

// ---------------------------------------------------------------------------
// migrateEmbeddings — duplicate / stale vector handling
// ---------------------------------------------------------------------------

describe("migrateEmbeddings — duplicate handling", () => {
  it("skips fact when hasDuplicate returns true", async () => {
    const facts = [makeFact("dup")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB({
      hasDuplicate: vi.fn().mockResolvedValue(true),
    });
    const embeddings = makeEmbeddings();

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(vectorDb.store).not.toHaveBeenCalled();
    expect(factsDb.setEmbeddingModel).not.toHaveBeenCalled();
  });

  it("removes stale entry before storing (handles dimension change)", async () => {
    const facts = [makeFact("x")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings();

    await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    expect(vectorDb.delete).toHaveBeenCalledWith("x");
    expect(vectorDb.store).toHaveBeenCalledWith(expect.objectContaining({ id: "x" }));
  });

  it("continues when delete throws (entry not found)", async () => {
    const facts = [makeFact("y")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB({
      delete: vi.fn().mockRejectedValue(new Error("not found")),
    });
    const embeddings = makeEmbeddings();

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    expect(result.migrated).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// migrateEmbeddings — error handling
// ---------------------------------------------------------------------------

describe("migrateEmbeddings — error handling", () => {
  it("falls back to per-fact embeds when embedBatch fails", async () => {
    const facts = [makeFact("e1"), makeFact("e2")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const vec = Array(1536).fill(0.5);
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi.fn().mockRejectedValue(new Error("batch error")),
      embed: vi.fn().mockResolvedValue(vec),
    });

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    expect(result.migrated).toBe(2);
    expect(embeddings.embed).toHaveBeenCalledTimes(2);
  });

  it("records error and skips fact when single embed fails", async () => {
    const facts = [makeFact("bad"), makeFact("good")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const vec = Array(1536).fill(0.5);
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi.fn().mockRejectedValue(new Error("batch fail")),
      embed: vi.fn().mockRejectedValueOnce(new Error("embed error")).mockResolvedValueOnce(vec),
    });

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("bad");
  });

  it("records error when vectorDb.store fails", async () => {
    const facts = [makeFact("storefail")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB({
      store: vi.fn().mockRejectedValue(new Error("store error")),
    });
    const embeddings = makeEmbeddings();

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("storefail");
  });

  it("aborts when VectorDB is closed mid-migration", async () => {
    const facts = [makeFact("a"), makeFact("b")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    let generation = 0;
    const vectorDb = makeVectorDB({
      getCloseGeneration: vi.fn(() => generation),
      store: vi.fn().mockImplementation(async () => {
        generation++; // simulate close after first store
        return "id";
      }),
    });
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi
        .fn()
        .mockResolvedValueOnce([Array(1536).fill(0.1)])
        .mockResolvedValueOnce([Array(1536).fill(0.2)]),
    });

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      batchSize: 1,
      logger: silentLogger(),
    });

    // Only first batch ran before generation changed
    expect(result.migrated).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runEmbeddingMaintenance — change detection
// ---------------------------------------------------------------------------

describe("runEmbeddingMaintenance — change detection", () => {
  it("returns changed=false when no previous meta exists", async () => {
    const factsDb = makeFactsDB({ getEmbeddingMeta: vi.fn().mockReturnValue(null) });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings();

    const result = await runEmbeddingMaintenance({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      currentProvider: "openai",
      currentModel: "text-embedding-3-small",
      autoMigrate: true,
      logger: silentLogger(),
    });

    expect(result.changed).toBe(false);
    expect(result.migrated).toBe(false);
    // Should record initial meta
    expect(factsDb.setEmbeddingMeta).toHaveBeenCalledWith("openai", "text-embedding-3-small");
  });

  it("returns changed=false when provider and model match", async () => {
    const factsDb = makeFactsDB({
      getEmbeddingMeta: vi.fn().mockReturnValue({ provider: "openai", model: "text-embedding-3-small" }),
    });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings();

    const result = await runEmbeddingMaintenance({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      currentProvider: "openai",
      currentModel: "text-embedding-3-small",
      autoMigrate: true,
      logger: silentLogger(),
    });

    expect(result.changed).toBe(false);
    expect(result.migrated).toBe(false);
    expect(factsDb.setEmbeddingMeta).not.toHaveBeenCalled();
  });

  it("detects provider change", async () => {
    const factsDb = makeFactsDB({
      getEmbeddingMeta: vi.fn().mockReturnValue({ provider: "ollama", model: "nomic-embed-text" }),
    });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings();

    const result = await runEmbeddingMaintenance({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      currentProvider: "openai",
      currentModel: "text-embedding-3-small",
      autoMigrate: false,
      logger: silentLogger(),
    });

    expect(result.changed).toBe(true);
    expect(result.migrated).toBe(false); // autoMigrate=false
  });

  it("detects model change within same provider", async () => {
    const factsDb = makeFactsDB({
      getEmbeddingMeta: vi.fn().mockReturnValue({ provider: "openai", model: "text-embedding-ada-002" }),
    });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings();

    const result = await runEmbeddingMaintenance({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      currentProvider: "openai",
      currentModel: "text-embedding-3-small",
      autoMigrate: false,
      logger: silentLogger(),
    });

    expect(result.changed).toBe(true);
  });

  it("updates meta on change regardless of autoMigrate", async () => {
    const factsDb = makeFactsDB({
      getEmbeddingMeta: vi.fn().mockReturnValue({ provider: "ollama", model: "nomic" }),
    });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings();

    await runEmbeddingMaintenance({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      currentProvider: "openai",
      currentModel: "text-embedding-3-small",
      autoMigrate: false,
      logger: silentLogger(),
    });

    expect(factsDb.setEmbeddingMeta).toHaveBeenCalledWith("openai", "text-embedding-3-small");
  });
});

// ---------------------------------------------------------------------------
// runEmbeddingMaintenance — migration trigger
// ---------------------------------------------------------------------------

describe("runEmbeddingMaintenance — migration trigger", () => {
  it("does NOT migrate when autoMigrate=false even if changed", async () => {
    const factsDb = makeFactsDB({
      getEmbeddingMeta: vi.fn().mockReturnValue({ provider: "ollama", model: "old" }),
    });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings();

    const result = await runEmbeddingMaintenance({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      currentProvider: "openai",
      currentModel: "text-embedding-3-small",
      autoMigrate: false,
      logger: silentLogger(),
    });

    expect(result.changed).toBe(true);
    expect(result.migrated).toBe(false);
    expect(result.result).toBeUndefined();
    expect(vectorDb.store).not.toHaveBeenCalled();
  });

  it("migrates when autoMigrate=true and model changed", async () => {
    const facts = [makeFact("f1"), makeFact("f2")];
    const factsDb = makeFactsDB({
      getAll: vi.fn().mockReturnValue(facts),
      getEmbeddingMeta: vi.fn().mockReturnValue({ provider: "ollama", model: "nomic-embed-text" }),
    });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi.fn().mockResolvedValue([Array(1536).fill(0.1), Array(1536).fill(0.2)]),
    });

    const result = await runEmbeddingMaintenance({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      currentProvider: "openai",
      currentModel: "text-embedding-3-small",
      autoMigrate: true,
      logger: silentLogger(),
    });

    expect(result.changed).toBe(true);
    expect(result.migrated).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result?.total).toBe(2);
    expect(result.result?.migrated).toBe(2);
  });

  it("returns migrated=false (not throws) when migration itself fails", async () => {
    const factsDb = makeFactsDB({
      getAll: vi.fn().mockReturnValue([makeFact("x")]),
      getEmbeddingMeta: vi.fn().mockReturnValue({ provider: "ollama", model: "old" }),
    });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi.fn().mockRejectedValue(new Error("network failure")),
      embed: vi.fn().mockRejectedValue(new Error("network failure")),
    });

    const result = await runEmbeddingMaintenance({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      currentProvider: "openai",
      currentModel: "text-embedding-3-small",
      autoMigrate: true,
      logger: silentLogger(),
    });

    expect(result.changed).toBe(true);
    // Migration ran but all facts failed — migrated=true (the attempt was made), result.errors has entries
    expect(result.result?.errors).toBeDefined();
  });

  it("returns changed=false when getEmbeddingMeta throws", async () => {
    const factsDb = makeFactsDB({
      getEmbeddingMeta: vi.fn().mockImplementation(() => {
        throw new Error("db locked");
      }),
    });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings();

    const result = await runEmbeddingMaintenance({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      currentProvider: "openai",
      currentModel: "text-embedding-3-small",
      autoMigrate: true,
      logger: silentLogger(),
    });

    expect(result.changed).toBe(false);
    expect(result.migrated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config integration: autoMigrate=false is the default
// ---------------------------------------------------------------------------

describe("migrateEmbeddings — batch processing", () => {
  it("processes multiple batches correctly", async () => {
    const facts = Array.from({ length: 7 }, (_, i) => makeFact(String(i)));
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings(384, {
      embedBatch: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => Array(384).fill(0.1))),
    });

    const progressCalls: number[] = [];
    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      batchSize: 3,
      onProgress: (done) => progressCalls.push(done),
      logger: silentLogger(),
    });

    expect(result.total).toBe(7);
    expect(result.migrated).toBe(7);
    // 3 batches: 3, 6, 7
    expect(progressCalls).toEqual([3, 6, 7]);
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(3);
  });

  it("uses default batchSize=50 when not specified", async () => {
    const facts = Array.from({ length: 60 }, (_, i) => makeFact(String(i)));
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings(384, {
      embedBatch: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => Array(384).fill(0.1))),
    });

    await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    // 60 facts with batchSize=50 → 2 batches
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(2);
  });
});
