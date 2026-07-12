import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { analyzeStorageSyncFromIds, collectStorageSyncSnapshot } from "../services/storage-sync-diagnostics.js";

const { VectorDB, FactsDB } = _testing;

describe("storage-sync-diagnostics", () => {
  it("detects structural drift when row counts differ but ID sets align", () => {
    const baseIds = Array.from({ length: 100 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const lanceIdList = [...baseIds, ...baseIds.slice(0, 30)];
    const snapshot = analyzeStorageSyncFromIds({
      sqliteActiveFacts: 100,
      expectedVectorFacts: 100,
      lanceRowCount: 130,
      lanceIdList,
      canonicalEmbeddings: 100,
      vectorOrphans: [],
      sqliteOrphans: [],
    });
    expect(snapshot.hasIdSetDrift).toBe(false);
    expect(snapshot.hasStructuralDrift).toBe(true);
    expect(snapshot.duplicateIdExtraRows).toBeGreaterThan(0);
  });

  it("detects ID-set drift from orphan vectors", () => {
    const snapshot = analyzeStorageSyncFromIds({
      sqliteActiveFacts: 2,
      expectedVectorFacts: 2,
      lanceRowCount: 3,
      lanceIdList: ["a", "b", "orphan"],
      canonicalEmbeddings: 2,
      vectorOrphans: ["orphan"],
      sqliteOrphans: [],
    });
    expect(snapshot.hasIdSetDrift).toBe(true);
    expect(snapshot.hasStructuralDrift).toBe(false);
  });

  it("detects ID-set drift from a genuinely missing vector (expected-vector fact absent from Lance)", () => {
    const snapshot = analyzeStorageSyncFromIds({
      sqliteActiveFacts: 3,
      expectedVectorFacts: 3,
      lanceRowCount: 2,
      lanceIdList: ["a", "b"],
      canonicalEmbeddings: 2,
      vectorOrphans: [],
      sqliteOrphans: ["missing-vector-fact"],
    });
    expect(snapshot.hasIdSetDrift).toBe(true);
    expect(snapshot.hasRowCountDrift).toBe(true);
    expect(snapshot.sqliteOrphans).toEqual(["missing-vector-fact"]);
  });

  it("reports aligned storage when all metrics match", () => {
    const snapshot = analyzeStorageSyncFromIds({
      sqliteActiveFacts: 5,
      expectedVectorFacts: 5,
      lanceRowCount: 5,
      lanceIdList: ["a", "b", "c", "d", "e"],
      canonicalEmbeddings: 5,
      vectorOrphans: [],
      sqliteOrphans: [],
    });
    expect(snapshot.hasRowCountDrift).toBe(false);
    expect(snapshot.hasStructuralDrift).toBe(false);
    expect(snapshot.hasIdSetDrift).toBe(false);
  });

  it("does not flag a canonicalEmbeddings/lanceUniqueIds gap as ID-set or structural drift (#2084 cache contract)", () => {
    const snapshot = analyzeStorageSyncFromIds({
      sqliteActiveFacts: 5,
      expectedVectorFacts: 5,
      lanceRowCount: 5,
      lanceIdList: ["a", "b", "c", "d", "e"],
      canonicalEmbeddings: 1, // shadow re-index never backfilled the cache for most facts
      vectorOrphans: [],
      sqliteOrphans: [],
    });
    expect(snapshot.hasEmbeddingDrift).toBe(true);
    // The cache gap is real but must not surface as an actionable drift signal.
    expect(snapshot.hasIdSetDrift).toBe(false);
    expect(snapshot.hasStructuralDrift).toBe(false);
    expect(snapshot.hasRowCountDrift).toBe(false);
  });
});

describe("collectStorageSyncSnapshot (#2080/#2092 — structured facts excluded from expected-vector population)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;
  const DIM = 3;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "storage-sync-diagnostics-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vectorDb = new VectorDB(join(tmpDir, "lance"), DIM);
  });

  afterEach(() => {
    factsDb.close();
    vectorDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a structured (keyed) fact without a vector is not reported as an sqlite orphan", async () => {
    factsDb.store({
      text: "Task [example] status: in_progress",
      category: "project",
      importance: 0.5,
      entity: "example",
      key: "status",
      value: "in_progress",
      source: "test",
    });

    const snapshot = await collectStorageSyncSnapshot(factsDb, vectorDb);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.sqliteActiveFacts).toBe(1);
    expect(snapshot?.expectedVectorFacts).toBe(0);
    expect(snapshot?.sqliteOrphans).toEqual([]);
    expect(snapshot?.hasIdSetDrift).toBe(false);
  });

  it("an unstructured fact without a vector is reported as an sqlite orphan (genuine gap)", async () => {
    const stored = factsDb.store({
      text: "Unstructured fact needing a vector",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const snapshot = await collectStorageSyncSnapshot(factsDb, vectorDb);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.expectedVectorFacts).toBe(1);
    expect(snapshot?.sqliteOrphans).toEqual([stored.id]);
    expect(snapshot?.hasIdSetDrift).toBe(true);
  });

  it("reports aligned when the unstructured fact's vector is stored", async () => {
    const stored = factsDb.store({
      text: "Unstructured fact with a vector",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    await vectorDb.store({
      id: stored.id,
      text: "Unstructured fact with a vector",
      vector: [0.1, 0.2, 0.3],
      importance: 0.5,
      category: "fact",
    });

    const snapshot = await collectStorageSyncSnapshot(factsDb, vectorDb);
    expect(snapshot?.sqliteOrphans).toEqual([]);
    expect(snapshot?.vectorOrphans).toEqual([]);
    expect(snapshot?.hasIdSetDrift).toBe(false);
  });
});
