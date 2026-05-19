/**
 * Semantic query cache tolerance when the cache table is not initialized (issue #1469).
 * Lookup/store must degrade gracefully (null / no-op) instead of throwing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../backends/vector-db.js";

describe("VectorDB semantic cache when table is unavailable (#1469)", () => {
  const DIM = 3;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setDegradedCacheState(db: VectorDB): void {
    const internals = db as unknown as {
      lanceDbAvailable: boolean;
      lanceInitFailed: boolean;
      semanticQueryCacheTable: object | null;
      semanticQueryCacheSchemaValid: boolean;
      table: object | null;
    };
    internals.lanceDbAvailable = true;
    internals.lanceInitFailed = false;
    internals.semanticQueryCacheTable = null;
    internals.semanticQueryCacheSchemaValid = false;
    internals.table = {};
  }

  it("getSemanticQueryCacheMatch returns null without throwing", async () => {
    const db = new VectorDB("/tmp/test-semantic-cache-lookup-missing", DIM);
    setDegradedCacheState(db);

    vi.spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized").mockResolvedValue(
      undefined,
    );

    await expect(
      db.getSemanticQueryCacheMatch(new Array(DIM).fill(0.1), { filterKey: "test", minSimilarity: 0.9 }),
    ).resolves.toBeNull();
  });

  it("storeSemanticQueryCache is a no-op without throwing", async () => {
    const db = new VectorDB("/tmp/test-semantic-cache-store-missing", DIM);
    setDegradedCacheState(db);

    vi.spyOn(db as unknown as { ensureInitialized: () => Promise<void> }, "ensureInitialized").mockResolvedValue(
      undefined,
    );

    await expect(
      db.storeSemanticQueryCache({
        queryText: "test query",
        vector: new Array(DIM).fill(0.2),
        factIds: ["fact-a"],
        filterKey: "test",
      }),
    ).resolves.toBeUndefined();
  });
});
