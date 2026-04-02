/**
 * Tests for fact_embeddings table in FactsDB (Issue #158).
 *
 * Tests store/retrieve/delete operations for multi-model embeddings.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: FactsDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fact-embeddings-test-"));
  db = new FactsDB(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeEmbedding(dims: number, fillValue = 0.1): Float32Array {
  return new Float32Array(dims).fill(fillValue);
}

function storeTestFact(db: FactsDB, text = "test fact"): string {
  const result = db.store({
    text,
    category: "fact",
    importance: 0.7,
    source: "test",
    entity: null,
    key: null,
    value: null,
  });
  return result.id;
}

// ---------------------------------------------------------------------------
// Table creation (schema migration)
// ---------------------------------------------------------------------------

describe("fact_embeddings table — schema", () => {
  it("table is created automatically on FactsDB construction", () => {
    // If the table didn't exist, storeEmbedding would throw
    const factId = storeTestFact(db);
    expect(() => db.storeEmbedding(factId, "test-model", "canonical", makeEmbedding(4), 4)).not.toThrow();
  });

  it("is idempotent — multiple FactsDB openings do not fail", () => {
    db.close();
    const db2 = new FactsDB(join(tmpDir, "test.db"));
    expect(() => {
      const factId = storeTestFact(db2);
      db2.storeEmbedding(factId, "test-model", "canonical", makeEmbedding(4), 4);
    }).not.toThrow();
    db2.close();
    // Reopen so afterEach doesn't fail
    db = new FactsDB(join(tmpDir, "test2.db"));
  });
});

// ---------------------------------------------------------------------------
// storeEmbedding / getEmbeddings
// ---------------------------------------------------------------------------

describe("storeEmbedding() + getEmbeddings()", () => {
  it("stores and retrieves a single embedding", () => {
    const factId = storeTestFact(db);
    const vec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    db.storeEmbedding(factId, "model-a", "canonical", vec, 4);

    const result = db.getEmbeddings(factId);
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("model-a");
    expect(result[0].variant).toBe("canonical");
    const vals = Array.from(result[0].embedding);
    expect(vals[0]).toBeCloseTo(0.1, 5);
    expect(vals[1]).toBeCloseTo(0.2, 5);
    expect(vals[2]).toBeCloseTo(0.3, 5);
    expect(vals[3]).toBeCloseTo(0.4, 5);
  });

  it("stores multiple models for same fact", () => {
    const factId = storeTestFact(db);
    db.storeEmbedding(factId, "model-a", "canonical", makeEmbedding(4, 0.1), 4);
    db.storeEmbedding(factId, "model-b", "canonical", makeEmbedding(8, 0.2), 8);

    const result = db.getEmbeddings(factId);
    expect(result).toHaveLength(2);
    const models = result.map((r) => r.model).sort();
    expect(models).toEqual(["model-a", "model-b"]);
  });

  it("stores multiple variants for same fact+model", () => {
    const factId = storeTestFact(db);
    db.storeEmbedding(factId, "model-a", "canonical", makeEmbedding(4, 0.1), 4);
    db.storeEmbedding(factId, "model-a", "hyde", makeEmbedding(4, 0.2), 4);

    const result = db.getEmbeddings(factId);
    expect(result).toHaveLength(2);
    const variants = result.map((r) => r.variant).sort();
    expect(variants).toEqual(["canonical", "hyde"]);
  });

  it("updates embedding on conflict (same fact+model+variant)", () => {
    const factId = storeTestFact(db);
    const vec1 = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const vec2 = new Float32Array([0.9, 0.8, 0.7, 0.6]);

    db.storeEmbedding(factId, "model-a", "canonical", vec1, 4);
    db.storeEmbedding(factId, "model-a", "canonical", vec2, 4);

    const result = db.getEmbeddings(factId);
    expect(result).toHaveLength(1);
    const vals = Array.from(result[0].embedding);
    expect(vals[0]).toBeCloseTo(0.9, 5);
    expect(vals[1]).toBeCloseTo(0.8, 5);
    expect(vals[2]).toBeCloseTo(0.7, 5);
    expect(vals[3]).toBeCloseTo(0.6, 5);
  });

  it("returns empty array for unknown factId", () => {
    const result = db.getEmbeddings("nonexistent-fact-id");
    expect(result).toHaveLength(0);
  });

  it("returns Float32Array instances", () => {
    const factId = storeTestFact(db);
    db.storeEmbedding(factId, "model-a", "canonical", makeEmbedding(4), 4);
    const result = db.getEmbeddings(factId);
    expect(result[0].embedding).toBeInstanceOf(Float32Array);
  });

  it("isolates embeddings per fact", () => {
    const factId1 = storeTestFact(db, "fact one");
    const factId2 = storeTestFact(db, "fact two");
    db.storeEmbedding(factId1, "model-a", "canonical", makeEmbedding(4, 0.1), 4);
    db.storeEmbedding(factId2, "model-a", "canonical", makeEmbedding(4, 0.9), 4);

    expect(db.getEmbeddings(factId1)).toHaveLength(1);
    expect(db.getEmbeddings(factId2)).toHaveLength(1);
    expect(Array.from(db.getEmbeddings(factId1)[0].embedding)[0]).toBeCloseTo(0.1);
    expect(Array.from(db.getEmbeddings(factId2)[0].embedding)[0]).toBeCloseTo(0.9);
  });
});

// ---------------------------------------------------------------------------
// getEmbeddingsByModel
// ---------------------------------------------------------------------------

describe("getEmbeddingsByModel()", () => {
  it("returns all embeddings for a model across facts", () => {
    const id1 = storeTestFact(db, "fact one");
    const id2 = storeTestFact(db, "fact two");
    db.storeEmbedding(id1, "model-a", "canonical", makeEmbedding(4, 0.1), 4);
    db.storeEmbedding(id2, "model-a", "canonical", makeEmbedding(4, 0.2), 4);
    db.storeEmbedding(id1, "model-b", "canonical", makeEmbedding(8, 0.5), 8);

    const result = db.getEmbeddingsByModel("model-a");
    expect(result).toHaveLength(2);
    const factIds = result.map((r) => r.factId).sort();
    expect(factIds).toEqual([id1, id2].sort());
  });

  it("returns empty array for unknown model", () => {
    const result = db.getEmbeddingsByModel("nonexistent-model");
    expect(result).toHaveLength(0);
  });

  it("only returns canonical variant embeddings", () => {
    const id1 = storeTestFact(db, "fact one");
    db.storeEmbedding(id1, "model-a", "canonical", makeEmbedding(4, 0.1), 4);
    db.storeEmbedding(id1, "model-a", "hyde", makeEmbedding(4, 0.9), 4);

    const result = db.getEmbeddingsByModel("model-a");
    // Only canonical variant
    expect(result).toHaveLength(1);
    expect(Array.from(result[0].embedding)[0]).toBeCloseTo(0.1);
  });

  it("returns Float32Array embeddings", () => {
    const id1 = storeTestFact(db, "fact one");
    db.storeEmbedding(id1, "model-a", "canonical", makeEmbedding(4), 4);
    const result = db.getEmbeddingsByModel("model-a");
    expect(result[0].embedding).toBeInstanceOf(Float32Array);
  });
});

// ---------------------------------------------------------------------------
// deleteEmbeddings
// ---------------------------------------------------------------------------

describe("deleteEmbeddings()", () => {
  it("deletes all embeddings for a fact", () => {
    const factId = storeTestFact(db);
    db.storeEmbedding(factId, "model-a", "canonical", makeEmbedding(4), 4);
    db.storeEmbedding(factId, "model-b", "canonical", makeEmbedding(8), 8);

    db.deleteEmbeddings(factId);

    expect(db.getEmbeddings(factId)).toHaveLength(0);
  });

  it("does not affect other facts embeddings", () => {
    const id1 = storeTestFact(db, "fact one");
    const id2 = storeTestFact(db, "fact two");
    db.storeEmbedding(id1, "model-a", "canonical", makeEmbedding(4), 4);
    db.storeEmbedding(id2, "model-a", "canonical", makeEmbedding(4), 4);

    db.deleteEmbeddings(id1);

    expect(db.getEmbeddings(id1)).toHaveLength(0);
    expect(db.getEmbeddings(id2)).toHaveLength(1);
  });

  it("is safe to call for nonexistent factId", () => {
    expect(() => db.deleteEmbeddings("nonexistent")).not.toThrow();
  });
});
