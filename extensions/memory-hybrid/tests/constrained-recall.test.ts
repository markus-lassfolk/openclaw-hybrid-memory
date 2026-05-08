/**
 * Constrained-recall mode tests (Issue #1026).
 * Verifies the "filter → rank → hydrate" retrieval pattern.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { DEFAULT_RETRIEVAL_CONFIG, runRetrievalPipeline } from "../services/retrieval-orchestrator.js";

const { FactsDB } = _testing;

describe("constrained-recall mode (filter → rank → hydrate)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "constrained-recall-test-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeVec = (n = 4): Float32Array => new Float32Array(new Array(n).fill(0).map((_, i) => (i === 0 ? 1 : 0)));

  it("returns only facts matching the entity filter", async () => {
    const apple = factsDb.store({
      text: "Apple is tasty",
      category: "fact",
      importance: 0.6,
      entity: "fruit",
      key: null,
      value: null,
      source: "conversation",
    });
    const banana = factsDb.store({
      text: "Banana is yellow",
      category: "fact",
      importance: 0.6,
      entity: "fruit",
      key: null,
      value: null,
      source: "conversation",
    });
    const carrot = factsDb.store({
      text: "Carrot is orange",
      category: "fact",
      importance: 0.6,
      entity: "vegetable",
      key: null,
      value: null,
      source: "conversation",
    });

    factsDb.storeEmbedding(apple.id, "test-model", "canonical", makeVec(), 4);
    factsDb.storeEmbedding(banana.id, "test-model", "canonical", makeVec(), 4);
    factsDb.storeEmbedding(carrot.id, "test-model", "canonical", makeVec(), 4);

    const vectorDb = {
      search: async () => [
        { entry: factsDb.getById(apple.id)!, score: 0.95 },
        { entry: factsDb.getById(banana.id)!, score: 0.9 },
        { entry: factsDb.getById(carrot.id)!, score: 0.85 },
      ],
    } as unknown as import("../backends/vector-db.js").VectorDB;

    const result = await runRetrievalPipeline("apple", [1, 0, 0, 0], factsDb.getRawDb(), vectorDb, factsDb, {
      mode: "constrained-recall",
      constrainedFilters: { entity: "fruit" },
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["semantic"] },
      budgetTokens: 5000,
    });

    const ids = result.fused.map((r) => r.factId);
    expect(ids).toContain(apple.id);
    expect(ids).toContain(banana.id);
    expect(ids).not.toContain(carrot.id);
  });

  it("excludes facts outside the temporal window when validFromSec is set", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const recent = factsDb.store({
      text: "Recent fact",
      category: "fact",
      importance: 0.6,
      entity: "test",
      key: null,
      value: null,
      source: "conversation",
      validFrom: nowSec - 10 * 86400,
    });
    const old = factsDb.store({
      text: "Old fact",
      category: "fact",
      importance: 0.6,
      entity: "test",
      key: null,
      value: null,
      source: "conversation",
      validFrom: nowSec - 60 * 86400,
    });

    factsDb.storeEmbedding(recent.id, "test-model", "canonical", makeVec(), 4);
    factsDb.storeEmbedding(old.id, "test-model", "canonical", makeVec(), 4);

    const vectorDb = {
      search: async () => [
        { entry: factsDb.getById(recent.id)!, score: 0.9 },
        { entry: factsDb.getById(old.id)!, score: 0.85 },
      ],
    } as unknown as import("../backends/vector-db.js").VectorDB;

    const result = await runRetrievalPipeline("test", [1, 0, 0, 0], factsDb.getRawDb(), vectorDb, factsDb, {
      mode: "constrained-recall",
      constrainedFilters: { entity: "test", validFromSec: nowSec - 30 * 86400 },
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["semantic"] },
      budgetTokens: 5000,
    });

    const ids = result.fused.map((r) => r.factId);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
  });

  it("returns empty result when no facts match the structured filter", async () => {
    const apple = factsDb.store({
      text: "Apple is tasty",
      category: "fact",
      importance: 0.6,
      entity: "fruit",
      key: null,
      value: null,
      source: "conversation",
    });
    factsDb.storeEmbedding(apple.id, "test-model", "canonical", makeVec(), 4);

    const vectorDb = {
      search: async () => [{ entry: factsDb.getById(apple.id)!, score: 0.95 }],
    } as unknown as import("../backends/vector-db.js").VectorDB;

    const result = await runRetrievalPipeline("apple", [1, 0, 0, 0], factsDb.getRawDb(), vectorDb, factsDb, {
      mode: "constrained-recall",
      constrainedFilters: { entity: "nonexistent-project" },
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["semantic"] },
      budgetTokens: 5000,
    });

    expect(result.fused).toHaveLength(0);
    expect(result.packed).toHaveLength(0);
  });

  it("applies category filter in constrained-recall mode", async () => {
    const pref = factsDb.store({
      text: "User preference",
      category: "preference",
      importance: 0.7,
      entity: "ux",
      key: null,
      value: null,
      source: "conversation",
    });
    const fact = factsDb.store({
      text: "Random fact",
      category: "fact",
      importance: 0.6,
      entity: "ux",
      key: null,
      value: null,
      source: "conversation",
    });
    factsDb.storeEmbedding(pref.id, "test-model", "canonical", makeVec(), 4);
    factsDb.storeEmbedding(fact.id, "test-model", "canonical", makeVec(), 4);

    const vectorDb = {
      search: async () => [
        { entry: factsDb.getById(pref.id)!, score: 0.9 },
        { entry: factsDb.getById(fact.id)!, score: 0.85 },
      ],
    } as unknown as import("../backends/vector-db.js").VectorDB;

    const result = await runRetrievalPipeline("user preference", [1, 0, 0, 0], factsDb.getRawDb(), vectorDb, factsDb, {
      mode: "constrained-recall",
      constrainedFilters: { entity: "ux", category: "preference" },
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["semantic"] },
      budgetTokens: 5000,
    });

    const ids = result.fused.map((r) => r.factId);
    expect(ids).toContain(pref.id);
    expect(ids).not.toContain(fact.id);
  });

  it("returns hydrated MemoryEntry objects in the result", async () => {
    const fact = factsDb.store({
      text: "Test fact for hydration",
      category: "fact",
      importance: 0.8,
      entity: "test",
      key: null,
      value: null,
      source: "conversation",
    });
    factsDb.storeEmbedding(fact.id, "test-model", "canonical", makeVec(), 4);

    const vectorDb = {
      search: async () => [{ entry: factsDb.getById(fact.id)!, score: 0.95 }],
    } as unknown as import("../backends/vector-db.js").VectorDB;

    const result = await runRetrievalPipeline("test", [1, 0, 0, 0], factsDb.getRawDb(), vectorDb, factsDb, {
      mode: "constrained-recall",
      constrainedFilters: { entity: "test" },
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["semantic"] },
      budgetTokens: 5000,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe(fact.id);
    expect(result.entries[0].text).toBe("Test fact for hydration");
    expect(result.entries[0].category).toBe("fact");
    expect(result.entries[0].entity).toBe("test");
  });

  it("includes provenance in serialized output", async () => {
    const fact = factsDb.store({
      text: "Fact with provenance",
      category: "fact",
      importance: 0.8,
      entity: "test",
      key: null,
      value: null,
      source: "conversation",
    });
    factsDb.storeEmbedding(fact.id, "test-model", "canonical", makeVec(), 4);

    const vectorDb = {
      search: async () => [{ entry: factsDb.getById(fact.id)!, score: 0.95 }],
    } as unknown as import("../backends/vector-db.js").VectorDB;

    const result = await runRetrievalPipeline("provenance", [1, 0, 0, 0], factsDb.getRawDb(), vectorDb, factsDb, {
      mode: "constrained-recall",
      constrainedFilters: { entity: "test" },
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["semantic"] },
      budgetTokens: 5000,
    });

    expect(result.packed).toHaveLength(1);
    expect(result.packed[0]).toContain("Fact with provenance");
    expect(result.packed[0]).toMatch(/entity: test/);
    expect(result.packed[0]).toMatch(/category: fact/);
  });

  it("superseded facts are excluded from constrained-recall results", async () => {
    const oldFact = factsDb.store({
      text: "Old fact superseded",
      category: "fact",
      importance: 0.6,
      entity: "test",
      key: null,
      value: null,
      source: "conversation",
    });
    const newFact = factsDb.store({
      text: "New fact current",
      category: "fact",
      importance: 0.8,
      entity: "test",
      key: null,
      value: null,
      source: "conversation",
    });
    factsDb.storeEmbedding(oldFact.id, "test-model", "canonical", makeVec(), 4);
    factsDb.storeEmbedding(newFact.id, "test-model", "canonical", makeVec(), 4);

    // Mark old fact as superseded
    factsDb
      .getRawDb()
      .prepare("UPDATE facts SET superseded_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000), oldFact.id);

    const vectorDb = {
      search: async () => [
        { entry: factsDb.getById(oldFact.id)!, score: 0.9 },
        { entry: factsDb.getById(newFact.id)!, score: 0.85 },
      ],
    } as unknown as import("../backends/vector-db.js").VectorDB;

    const result = await runRetrievalPipeline("test", [1, 0, 0, 0], factsDb.getRawDb(), vectorDb, factsDb, {
      mode: "constrained-recall",
      constrainedFilters: { entity: "test" },
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["semantic"] },
      budgetTokens: 5000,
    });

    const ids = result.fused.map((r) => r.factId);
    expect(ids).toContain(newFact.id);
    expect(ids).not.toContain(oldFact.id);
  });

  it("allows combined entity + tag filter", async () => {
    // Tags are stored as serialized JSON array; use the tags field in store
    const taggedFact = factsDb.store({
      text: "Tagged fact",
      category: "fact",
      importance: 0.8,
      entity: "test",
      key: null,
      value: null,
      source: "conversation",
      tags: ["zigbee", "homeassistant"],
    });
    const untagged = factsDb.store({
      text: "Untagged fact",
      category: "fact",
      importance: 0.6,
      entity: "test",
      key: null,
      value: null,
      source: "conversation",
    });
    factsDb.storeEmbedding(taggedFact.id, "test-model", "canonical", makeVec(), 4);
    factsDb.storeEmbedding(untagged.id, "test-model", "canonical", makeVec(), 4);

    const vectorDb = {
      search: async () => [
        { entry: factsDb.getById(taggedFact.id)!, score: 0.95 },
        { entry: factsDb.getById(untagged.id)!, score: 0.9 },
      ],
    } as unknown as import("../backends/vector-db.js").VectorDB;

    const result = await runRetrievalPipeline("tagged", [1, 0, 0, 0], factsDb.getRawDb(), vectorDb, factsDb, {
      mode: "constrained-recall",
      constrainedFilters: { entity: "test", tag: "zigbee" },
      config: { ...DEFAULT_RETRIEVAL_CONFIG, strategies: ["semantic"] },
      budgetTokens: 5000,
    });

    const ids = result.fused.map((r) => r.factId);
    expect(ids).toContain(taggedFact.id);
    expect(ids).not.toContain(untagged.id);
  });
});
