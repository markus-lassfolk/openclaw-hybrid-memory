/**
 * optimize + semantic cache
 */
import { vi } from "vitest";

const { mockCapturePluginError } = vi.hoisted(() => ({
  mockCapturePluginError: vi.fn(),
}));

vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: mockCapturePluginError,
}));

import * as errorReporter from "../services/error-reporter.js";

import {
  CORRECT_DIM,
  WRONG_DIM,
  VectorDB,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  join,
  mkdtempSync,
  rmSync,
  seedTable,
  tmpdir,
} from "./helpers/vector-db-test-shared.js";

describe("VectorDB.optimize() — compaction and version pruning (issue #292)", () => {
  let tmpDir: string;
  let lanceDir: string;
  let db: InstanceType<typeof VectorDB>;

  const DIM = 3;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-optimize-test-"));
    lanceDir = join(tmpDir, "lance");
    db = new VectorDB(lanceDir, DIM);
    // Store a few rows to create multiple fragments
    for (let i = 0; i < 3; i++) {
      await db.store({
        text: `fact ${i}`,
        vector: [0.1 * i, 0.2 * i, 0.3 * i],
        importance: 0.5,
        category: "fact",
      });
    }
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns compacted and removed stats with numeric values", async () => {
    const stats = await db.optimize();
    expect(typeof stats.compacted).toBe("number");
    expect(typeof stats.removedFragments).toBe("number");
    expect(typeof stats.freedBytes).toBe("number");
    expect(stats.compacted).toBeGreaterThanOrEqual(0);
    expect(stats.removedFragments).toBeGreaterThanOrEqual(0);
  });

  it("accepts a custom olderThanMs parameter", async () => {
    // Should not throw when called with a custom retention window
    const stats = await db.optimize(24 * 60 * 60 * 1000);
    expect(typeof stats.compacted).toBe("number");
    expect(typeof stats.removedFragments).toBe("number");
    expect(typeof stats.freedBytes).toBe("number");
  });

  it("DB remains usable after optimize — can still store and search", async () => {
    await db.optimize();
    const id = await db.store({
      text: "post-optimize fact",
      vector: [0.5, 0.5, 0.5],
      importance: 0.8,
      category: "fact",
    });
    expect(typeof id).toBe("string");
    const results = await db.search([0.5, 0.5, 0.5], 5, 0);
    expect(results.some((r) => r.entry.text === "post-optimize fact")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VectorDB issue #366 — no GlitchTip spam on dimension mismatch
// When validateOrRepairSchema() sets schemaValid=false at startup, subsequent
// search() and hasDuplicate() calls must NOT invoke capturePluginError, since
// the problem was already logged once at init.
// ---------------------------------------------------------------------------

describe("VectorDB issue #366 — capturePluginError suppressed on schema mismatch", () => {
  let tmpDir: string;
  let lanceDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-366-test-"));
    lanceDir = join(tmpDir, "lance");
    // Seed with WRONG_DIM to simulate a table created by an old embedding model
    await seedTable(lanceDir, WRONG_DIM);
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("search() does not call capturePluginError on dimension mismatch", async () => {
    const db = new VectorDB(lanceDir, CORRECT_DIM);
    const results = await db.search(new Array(CORRECT_DIM).fill(0.1), 5, 0);
    expect(results).toHaveLength(0);
    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
    await db.close();
  });

  it("hasDuplicate() does not call capturePluginError on dimension mismatch", async () => {
    const db = new VectorDB(lanceDir, CORRECT_DIM);
    const isDup = await db.hasDuplicate(new Array(CORRECT_DIM).fill(0.1));
    expect(isDup).toBe(false);
    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
    await db.close();
  });

  it("repeated search() calls do not call capturePluginError", async () => {
    const db = new VectorDB(lanceDir, CORRECT_DIM);
    // Multiple calls in the same session — each would previously report to GlitchTip
    for (let i = 0; i < 5; i++) {
      await db.search(new Array(CORRECT_DIM).fill(0.1), 5, 0);
    }
    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
    await db.close();
  });

  it("capturePluginError IS called for unexpected (non-schema) errors", async () => {
    // Open with matching dimensions — schemaValid will be true after init
    const db = new VectorDB(lanceDir, WRONG_DIM);
    await db.count(); // trigger initialization so this.table is populated

    // Inject an unexpected (non-schema) error by replacing the internal table with a
    // stub whose vectorSearch throws a generic error. schemaValid is still true, so
    // the catch block must NOT suppress capturePluginError.
    const unexpectedErr = new Error("Unexpected I/O failure");
    (db as any).table = {
      vectorSearch: () => {
        throw unexpectedErr;
      },
    };

    const results = await db.search(new Array(WRONG_DIM).fill(0.1), 5, 0);
    expect(results).toHaveLength(0);
    expect(vi.mocked(errorReporter.capturePluginError)).toHaveBeenCalledOnce();
    expect(vi.mocked(errorReporter.capturePluginError)).toHaveBeenCalledWith(
      unexpectedErr,
      expect.objectContaining({ operation: "vector-search" }),
    );
    await db.close();
  });
});

describe("VectorDB semantic query cache — suppress known schema errors", () => {
  let tmpDir: string;
  let lanceDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-cache-schema-test-"));
    lanceDir = join(tmpDir, "lance");
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rebuilds the semantic query cache after a known runtime schema failure without reporting GlitchTip", async () => {
    const db = new VectorDB(lanceDir, CORRECT_DIM);

    await db.storeSemanticQueryCache({
      queryText: "legacy query",
      vector: [1, 0, 0],
      factIds: ["fact-1"],
      filterKey: "test",
    });

    const knownSchemaErr = new Error(
      "Failed to execute query stream: GenericFailure, Invalid input, No vector column found to match with the query vector dimension",
    );

    (db as any).semanticQueryCacheTable = {
      vectorSearch: () => {
        throw knownSchemaErr;
      },
    };

    const match = await db.getSemanticQueryCacheMatch([1, 0, 0], {
      filterKey: "test",
      minSimilarity: 0.95,
      ttlMs: 60_000,
    });

    expect(match).toBeNull();
    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();

    await db.storeSemanticQueryCache({
      queryText: "fresh query",
      vector: [0, 1, 0],
      factIds: ["fact-2"],
      filterKey: "test",
    });

    const repairedMatch = await db.getSemanticQueryCacheMatch([0, 1, 0], {
      filterKey: "test",
      minSimilarity: 0.95,
      ttlMs: 60_000,
    });

    expect(repairedMatch?.factIds).toEqual(["fact-2"]);
    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
    await db.close();
  });

  it("issue #1464: storeSemanticQueryCache survives prune when cache table is cleared mid-flight", async () => {
    const db = new VectorDB(lanceDir, CORRECT_DIM);
    await db.storeSemanticQueryCache({
      queryText: "warm",
      vector: [1, 0, 0],
      factIds: ["warm"],
      filterKey: "race",
    });

    const dbWithCacheGetter = db as unknown as {
      getSemanticQueryCacheTable: () => unknown;
    };
    const cacheTable = dbWithCacheGetter.getSemanticQueryCacheTable();
    expect(cacheTable).toBeTruthy();
    let getTableCalls = 0;
    vi.spyOn(dbWithCacheGetter, "getSemanticQueryCacheTable").mockImplementation(() => {
      getTableCalls += 1;
      return getTableCalls === 1 ? cacheTable : null;
    });

    await db.storeSemanticQueryCache({
      queryText: "race query",
      vector: [1, 0, 0],
      factIds: ["fact-race"],
      filterKey: "race",
    });

    expect(vi.mocked(errorReporter.capturePluginError)).not.toHaveBeenCalled();
    expect(getTableCalls).toBe(2);
    await db.close();
  });

  it("issue #1464: concurrent storeSemanticQueryCache during repair does not throw to caller", async () => {
    const db = new VectorDB(lanceDir, CORRECT_DIM);
    await db.storeSemanticQueryCache({
      queryText: "warm",
      vector: [1, 0, 0],
      factIds: ["warm"],
      filterKey: "concurrent-race",
    });

    const internal = db as unknown as {
      semanticQueryCacheRepairPromise: Promise<void> | null;
    };
    const slowRepair = new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    internal.semanticQueryCacheRepairPromise = slowRepair;

    await expect(
      db.storeSemanticQueryCache({
        queryText: "during-repair",
        vector: [0, 1, 0],
        factIds: ["during-repair"],
        filterKey: "concurrent-race",
      }),
    ).resolves.toBeUndefined();

    await slowRepair;
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// VectorDB issue #599 — search() must not return optimistic placeholder metadata
// Fields not stored in LanceDB (confidence, source, decayClass, entity, key, value,
// expiresAt, lastConfirmedAt) must use conservative/unknown defaults so un-enriched
// results are not falsely ranked highly.
// ---------------------------------------------------------------------------
