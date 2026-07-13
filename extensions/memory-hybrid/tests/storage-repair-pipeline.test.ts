/**
 * Regression: runStorageRepairPipeline must actually reduce the vectorless backlog and keep
 * fact_embeddings (the canonical embedding cache) in sync when it rebuilds a vector, not just
 * call vectorDb.store() directly (#2083). It previously bypassed storeCanonicalVectorForFact,
 * so fact_embeddings stayed stale and countVectorlessActiveFacts() (keyed off fact_embeddings)
 * never dropped even though the repair reported reembedded/rebuilt facts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { runStorageRepairPipeline } from "../services/storage-repair-pipeline.js";

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return { ...actual, capturePluginError: vi.fn() };
});

const { VectorDB, FactsDB } = _testing;
const DIM = 3;

function makeEmbeddings() {
  return {
    modelName: "test-embedding-model",
    dimensions: DIM,
    embed: vi.fn(async (_text: string) => [0.1, 0.2, 0.3]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  };
}

describe("runStorageRepairPipeline vectorless reembed (#2083)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "storage-repair-pipeline-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vectorDb = new VectorDB(join(tmpDir, "lance"), DIM);
  });

  afterEach(() => {
    factsDb.close();
    vectorDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rebuilds a vectorless fact's vector via storeCanonicalVectorForFact, writing fact_embeddings", async () => {
    const stored = factsDb.store({
      text: "a vectorless fact needing repair",
      category: "fact",
      importance: 0.73,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    expect(factsDb.countVectorlessActiveFacts()).toBe(1);
    expect(factsDb.countCanonicalEmbeddings()).toBe(0);

    const embeddings = makeEmbeddings();
    const report = await runStorageRepairPipeline({ factsDb, vectorDb, embeddings });

    expect(report.vectorlessBefore).toBe(1);
    expect(report.reembedded).toBe(1);
    expect(report.errors).toEqual([]);

    // The core #2083 regression: vectorlessAfter must actually drop, not stay pinned at
    // vectorlessBefore because fact_embeddings was never written.
    expect(report.vectorlessAfter).toBe(0);
    expect(factsDb.countVectorlessActiveFacts()).toBe(0);
    expect(factsDb.countCanonicalEmbeddings()).toBe(1);

    // LanceDB itself also has the vector, stored under the fact's real id and importance.
    const vectors = await vectorDb.getVectorsByFactIds([stored.id]);
    expect(vectors.has(stored.id)).toBe(true);
    const results = await vectorDb.search([0.1, 0.2, 0.3], 5, 0);
    const match = results.find((r) => r.entry.id === stored.id);
    expect(match?.entry.importance).toBeCloseTo(0.73, 5);
  });

  it("rebuilds a SQLite-orphan fact's vector via storeCanonicalVectorForFact, writing fact_embeddings", async () => {
    // A fact whose canonical vector already exists in fact_embeddings but is missing from Lance
    // (e.g. a Lance table wipe) — same rebuild path, different report.reconcile counters.
    const stored = factsDb.store({
      text: "an orphaned fact needing rebuild",
      category: "fact",
      importance: 0.42,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    factsDb.setEmbeddingModel(stored.id, "test-embedding-model");
    factsDb.storeEmbedding(stored.id, "test-embedding-model", "canonical", new Float32Array([0.4, 0.5, 0.6]), DIM);
    // Not stored in Lance at all — this fact is now a SQLite orphan for reconcile to find.
    expect(factsDb.countVectorlessActiveFacts()).toBe(0);

    const embeddings = makeEmbeddings();
    const report = await runStorageRepairPipeline({ factsDb, vectorDb, embeddings, skipReembed: true });

    expect(report.reconcile.sqliteOrphans).toBe(1);
    expect(report.reconcile.sqliteOrphansRebuilt).toBe(1);
    expect(report.errors).toEqual([]);

    const vectors = await vectorDb.getVectorsByFactIds([stored.id]);
    expect(vectors.has(stored.id)).toBe(true);
    const results = await vectorDb.search([0.1, 0.2, 0.3], 5, 0);
    const match = results.find((r) => r.entry.id === stored.id);
    expect(match?.entry.importance).toBeCloseTo(0.42, 5);
  });

  it("deduplicates a duplicate live Lance row for a still-active fact id (structural drift repair)", async () => {
    // VectorDB.store()'s EEXIST-recovery path only fires on an actual LanceDB write error, but
    // LanceDB never rejects a second add() for a pre-existing id — a plain add() silently appends
    // a second live row instead. Reproduce that directly (bypassing the FactsDB store path) so the
    // repair pipeline sees a genuine duplicate-id structural drift, not an ID-set orphan.
    const stored = factsDb.store({
      text: "a fact whose vector got duplicated",
      category: "fact",
      importance: 0.6,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    await vectorDb.store({
      id: stored.id,
      text: stored.text,
      vector: [0.1, 0.2, 0.3],
      importance: 0.6,
      category: "fact",
    });
    await vectorDb.store({
      id: stored.id,
      text: stored.text,
      vector: [0.4, 0.5, 0.6],
      importance: 0.6,
      category: "fact",
    });

    const idsBefore = await vectorDb.getAllIds();
    expect(idsBefore.filter((id) => id === stored.id)).toHaveLength(2);

    const embeddings = makeEmbeddings();
    const report = await runStorageRepairPipeline({ factsDb, vectorDb, embeddings, skipReembed: true });

    expect(report.dedupe.duplicateIds).toBe(1);
    expect(report.dedupe.deduplicated).toBe(1);
    expect(report.errors).toEqual([]);

    const idsAfter = await vectorDb.getAllIds();
    expect(idsAfter.filter((id) => id === stored.id)).toHaveLength(1);
  });

  it("leaves a duplicate untouched (does not delete) when embedding fails, instead of losing the vector (QA follow-up)", async () => {
    const stored = factsDb.store({
      text: "a fact whose dedupe embed will fail",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    await vectorDb.store({
      id: stored.id,
      text: stored.text,
      vector: [0.1, 0.2, 0.3],
      importance: 0.5,
      category: "fact",
    });
    await vectorDb.store({
      id: stored.id,
      text: stored.text,
      vector: [0.4, 0.5, 0.6],
      importance: 0.5,
      category: "fact",
    });
    expect((await vectorDb.getAllIds()).filter((id) => id === stored.id)).toHaveLength(2);

    const embeddings = {
      modelName: "test-embedding-model",
      dimensions: DIM,
      embed: vi.fn(async () => {
        throw new Error("embedding provider timed out");
      }),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    };
    const report = await runStorageRepairPipeline({ factsDb, vectorDb, embeddings, skipReembed: true });

    expect(report.dedupe.duplicateIds).toBe(1);
    expect(report.dedupe.deduplicated).toBe(0);
    expect(report.errors.some((e) => e.includes(stored.id))).toBe(true);

    // The core regression: a failed re-embed must not have deleted the (harmless) duplicate rows
    // first — the fact must still have at least one vector, not zero.
    const idsAfter = await vectorDb.getAllIds();
    expect(idsAfter.filter((id) => id === stored.id).length).toBeGreaterThan(0);
  });

  it("shares one repair budget between sqliteOrphans rebuild and dedupe instead of doubling it (QA follow-up)", async () => {
    // Two facts: one is a genuine sqliteOrphan (missing from Lance), one has a duplicate Lance row.
    // maxFixes=1 should cap the combined embed-consuming work at 1 total, not 1 per phase.
    const orphanFact = factsDb.store({
      text: "orphan fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    factsDb.setEmbeddingModel(orphanFact.id, "test-embedding-model");
    factsDb.storeEmbedding(orphanFact.id, "test-embedding-model", "canonical", new Float32Array([0.1, 0.2, 0.3]), DIM);

    const dupFact = factsDb.store({
      text: "duplicated fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    await vectorDb.store({
      id: dupFact.id,
      text: dupFact.text,
      vector: [0.1, 0.2, 0.3],
      importance: 0.5,
      category: "fact",
    });
    await vectorDb.store({
      id: dupFact.id,
      text: dupFact.text,
      vector: [0.4, 0.5, 0.6],
      importance: 0.5,
      category: "fact",
    });

    const embeddings = makeEmbeddings();
    const report = await runStorageRepairPipeline({
      factsDb,
      vectorDb,
      embeddings,
      skipReembed: true,
      maxFixes: 1,
      policy: "balanced",
    });

    // Exactly one of the two repair-worthy items gets fixed — combined work is capped at maxFixes,
    // not maxFixes per phase (which would let both through).
    const totalFixed = report.reconcile.sqliteOrphansRebuilt + report.dedupe.deduplicated;
    expect(totalFixed).toBe(1);
  });

  it("does not treat a vectorless structured (keyed) fact as a sqliteOrphan (#2080 QA follow-up)", async () => {
    // Structured key/value facts are intentionally excluded from the expected-vector population
    // (#2080) — a structured fact without a Lance row is not drift and must not be reconciled.
    factsDb.store({
      text: "structured-key-value-fact",
      category: "fact",
      importance: 0.5,
      entity: "widget",
      key: "status",
      value: "active",
      source: "test",
    });
    const unstructured = factsDb.store({
      text: "a genuinely vectorless unstructured fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const embeddings = makeEmbeddings();
    const report = await runStorageRepairPipeline({ factsDb, vectorDb, embeddings, skipReembed: true });

    // Only the unstructured fact should be counted/rebuilt — the structured fact must be invisible
    // to this reconcile pass, matching storage-sync-diagnostics.ts's contract for the same query.
    expect(report.reconcile.sqliteOrphans).toBe(1);
    expect(report.reconcile.sqliteOrphansRebuilt).toBe(1);
    expect(embeddings.embed).toHaveBeenCalledTimes(1);
    expect(embeddings.embed).toHaveBeenCalledWith(unstructured.text);
  });
});
