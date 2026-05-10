import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VectorDB } from "../backends/vector-db.js";
import { _testing } from "../index.js";
import { replayWalEntries } from "../utils/wal-replay.js";

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

describe("replayWalEntries", () => {
  it("removes store entries with whitespace-only text instead of retrying forever", async () => {
    await wal.write(walEntry({ data: { text: "   ", category: "fact", source: "test" } }));

    const result = await replayWalEntries(wal, factsDb);

    expect(result).toEqual({ committed: 0, skipped: 1 });
    expect(await wal.readAll()).toHaveLength(0);
  });

  it("ignores invalid WAL scopes instead of passing them into FactsDB.store", async () => {
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

    const result = await replayWalEntries(wal, factsDb);

    expect(result.committed).toBe(1);
    const stored = factsDb
      .getRawDb()
      .prepare("SELECT scope, scope_target FROM facts WHERE text = ?")
      .get("Scoped replay fact") as {
      scope: string;
      scope_target: string | null;
    };
    expect(stored.scope).toBe("global");
    expect(stored.scope_target).toBeNull();
    expect(await wal.readAll()).toHaveLength(0);
  });

  it("does not label a precomputed WAL vector with the current embedding model", async () => {
    const vectorDb = {
      store: vi.fn().mockResolvedValue(undefined),
    } as unknown as VectorDB;
    const embeddings = {
      modelName: "current-model",
      embed: vi.fn().mockResolvedValue([0.9, 0.1]),
    };
    await wal.write(
      walEntry({
        data: {
          text: "Precomputed vector fact",
          category: "fact",
          source: "test",
          vector: [0.1, 0.2, 0.3],
        },
      }),
    );

    await replayWalEntries(wal, factsDb, vectorDb, embeddings as never);

    const stored = factsDb.getRawDb().prepare("SELECT id FROM facts WHERE text = ?").get("Precomputed vector fact") as {
      id: string;
    };
    expect(vectorDb.store).toHaveBeenCalledWith(expect.objectContaining({ id: stored.id, vector: [0.1, 0.2, 0.3] }));
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(factsDb.getById(stored.id)?.embeddingModel).toBeNull();
    expect(factsDb.getEmbeddings(stored.id)).toHaveLength(0);
  });

  it("does not link an update replay to an unrelated existing fact with identical text and source", async () => {
    const target = factsDb.store({
      text: "Old target",
      category: "fact",
      source: "test",
    });
    const unrelated = factsDb.store({
      text: "Shared replacement",
      category: "fact",
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
