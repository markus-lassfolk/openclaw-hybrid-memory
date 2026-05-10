// @ts-nocheck
/**
 * Tests for embedding-migration service (Issue #153).
 *
 * All backends are mocked — no real SQLite / LanceDB / embedding API required.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type EmbeddingMaintenanceOptions,
  type MigrateEmbeddingsOptions,
  migrateEmbeddings,
  runEmbeddingMaintenance,
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
  ensureInitialized: ReturnType<typeof vi.fn>;
  isLanceAvailable: ReturnType<typeof vi.fn>;
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
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
    isLanceAvailable: vi.fn().mockReturnValue(true),
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
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    expect(result.total).toBe(0);
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.aborted).toBe(false);
    expect(result.processed).toBe(0);
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
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    expect(result.total).toBe(3);
    expect(result.migrated).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.aborted).toBe(false);
    expect(result.processed).toBe(3);
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
      edictStore: null as any,
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
      edictStore: null as any,
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
      edictStore: null as any,
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
      edictStore: null as any,
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
      edictStore: null as any,
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
      edictStore: null as any,
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
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("storefail");
  });

  it("transparently reconnects when VectorDB closeGeneration advances mid-migration (issue #1248)", async () => {
    const facts = [makeFact("a"), makeFact("b"), makeFact("c")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    let generation = 0;
    const vectorDb = makeVectorDB({
      getCloseGeneration: vi.fn(() => generation),
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      store: vi.fn().mockImplementation(async () => {
        if (generation === 0) generation++; // simulate close after first store
        return "id";
      }),
    });
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi
        .fn()
        .mockResolvedValueOnce([Array(1536).fill(0.1)])
        .mockResolvedValueOnce([Array(1536).fill(0.2)])
        .mockResolvedValueOnce([Array(1536).fill(0.3)]),
    });
    const logger = silentLogger();

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      batchSize: 1,
      logger,
    });

    // All 3 facts should be migrated (transparent reconnect on generation change).
    // The previous behaviour (hard abort on closeGeneration bump from #1247)
    // is now replaced by a transparent reconnect — see #1248.
    expect(result.migrated).toBe(3);
    expect(result.aborted).toBe(false);
    expect(result.processed).toBe(3);
    expect(result.total).toBe(3);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("closeGeneration advanced"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("reconnect successful"));
    expect(vectorDb.ensureInitialized).toHaveBeenCalledTimes(1);
  });

  it("aborts (does not silently succeed) when reconnect leaves LanceDB in degraded mode", async () => {
    // `ensureInitialized()` resolves successfully even when LanceDB stays in
    // degraded/FTS-only mode (`lanceInitFailed === true`). In that state
    // `vectorDb.store()` is a silent no-op, so we MUST treat the reconnect
    // as a hard abort instead of logging "reconnect successful" and writing
    // vectors into the void. (Copilot review on PR #1252.)
    const facts = [makeFact("a"), makeFact("b"), makeFact("c")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    let generation = 0;
    let lanceUp = true;
    const vectorDb = makeVectorDB({
      getCloseGeneration: vi.fn(() => generation),
      // Reconnect resolves but LanceDB never came back up.
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      isLanceAvailable: vi.fn(() => lanceUp),
      store: vi.fn().mockImplementation(async () => {
        if (generation === 0) {
          generation++;
          lanceUp = false;
        }
        return "id";
      }),
    });
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi
        .fn()
        .mockResolvedValueOnce([Array(1536).fill(0.1)])
        .mockResolvedValueOnce([Array(1536).fill(0.2)])
        .mockResolvedValueOnce([Array(1536).fill(0.3)]),
    });
    const logger = silentLogger();

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      batchSize: 1,
      logger,
    });

    expect(result.aborted).toBe(true);
    expect(result.abortReason).toContain("LanceDB is unavailable (degraded mode)");
    expect(result.migrated).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.total).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("aborted at 1/3 — VectorDB reconnected but LanceDB is unavailable"),
    );
    // Crucially, we must NOT have logged the success line in this case.
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining("reconnect successful"));
  });

  it("aborts with a clear reason when reconnect itself throws", async () => {
    const facts = [makeFact("a"), makeFact("b")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    let generation = 0;
    const vectorDb = makeVectorDB({
      getCloseGeneration: vi.fn(() => generation),
      ensureInitialized: vi.fn().mockRejectedValue(new Error("connection refused")),
      store: vi.fn().mockImplementation(async () => {
        if (generation === 0) generation++;
        return "id";
      }),
    });
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi
        .fn()
        .mockResolvedValueOnce([Array(1536).fill(0.1)])
        .mockResolvedValueOnce([Array(1536).fill(0.2)]),
    });
    const logger = silentLogger();

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      batchSize: 1,
      logger,
    });

    expect(result.aborted).toBe(true);
    expect(result.abortReason).toContain("VectorDB reconnect failed: connection refused");
    expect(result.migrated).toBe(1);
    expect(result.total).toBe(2);
  });

  it("ends early (without aborting) when batched data source drains mid-run due to expiry/supersede", async () => {
    // Simulate a batched factsDb (getCount + getBatch) where the underlying
    // table shrinks between getCount and a later getBatch call — the common
    // cause is fact expiry (`expires_at > now()` re-evaluating in later
    // batches). This is normal data drift, NOT a failure: the run should
    // terminate cleanly, log an explicit "ended early" warning so operators
    // see the partial count, and allow callers to update embedding meta.
    const allFacts = [makeFact("a"), makeFact("b"), makeFact("c"), makeFact("d")];
    const factsDb = {
      ...makeFactsDB(),
      getCount: vi.fn().mockReturnValue(allFacts.length),
      getBatch: vi.fn((offset: number, _limit: number) => {
        // First batch returns 2 facts, then the source is "drained".
        if (offset === 0) return allFacts.slice(0, 2);
        return [];
      }),
    } as any;
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi.fn().mockResolvedValue([Array(1536).fill(0.1), Array(1536).fill(0.2)]),
    });
    const logger = silentLogger();

    const result = await migrateEmbeddings({
      factsDb,
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      batchSize: 2,
      logger,
    });

    expect(result.total).toBe(4);
    expect(result.migrated).toBe(2);
    expect(result.processed).toBe(2);
    // Drift is NOT a hard abort — callers may safely commit embedding meta.
    expect(result.aborted).toBe(false);
    expect(result.abortReason).toBeUndefined();
    // But operators must still see the partial-count signal explicitly.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "ended early at 2/4 — data source drained (2 facts likely expired or were superseded mid-run)",
      ),
    );
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
      edictStore: null as any,
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
      edictStore: null as any,
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
      edictStore: null as any,
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
      edictStore: null as any,
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
      edictStore: null as any,
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
      edictStore: null as any,
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
      edictStore: null as any,
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
      edictStore: null as any,
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

  it("returns migrated=true with result.aborted=true when migration is aborted, and does not update meta", async () => {
    const facts = [makeFact("m1"), makeFact("m2")];
    const factsDb = makeFactsDB({
      getAll: vi.fn().mockReturnValue(facts),
      getEmbeddingMeta: vi.fn().mockReturnValue({ provider: "ollama", model: "old" }),
    });
    let generation = 0;
    // Simulate the post-#1248 "real abort" shape: close mid-run AND the
    // reconnect attempt cannot bring LanceDB back up. Routine connection
    // recycles are now handled transparently by migrateEmbeddings, so we
    // need to model the genuinely-broken case to assert the abort path.
    const vectorDb = makeVectorDB({
      getCloseGeneration: vi.fn(() => generation),
      ensureInitialized: vi.fn().mockRejectedValue(new Error("LanceDB unavailable")),
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

    const result = await runEmbeddingMaintenance({
      factsDb: factsDb as any,
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      currentProvider: "openai",
      currentModel: "text-embedding-3-small",
      autoMigrate: true,
      batchSize: 1,
      logger: silentLogger(),
    });

    expect(result.changed).toBe(true);
    // Migration was attempted, even though it aborted — surface that to callers.
    expect(result.migrated).toBe(true);
    expect(result.result?.aborted).toBe(true);
    expect(result.result?.abortReason).toContain("VectorDB reconnect failed");
    expect(result.result?.migrated).toBe(1);
    expect(result.result?.processed).toBe(1);
    expect(result.result?.total).toBe(2);
    // Meta MUST NOT be updated on abort, so the next run will retry.
    expect(factsDb.setEmbeddingMeta).not.toHaveBeenCalled();
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
      edictStore: null as any,
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
      edictStore: null as any,
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

  it("uses default batchSize=40 when not specified", async () => {
    const facts = Array.from({ length: 60 }, (_, i) => makeFact(String(i)));
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings(384, {
      embedBatch: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => Array(384).fill(0.1))),
    });

    await migrateEmbeddings({
      factsDb: factsDb as any,
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      logger: silentLogger(),
    });

    // 60 facts with batchSize=40 → 2 batches
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// migrateEmbeddings — rate-limit handling (#940)
// ---------------------------------------------------------------------------

describe("migrateEmbeddings — rate-limit handling (#940)", () => {
  it("falls back to sequential per-fact embeds on batch 429 (not parallel)", async () => {
    const facts = [makeFact("r1"), makeFact("r2"), makeFact("r3")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const vec = Array(1536).fill(0.5);

    const embedOrder: string[] = [];
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi.fn().mockRejectedValue(Object.assign(new Error("429 Too Many Requests"), { status: 429 })),
      embed: vi.fn().mockImplementation(async (text: string) => {
        embedOrder.push(text);
        return vec;
      }),
    });

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      delayMsBetweenBatches: 1,
      logger: silentLogger(),
    });

    expect(result.migrated).toBe(3);
    expect(embeddings.embed).toHaveBeenCalledTimes(3);
    expect(embedOrder).toEqual(["fact r1", "fact r2", "fact r3"]);
  }, 15_000);

  it("uses delayMsBetweenBatches to throttle batch processing", async () => {
    const facts = Array.from({ length: 4 }, (_, i) => makeFact(String(i)));
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings(384, {
      embedBatch: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => Array(384).fill(0.1))),
    });

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      batchSize: 2,
      delayMsBetweenBatches: 10,
      logger: silentLogger(),
    });

    expect(result.total).toBe(4);
    expect(result.migrated).toBe(4);
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(2);
  });

  it("backs off on quota 403 (remaining-tokens: 0) before per-fact fallback", async () => {
    const facts = [makeFact("q1")];
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const vec = Array(1536).fill(0.5);

    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi.fn().mockRejectedValue(
        Object.assign(new Error("403 status code (no body)"), {
          status: 403,
          headers: { "remaining-tokens": "0" },
        }),
      ),
      embed: vi.fn().mockResolvedValue(vec),
    });

    const logger = silentLogger();
    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      edictStore: null as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      delayMsBetweenBatches: 1,
      logger,
    });

    expect(result.migrated).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("batch rate-limited"));
  }, 15_000);
});

describe("migrateEmbeddings — checkpoint resume", () => {
  it("resumes from checkpoint offset and clears checkpoint on success", async () => {
    const facts = Array.from({ length: 6 }, (_, i) => makeFact(`cp-${i}`));
    const factsDb = makeFactsDB({ getAll: vi.fn().mockReturnValue(facts) });
    const vectorDb = makeVectorDB();
    const embeddings = makeEmbeddings(1536, {
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => Array(1536).fill(0.2))),
    });
    const save = vi.fn();
    const clear = vi.fn();

    const result = await migrateEmbeddings({
      factsDb: factsDb as any,
      vectorDb: vectorDb as any,
      embeddings: embeddings as any,
      batchSize: 2,
      checkpoint: {
        load: () => ({ offset: 2 }),
        save: (state) => save(state),
        clear,
      },
      logger: silentLogger(),
    });

    expect(result.total).toBe(6);
    expect(result.processed).toBe(4);
    expect(result.migrated).toBe(4);
    expect(result.aborted).toBe(false);
    expect(embeddings.embedBatch).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalled();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 6, total: 6 }));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
