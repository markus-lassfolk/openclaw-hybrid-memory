import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VectorDB } from "../backends/vector-db.js";
import { _testing } from "../index.js";
import * as errorReporter from "../services/error-reporter.js";
import { replayWalEntries, replayWalEntriesWithRepair } from "../utils/wal-replay.js";

const { FactsDB, WriteAheadLog } = _testing;

let tmpDir: string;
let factsDb: InstanceType<typeof FactsDB>;
let wal: InstanceType<typeof WriteAheadLog>;

function walEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    operation: "store" as const,
    data: {
      text: "Replay fact",
      category: "fact",
      source: "test",
      importance: 0.6,
    },
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "wal-replay-test-"));
  factsDb = new FactsDB(join(tmpDir, "facts.db"));
  wal = new WriteAheadLog(join(tmpDir, "test.wal"), 5 * 60 * 1000);
  await wal.init();
});

afterEach(() => {
  factsDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("replayWalEntries — scope preservation (issue #1574)", () => {
  it("replays an agent-scoped WAL entry with original scope and scopeTarget preserved", async () => {
    await wal.write(
      walEntry({
        data: {
          text: "Agent-scoped fact",
          category: "fact",
          source: "conversation",
          importance: 0.7,
          scope: "agent",
          scopeTarget: "agent-1",
        },
      }),
    );

    const result = await replayWalEntries(wal, factsDb);

    expect(result).toEqual({ committed: 1, skipped: 0 });
    const stored = factsDb
      .getRawDb()
      .prepare("SELECT scope, scope_target FROM facts WHERE text = ?")
      .get("Agent-scoped fact") as { scope: string; scope_target: string | null };
    expect(stored.scope).toBe("agent");
    expect(stored.scope_target).toBe("agent-1");
    expect(await wal.readAll()).toHaveLength(0);
  });

  it("replays a user-scoped WAL entry with original scope and scopeTarget preserved", async () => {
    await wal.write(
      walEntry({
        data: {
          text: "User-scoped fact",
          category: "fact",
          source: "conversation",
          scope: "user",
          scopeTarget: "user-42",
        },
      }),
    );

    const result = await replayWalEntries(wal, factsDb);

    expect(result).toEqual({ committed: 1, skipped: 0 });
    const stored = factsDb
      .getRawDb()
      .prepare("SELECT scope, scope_target FROM facts WHERE text = ?")
      .get("User-scoped fact") as { scope: string; scope_target: string | null };
    expect(stored.scope).toBe("user");
    expect(stored.scope_target).toBe("user-42");
    expect(await wal.readAll()).toHaveLength(0);
  });

  it("skips a store WAL entry with non-global scope but no scopeTarget, emits diagnostic, removes entry", async () => {
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy };

    await wal.write(
      walEntry({
        data: {
          text: "Orphaned scoped fact",
          category: "fact",
          source: "conversation",
          scope: "agent",
          // scopeTarget intentionally omitted — simulates pre-fix WAL entry from a crash window
        },
      }),
    );

    const result = await replayWalEntries(wal, factsDb, undefined, undefined, logger);

    expect(result).toEqual({ committed: 0, skipped: 1 });
    // Fact must NOT have been stored (would be globalized otherwise)
    const row = factsDb.getRawDb().prepare("SELECT id FROM facts WHERE text = ?").get("Orphaned scoped fact");
    expect(row).toBeUndefined();
    // WAL entry must be removed so it doesn't retry indefinitely
    expect(await wal.readAll()).toHaveLength(0);
    // Operator-visible warning must have been emitted
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("scopeTarget");
  });

  it("skips an update WAL entry with non-global scope but no scopeTarget, emits diagnostic", async () => {
    const target = factsDb.store({
      text: "Old agent fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
    });
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy };

    await wal.write(
      walEntry({
        operation: "update",
        targetId: target.id,
        data: {
          text: "Updated agent fact",
          category: "fact",
          source: "conversation",
          scope: "session",
          // scopeTarget intentionally omitted
        },
      }),
    );

    const result = await replayWalEntries(wal, factsDb, undefined, undefined, logger);

    expect(result).toEqual({ committed: 0, skipped: 1 });
    expect(factsDb.getById(target.id)?.supersededBy).toBeNull();
    expect(await wal.readAll()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("scopeTarget");
  });

  it("crash-window regression: WAL entry with scope replays fact correctly when DB is empty", async () => {
    // Simulates a crash after WAL write but before factsDb.store() completed
    await wal.write(
      walEntry({
        data: {
          text: "Crash-window scoped fact",
          category: "preference",
          source: "conversation",
          importance: 0.8,
          scope: "agent",
          scopeTarget: "specialist-agent",
        },
      }),
    );

    // DB is empty at this point (crash happened before store)
    expect(factsDb.getRawDb().prepare("SELECT COUNT(*) as count FROM facts").get()).toEqual({ count: 0 });

    const result = await replayWalEntries(wal, factsDb);

    expect(result).toEqual({ committed: 1, skipped: 0 });
    const stored = factsDb
      .getRawDb()
      .prepare("SELECT scope, scope_target FROM facts WHERE text = ?")
      .get("Crash-window scoped fact") as { scope: string; scope_target: string | null };
    // Scope must be preserved exactly — not silently upgraded to global
    expect(stored.scope).toBe("agent");
    expect(stored.scope_target).toBe("specialist-agent");
    expect(await wal.readAll()).toHaveLength(0);
  });
});

describe("replayWalEntries", () => {
  it("removes store entries with whitespace-only text instead of retrying forever", async () => {
    await wal.write(walEntry({ data: { text: "   ", category: "fact", source: "test" } }));

    const result = await replayWalEntries(wal, factsDb);

    expect(result).toEqual({ committed: 0, skipped: 1 });
    expect(await wal.readAll()).toHaveLength(0);
  });

  it("skips invalid WAL scopes instead of passing them into FactsDB.store", async () => {
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy };

    await wal.write(
      walEntry({
        data: {
          text: "Scoped replay fact",
          category: "fact",
          source: "test",
          scope: "corrupted-scope",
          scopeTarget: "agent-1",
        },
      }),
    );

    const result = await replayWalEntries(wal, factsDb, undefined, undefined, logger);

    expect(result).toEqual({ committed: 0, skipped: 1 });
    const row = factsDb.getRawDb().prepare("SELECT id FROM facts WHERE text = ?").get("Scoped replay fact");
    expect(row).toBeUndefined();
    expect(await wal.readAll()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("invalid scope");
  });

  it("uses WAL embedding model metadata for precomputed vectors", async () => {
    const vectorDb = {
      store: vi.fn().mockResolvedValue(undefined),
    } as unknown as VectorDB;
    const embeddings = {
      modelName: "text-embedding-3-large",
      embed: vi.fn().mockResolvedValue([0.9, 0.1]),
    };
    await wal.write(
      walEntry({
        data: {
          text: "Precomputed vector fact",
          category: "fact",
          source: "test",
          vector: [0.1, 0.2, 0.3],
          embeddingModelName: "text-embedding-3-small",
        },
      }),
    );

    await replayWalEntries(wal, factsDb, vectorDb, embeddings as never);

    const stored = factsDb.getRawDb().prepare("SELECT id FROM facts WHERE text = ?").get("Precomputed vector fact") as {
      id: string;
    };
    expect(vectorDb.store).toHaveBeenCalledWith(expect.objectContaining({ id: stored.id, vector: [0.1, 0.2, 0.3] }));
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(factsDb.getById(stored.id)?.embeddingModel).toBe("text-embedding-3-small");
    expect(factsDb.getEmbeddings(stored.id)).toEqual([
      {
        model: "text-embedding-3-small",
        variant: "canonical",
        embedding: new Float32Array([0.1, 0.2, 0.3]),
      },
    ]);
  });

  it("falls back to runtime embedding model for legacy WAL vectors without model metadata", async () => {
    const vectorDb = {
      store: vi.fn().mockResolvedValue(undefined),
    } as unknown as VectorDB;
    const embeddings = {
      modelName: "legacy-runtime-model",
      embed: vi.fn().mockResolvedValue([0.9, 0.1]),
    };
    await wal.write(
      walEntry({
        data: {
          text: "Legacy precomputed vector fact",
          category: "fact",
          source: "test",
          vector: [0.4, 0.5, 0.6],
        },
      }),
    );

    await replayWalEntries(wal, factsDb, vectorDb, embeddings as never);

    const stored = factsDb
      .getRawDb()
      .prepare("SELECT id FROM facts WHERE text = ?")
      .get("Legacy precomputed vector fact") as {
      id: string;
    };
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(factsDb.getById(stored.id)?.embeddingModel).toBe("legacy-runtime-model");
    expect(factsDb.getEmbeddings(stored.id)).toEqual([
      {
        model: "legacy-runtime-model",
        variant: "canonical",
        embedding: new Float32Array([0.4, 0.5, 0.6]),
      },
    ]);
  });

  it("rejects the whole precomputed vector (not just the NaN elements) and falls back to re-embedding (#52)", async () => {
    const vectorDb = {
      store: vi.fn().mockResolvedValue(undefined),
    } as unknown as VectorDB;
    const embeddings = {
      modelName: "fallback-model",
      embed: vi.fn().mockResolvedValue([0.7, 0.8, 0.9]),
    };
    await wal.write(
      walEntry({
        data: {
          text: "NaN-corrupted vector fact",
          category: "fact",
          source: "test",
          // A partially-NaN vector must not be silently shrunk below the table's dimension —
          // it must be treated as fully invalid and trigger a re-embed instead.
          vector: [0.1, Number.NaN, 0.3],
        },
      }),
    );

    await replayWalEntries(wal, factsDb, vectorDb, embeddings as never);

    expect(embeddings.embed).toHaveBeenCalledWith("NaN-corrupted vector fact");
    expect(vectorDb.store).toHaveBeenCalledWith(expect.objectContaining({ vector: [0.7, 0.8, 0.9] }));
    expect(vectorDb.store).not.toHaveBeenCalledWith(expect.objectContaining({ vector: [0.1, 0.3] }));
  });

  it("reports a precomputed-vector store failure instead of silently dropping it (#52)", async () => {
    const captureSpy = vi.spyOn(errorReporter, "capturePluginError").mockImplementation(() => undefined);
    const vectorDb = {
      store: vi.fn().mockRejectedValue(new Error("dim mismatch")),
    } as unknown as VectorDB;
    const embeddings = {
      modelName: "fallback-model",
      embed: vi.fn().mockRejectedValue(new Error("embed also failed")),
    };
    await wal.write(
      walEntry({
        data: {
          text: "Store-failure vector fact",
          category: "fact",
          source: "test",
          vector: [0.1, 0.2, 0.3],
        },
      }),
    );

    await replayWalEntries(wal, factsDb, vectorDb, embeddings as never);

    const storeFailureCalls = captureSpy.mock.calls.filter(
      ([, ctx]) => (ctx as { operation?: string })?.operation === "store-precomputed-vector",
    );
    expect(storeFailureCalls.length).toBeGreaterThan(0);
    const fallbackFailureCalls = captureSpy.mock.calls.filter(
      ([, ctx]) => (ctx as { operation?: string })?.operation === "embed-and-store-fallback",
    );
    expect(fallbackFailureCalls.length).toBeGreaterThan(0);
    captureSpy.mockRestore();
  });

  it("removes store entries when store-side dedupe already handled the write", async () => {
    factsDb.store({
      text: "Replay duplicate fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    await wal.write(
      walEntry({
        data: {
          text: "Replay duplicate fact",
          category: "fact",
          source: "test",
          importance: 0.9,
        },
      }),
    );

    const result = await replayWalEntries(wal, factsDb);

    expect(result).toEqual({ committed: 0, skipped: 1 });
    expect(factsDb.getRawDb().prepare("SELECT COUNT(*) as count FROM facts").get()).toEqual({ count: 1 });
    expect(await wal.readAll()).toHaveLength(0);
  });

  it("does not link an update replay to an unrelated existing fact with identical text and source", async () => {
    const target = factsDb.store({
      text: "Old target",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const unrelated = factsDb.store({
      text: "Shared replacement",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    await wal.write(
      walEntry({
        operation: "update",
        targetId: target.id,
        data: {
          text: "Shared replacement",
          category: "fact",
          source: "test",
        },
      }),
    );

    const result = await replayWalEntries(wal, factsDb);

    expect(result).toEqual({ committed: 0, skipped: 1 });
    expect(factsDb.getById(target.id)?.supersededBy).toBeNull();
    expect(factsDb.getById(unrelated.id)?.supersedesId).toBeUndefined();
    expect(await wal.readAll()).toHaveLength(0);
  });
});

describe("replayWalEntriesWithRepair — corruption recovery", () => {
  it("repairs corrupt WAL lines and replays recoverable entries", async () => {
    const entry = walEntry({ data: { text: "Corruption survivor", category: "fact", source: "test" } });
    await wal.write(entry);
    appendFileSync(wal.getPath(), "{not valid wal json}\n", "utf-8");

    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await replayWalEntriesWithRepair(wal, factsDb, undefined, undefined, logger, "test-repair");

    expect(result).toEqual({ committed: 1, skipped: 0 });
    expect(factsDb.getRawDb().prepare("SELECT COUNT(*) AS c FROM facts").get()).toEqual({ c: 1 });
    expect(await wal.readAll()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("detected corruption"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("retrying test-repair"));
  });
});
