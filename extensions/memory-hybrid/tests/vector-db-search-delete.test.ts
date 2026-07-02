/**
 * search metadata, delete, degradation
 */
import { vi } from "vitest";

const { mockCapturePluginError } = vi.hoisted(() => ({
  mockCapturePluginError: vi.fn(),
}));

vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: mockCapturePluginError,
}));

import {
  VectorDB,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  join,
  lancedb,
  mkdtempSync,
  randomUUID,
  rmSync,
  tmpdir,
} from "./helpers/vector-db-test-shared.js";

describe("VectorDB issue #599 — search() returns partial metadata with conservative defaults", () => {
  let tmpDir: string;
  let lanceDir: string;
  let db: InstanceType<typeof VectorDB>;

  const DIM = 3;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-599-test-"));
    lanceDir = join(tmpDir, "lance");
    db = new VectorDB(lanceDir, DIM);
    await db.store({
      text: "user prefers TypeScript",
      why: "Project build tooling and lint pipeline are already TypeScript-first",
      vector: [0.1, 0.2, 0.3],
      importance: 0.8,
      category: "preference",
      id: "test-id-599",
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("search result contains real persisted fields (id, text, category, importance, createdAt)", async () => {
    const results = await db.search([0.1, 0.2, 0.3], 5, 0);
    expect(results).toHaveLength(1);
    const entry = results[0].entry;
    expect(entry.id).toBe("test-id-599");
    expect(entry.text).toBe("user prefers TypeScript");
    expect(entry.category).toBe("preference");
    expect(entry.importance).toBe(0.8);
    expect(typeof entry.createdAt).toBe("number");
    expect(entry.createdAt).toBeGreaterThan(0);
  });

  it("search result includes persisted why lineage context", async () => {
    const results = await db.search([0.1, 0.2, 0.3], 5, 0);
    expect(results).toHaveLength(1);
    expect(results[0].entry.why).toBe("Project build tooling and lint pipeline are already TypeScript-first");
  });

  it("search result confidence is 0 (conservative), not 1.0 (optimistic placeholder)", async () => {
    const results = await db.search([0.1, 0.2, 0.3], 5, 0);
    expect(results).toHaveLength(1);
    expect(results[0].entry.confidence).toBe(0);
    expect(results[0].entry.confidence).not.toBe(1.0);
  });

  it('search result source is "unknown", not "conversation" (fabricated placeholder)', async () => {
    const results = await db.search([0.1, 0.2, 0.3], 5, 0);
    expect(results).toHaveLength(1);
    expect(results[0].entry.source).toBe("unknown");
    expect(results[0].entry.source).not.toBe("conversation");
  });

  it("search result entity, key, value are null (honest partial metadata)", async () => {
    const results = await db.search([0.1, 0.2, 0.3], 5, 0);
    expect(results).toHaveLength(1);
    const entry = results[0].entry;
    expect(entry.entity).toBeNull();
    expect(entry.key).toBeNull();
    expect(entry.value).toBeNull();
  });

  it('search result decayClass is "normal" (neutral, not boosted by preferLongTerm)', async () => {
    const results = await db.search([0.1, 0.2, 0.3], 5, 0);
    expect(results).toHaveLength(1);
    expect(results[0].entry.decayClass).toBe("normal");
    expect(results[0].entry.decayClass).not.toBe("stable");
    expect(results[0].entry.decayClass).not.toBe("permanent");
  });

  it("search result expiresAt is null and lastConfirmedAt is 0 (conservative)", async () => {
    const results = await db.search([0.1, 0.2, 0.3], 5, 0);
    expect(results).toHaveLength(1);
    const entry = results[0].entry;
    expect(entry.expiresAt).toBeNull();
    expect(entry.lastConfirmedAt).toBe(0);
  });

  it("backend is lancedb", async () => {
    const results = await db.search([0.1, 0.2, 0.3], 5, 0);
    expect(results).toHaveLength(1);
    expect(results[0].backend).toBe("lancedb");
  });
});

// ---------------------------------------------------------------------------
// VectorDB issue #379 — malformed UUID suffix duplication
// delete() must log + return false instead of throwing when the UUID has a
// doubled suffix (e.g. "...831c1c1" instead of "...831c1").
// ---------------------------------------------------------------------------

describe("VectorDB issue #379 — delete() handles malformed UUIDs gracefully", () => {
  let tmpDir: string;
  let lanceDir: string;
  let db: InstanceType<typeof VectorDB>;

  const DIM = 3;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-379-test-"));
    lanceDir = join(tmpDir, "lance");
    db = new VectorDB(lanceDir, DIM);
    await db.store({ text: "seed fact", vector: [0.1, 0.2, 0.3], importance: 0.7, category: "fact" });
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false and logs a warning for the specific doubled-suffix UUID from issue #379", async () => {
    const warns: string[] = [];
    db.setLogger({ warn: (msg) => warns.push(msg) });

    // Exact malformed UUID from GlitchTip report: valid UUID with 'c1' appended
    const malformedId = "4d062d33-e366-4498-9233-4b78040831c1c1";
    const result = await db.delete(malformedId);

    expect(result).toBe(false);
    expect(warns.some((w) => w.includes("invalid UUID") && w.includes(malformedId))).toBe(true);
    // capturePluginError must NOT be called — this is a graceful skip, not an error
    expect(mockCapturePluginError).not.toHaveBeenCalled();
  });

  it("returns false and logs a warning for any UUID with extra characters appended", async () => {
    const warns: string[] = [];
    db.setLogger({ warn: (msg) => warns.push(msg) });

    const malformedId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeeeXX";
    const result = await db.delete(malformedId);

    expect(result).toBe(false);
    expect(warns.some((w) => w.includes("invalid UUID"))).toBe(true);
  });

  it("still deletes valid UUIDs correctly", async () => {
    const id = await db.store({
      text: "to be deleted",
      vector: [0.5, 0.5, 0.5],
      importance: 0.8,
      category: "fact",
    });
    const result = await db.delete(id);
    expect(result).toBe(true);
  });

  it("normalizes uppercase UUID fact ids to lowercase on store (matches delete / LanceDB id)", async () => {
    const mixedCase = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
    const returned = await db.store({
      text: "uuid case",
      vector: [0.1, 0.2, 0.3],
      importance: 0.5,
      category: "fact",
      id: mixedCase,
    });
    expect(returned).toBe(mixedCase.toLowerCase());
    expect(await db.delete(mixedCase)).toBe(true);
  });
});

describe("VectorDB getVectorsByFactIds", () => {
  let tmpDir: string;
  let lanceDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-get-ids-test-"));
    lanceDir = join(tmpDir, "lance");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns stored vectors keyed by lowercase UUID", async () => {
    const dim = 4;
    const db = new VectorDB(lanceDir, dim);
    const id1 = randomUUID();
    const id2 = randomUUID();
    const missing = randomUUID();
    await db.store({
      text: "a",
      vector: [0.1, 0.2, 0.3, 0.4],
      importance: 0.5,
      category: "pattern",
      id: id1,
    });
    await db.store({
      text: "b",
      vector: [0.5, 0.6, 0.7, 0.8],
      importance: 0.5,
      category: "pattern",
      id: id2,
    });
    const m = await db.getVectorsByFactIds([id1, id2.toUpperCase(), "not-a-valid-uuid", missing]);
    expect(m.size).toBe(2);
    const v1 = m.get(id1.toLowerCase())!;
    expect(v1).toHaveLength(4);
    expect(v1[0]).toBeCloseTo(0.1);
    expect(v1[1]).toBeCloseTo(0.2);
    expect(v1[2]).toBeCloseTo(0.3);
    expect(v1[3]).toBeCloseTo(0.4);
    expect(m.get(id2.toLowerCase())?.[0]).toBeCloseTo(0.5);
    expect(m.has(missing.toLowerCase())).toBe(false);
    db.close();
  });

  it("returns empty map when LanceDB is unavailable", async () => {
    vi.clearAllMocks();
    const connectSpy = vi.spyOn(lancedb, "connect").mockRejectedValue(new Error("simulated connect failure"));
    const db = new VectorDB(join(tmpDir, "no-lance"), 3);
    const m = await db.getVectorsByFactIds([randomUUID()]);
    expect(m.size).toBe(0);
    db.close();
    connectSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// VectorDB graceful degradation — FTS5-only fallback when lancedb.connect() fails
// Issue: "If LanceDB fails to open, the plugin becomes unusable."
// ---------------------------------------------------------------------------

describe("VectorDB graceful degradation — FTS5-only fallback when lancedb.connect() fails", () => {
  const DIM = 3;
  const CONNECT_ERROR = new Error("LanceDB connection refused: simulated failure");
  let connectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    connectSpy = vi.spyOn(lancedb, "connect").mockRejectedValue(CONNECT_ERROR);
  });

  afterEach(() => {
    connectSpy.mockRestore();
  });

  it("isLanceDbAvailable() returns false after a connect failure", async () => {
    const db = new VectorDB("/tmp/test-lance", DIM);
    await db.count();
    expect(db.isLanceDbAvailable()).toBe(false);
  });

  it("logs a warning on connect failure", async () => {
    const db = new VectorDB("/tmp/test-lance", DIM);
    const warns: string[] = [];
    db.setLogger({ warn: (msg) => warns.push(msg) });
    await db.count();
    expect(warns.some((w) => w.includes("FTS5-only") || w.includes("unavailable"))).toBe(true);
  });

  it("search() returns [] without calling capturePluginError when LanceDB unavailable", async () => {
    const db = new VectorDB("/tmp/test-lance", DIM);
    const results = await db.search(new Array(DIM).fill(0.1), 5, 0);
    expect(results).toHaveLength(0);
    expect(mockCapturePluginError).not.toHaveBeenCalled();
  });

  it("hasDuplicate() returns false without calling capturePluginError when LanceDB unavailable", async () => {
    const db = new VectorDB("/tmp/test-lance", DIM);
    const result = await db.hasDuplicate(new Array(DIM).fill(0.1));
    expect(result).toBe(false);
    expect(mockCapturePluginError).not.toHaveBeenCalled();
  });

  it("store() returns an id without throwing when LanceDB unavailable", async () => {
    const db = new VectorDB("/tmp/test-lance", DIM);
    const id = await db.store({
      text: "test fact",
      vector: new Array(DIM).fill(0.1),
      importance: 0.8,
      category: "fact",
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("store() with an explicit id returns that id when LanceDB unavailable", async () => {
    const db = new VectorDB("/tmp/test-lance", DIM);
    const explicitId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const id = await db.store({
      text: "test fact",
      vector: new Array(DIM).fill(0.1),
      importance: 0.8,
      category: "fact",
      id: explicitId,
    });
    expect(id).toBe(explicitId);
  });

  it("count() returns 0 when LanceDB unavailable", async () => {
    const db = new VectorDB("/tmp/test-lance", DIM);
    const result = await db.count();
    expect(result).toBe(0);
  });

  it("delete() returns false when LanceDB unavailable", async () => {
    const db = new VectorDB("/tmp/test-lance", DIM);
    const result = await db.delete("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(result).toBe(false);
  });

  it("deleteMany() returns 0 when LanceDB unavailable", async () => {
    const db = new VectorDB("/tmp/test-lance", DIM);
    const result = await db.deleteMany(["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
    expect(result).toBe(0);
  });

  it("optimize() returns zero stats when LanceDB unavailable", async () => {
    const db = new VectorDB("/tmp/test-lance", DIM);
    const stats = await db.optimize();
    expect(stats).toEqual({ compacted: 0, removedFragments: 0, freedBytes: 0 });
  });

  it("does not retry lancedb.connect() on every call (only once per session)", async () => {
    const db = new VectorDB("/tmp/test-lance", DIM);
    const warns: string[] = [];
    db.setLogger({ warn: (msg) => warns.push(msg) });
    // Three separate calls — connect should only be attempted once
    await db.search(new Array(DIM).fill(0.1), 5, 0);
    await db.search(new Array(DIM).fill(0.2), 5, 0);
    await db.count();
    const unavailableWarns = warns.filter((w) => w.includes("FTS5-only") || w.includes("unavailable"));
    expect(unavailableWarns).toHaveLength(1);
    // connect() is also only called once despite three operation calls
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});

describe("VectorDB.deleteMany", () => {
  const DIM = 3;

  it("filters invalid UUIDs and de-duplicates IDs before issuing deletes", async () => {
    const db = new VectorDB("/tmp/test-lance-delete-many-filter", DIM);
    const id = randomUUID();
    const tableDelete = vi.fn().mockResolvedValue(undefined);
    const ensureInitializedSpy = vi.spyOn(
      db as unknown as { ensureInitialized: () => Promise<void> },
      "ensureInitialized",
    );
    const retrySpy = vi.spyOn(
      db as unknown as {
        withRetryableWriteConflictRetry: (label: string, fn: () => Promise<void>) => Promise<void>;
      },
      "withRetryableWriteConflictRetry",
    );
    const getTableSpy = vi.spyOn(
      db as unknown as { getTable: () => { delete: (predicate: string) => Promise<void> } },
      "getTable",
    );
    ensureInitializedSpy.mockResolvedValue(undefined);
    retrySpy.mockImplementation(async (_label, fn) => {
      await fn();
    });
    getTableSpy.mockReturnValue({ delete: tableDelete });
    const internals = db as unknown as { lanceDbAvailable: boolean; lanceInitFailed: boolean; table: object | null };
    internals.lanceDbAvailable = true;
    internals.lanceInitFailed = false;
    internals.table = {};

    const deleted = await db.deleteMany([id, id.toUpperCase(), "invalid"]);

    expect(deleted).toBe(1);
    expect(tableDelete).toHaveBeenCalledTimes(1);
  });

  it("falls back to per-id delete when bulk delete throws", async () => {
    const db = new VectorDB("/tmp/test-lance-delete-many-fallback", DIM);
    const id1 = randomUUID();
    const id2 = randomUUID();
    const ensureInitializedSpy = vi.spyOn(
      db as unknown as { ensureInitialized: () => Promise<void> },
      "ensureInitialized",
    );
    const retrySpy = vi.spyOn(
      db as unknown as {
        withRetryableWriteConflictRetry: (label: string, fn: () => Promise<void>) => Promise<void>;
      },
      "withRetryableWriteConflictRetry",
    );
    const getTableSpy = vi.spyOn(
      db as unknown as { getTable: () => { delete: (predicate: string) => Promise<void> } },
      "getTable",
    );
    const fallbackDeleteSpy = vi.spyOn(db, "delete");
    ensureInitializedSpy.mockResolvedValue(undefined);
    retrySpy.mockImplementation(async (_label, fn) => {
      await fn();
    });
    getTableSpy.mockReturnValue({
      delete: vi.fn().mockRejectedValue(new Error("boom")),
    });
    fallbackDeleteSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const internals = db as unknown as { lanceDbAvailable: boolean; lanceInitFailed: boolean; table: object | null };
    internals.lanceDbAvailable = true;
    internals.lanceInitFailed = false;
    internals.table = {};

    const deleted = await db.deleteMany([id1, id2]);

    expect(deleted).toBe(1);
    expect(fallbackDeleteSpy).toHaveBeenCalledTimes(2);
    expect(fallbackDeleteSpy).toHaveBeenNthCalledWith(1, id1.toLowerCase());
    expect(fallbackDeleteSpy).toHaveBeenNthCalledWith(2, id2.toLowerCase());
  });
});

describe("VectorDB runtime bounds/telemetry observability", () => {
  const DIM = 3;

  it("caps vector search result materialization by runtime bound and records telemetry", async () => {
    const db = new VectorDB("/tmp/test-lance-search-bound", DIM);
    const ensureInitializedSpy = vi.spyOn(
      db as unknown as { ensureInitialized: () => Promise<void> },
      "ensureInitialized",
    );
    const getTableSpy = vi.spyOn(
      db as unknown as {
        getTable: () => {
          vectorSearch: (vector: number[]) => { limit: (n: number) => { toArray: () => Promise<unknown[]> } };
        };
      },
      "getTable",
    );
    let capturedLimit = 0;
    ensureInitializedSpy.mockResolvedValue(undefined);
    getTableSpy.mockReturnValue({
      vectorSearch: () => ({
        limit: (n: number) => {
          capturedLimit = n;
          return { toArray: async () => [] };
        },
      }),
    });
    const internals = db as unknown as { lanceDbAvailable: boolean; lanceInitFailed: boolean; table: object | null };
    internals.lanceDbAvailable = true;
    internals.lanceInitFailed = false;
    internals.table = {};

    await db.search([0.1, 0.2, 0.3], 10_000, 0);

    const bounds = db.getRuntimeBounds();
    const telemetry = db.getSearchTelemetry();
    expect(capturedLimit).toBeLessThanOrEqual(bounds.vectorSearchMaxResults);
    expect(telemetry.lastEffectiveLimit).toBe(capturedLimit);
    expect(telemetry.lastRequestedLimit).toBe(10_000);
    expect(telemetry.total).toBe(1);
    expect(telemetry.active).toBe(0);
  });

  it("caps semantic-cache candidate lookup size by runtime bound", async () => {
    const db = new VectorDB("/tmp/test-lance-cache-bound", DIM);
    const ensureInitializedSpy = vi.spyOn(
      db as unknown as { ensureInitialized: () => Promise<void> },
      "ensureInitialized",
    );
    ensureInitializedSpy.mockResolvedValue(undefined);
    let capturedLimit = 0;
    const cacheTable = {
      vectorSearch: () => ({
        limit: (n: number) => {
          capturedLimit = n;
          return { toArray: async () => [] };
        },
      }),
    };
    const internals = db as unknown as {
      lanceDbAvailable: boolean;
      lanceInitFailed: boolean;
      semanticQueryCacheTable: object | null;
      semanticQueryCacheSchemaValid: boolean;
    };
    internals.lanceDbAvailable = true;
    internals.lanceInitFailed = false;
    internals.semanticQueryCacheTable = cacheTable as unknown as object;
    internals.semanticQueryCacheSchemaValid = true;

    await db.getSemanticQueryCacheMatch([0.1, 0.2, 0.3], { candidateLimit: 10_000 });

    const bounds = db.getRuntimeBounds();
    expect(capturedLimit).toBeLessThanOrEqual(bounds.semanticCacheCandidateLimitMax);
  });
});

describe("VectorDB hasDuplicate() excludeId (#51)", () => {
  let tmpDir: string;
  let db: InstanceType<typeof VectorDB>;
  const DIM = 3;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-hasdup-excludeid-test-"));
    db = new VectorDB(join(tmpDir, "lance"), DIM);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not treat a fact's own not-yet-deleted vector as a duplicate when excludeId matches it", async () => {
    await db.store({
      text: "user prefers TypeScript",
      vector: [0.1, 0.2, 0.3],
      importance: 0.8,
      category: "preference",
      id: "self-id",
    });

    // Re-embedding the same fact produces (near-)identical vector; without excludeId this
    // would self-match and be (wrongly) reported as a duplicate before the stale entry is
    // deleted and the new vector stored.
    const stillDuplicate = await db.hasDuplicate([0.1, 0.2, 0.3], 0.95);
    expect(stillDuplicate).toBe(true);

    const excluded = await db.hasDuplicate([0.1, 0.2, 0.3], 0.95, "self-id");
    expect(excluded).toBe(false);
  });

  it("still detects a genuine duplicate from a different fact when excludeId is set", async () => {
    await db.store({
      text: "user prefers TypeScript",
      vector: [0.1, 0.2, 0.3],
      importance: 0.8,
      category: "preference",
      id: "other-id",
    });

    const result = await db.hasDuplicate([0.1, 0.2, 0.3], 0.95, "self-id");
    expect(result).toBe(true);
  });
});
