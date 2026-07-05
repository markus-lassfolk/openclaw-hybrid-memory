import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyStoreDedupeMode,
  filterDistillVectorCandidates,
  filterWriteVectorCandidates,
  resolveDistillVectorCandidates,
  resolveWriteVectorCandidates,
} from "../cli/vector-dedupe-helpers.js";
import { DISTILL_DEDUP_THRESHOLD } from "../utils/constants.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("vector-dedupe-helpers", () => {
  let dir: string;
  let db: InstanceType<typeof FactsDB>;

  afterEach(() => {
    if (db) db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("resolveDistillVectorCandidates skips hasDuplicate when vector schema is invalid", async () => {
    const vectorDb = {
      search: vi.fn().mockResolvedValue([]),
      hasDuplicate: vi.fn().mockResolvedValue(true),
      getLastSearchFailReason: vi.fn().mockReturnValue("schema_invalid"),
      isMemoriesVectorSchemaValid: vi.fn().mockReturnValue(false),
    };

    const result = await resolveDistillVectorCandidates({
      fuzzyDedupe: true,
      vector: [0.1, 0.2],
      vectorDb,
      factsDb: { getById: () => null },
      embeddingModelName: "test-embedding",
    });

    expect(vectorDb.search).toHaveBeenCalledOnce();
    expect(vectorDb.hasDuplicate).not.toHaveBeenCalled();
    expect(result.skipAsDuplicate).toBe(false);
    expect(result.vectorSearchDegraded).toBe(true);
    expect(result.usedHasDuplicateFallback).toBe(false);
  });

  it("resolveDistillVectorCandidates falls back to hasDuplicate when vector search is degraded but schema is valid", async () => {
    const vectorDb = {
      search: vi.fn().mockResolvedValue([]),
      hasDuplicate: vi.fn().mockResolvedValue(true),
      getLastSearchFailReason: vi.fn().mockReturnValue("lance_error"),
      isMemoriesVectorSchemaValid: vi.fn().mockReturnValue(true),
    };

    const result = await resolveDistillVectorCandidates({
      fuzzyDedupe: true,
      vector: [0.1, 0.2],
      vectorDb,
      factsDb: { getById: () => null },
      embeddingModelName: "test-embedding",
    });

    expect(vectorDb.search).toHaveBeenCalledOnce();
    expect(vectorDb.hasDuplicate).toHaveBeenCalledWith([0.1, 0.2], DISTILL_DEDUP_THRESHOLD);
    expect(result.skipAsDuplicate).toBe(false);
    expect(result.vectorSearchDegraded).toBe(true);
    expect(result.usedHasDuplicateFallback).toBe(true);
  });

  it("resolveDistillVectorCandidates uses scoped neighbours when search is degraded", async () => {
    dir = mkdtempSync(join(tmpdir(), "vector-dedupe-degraded-"));
    db = new FactsDB(join(dir, "facts.db"));
    const scoped = db.store({
      text: "Scoped distill fact",
      category: "project",
      importance: 0.8,
      entity: "hybrid-memory",
      key: "status",
      value: "in_progress",
      source: "distillation",
    });
    const vectorDb = {
      search: vi.fn().mockResolvedValue([{ entry: { id: scoped.id }, score: 0.93 }]),
      hasDuplicate: vi.fn().mockResolvedValue(true),
      getLastSearchFailReason: vi.fn().mockReturnValue("lance_error"),
      isMemoriesVectorSchemaValid: vi.fn().mockReturnValue(true),
    };

    const result = await resolveDistillVectorCandidates({
      fuzzyDedupe: true,
      vector: [0.1, 0.2],
      vectorDb,
      factsDb: db,
      embeddingModelName: null,
    });

    expect(result.skipAsDuplicate).toBe(false);
    expect(result.vectorCandidates).toEqual([{ id: scoped.id, score: 0.93 }]);
    expect(vectorDb.hasDuplicate).not.toHaveBeenCalled();
  });

  it("resolveDistillVectorCandidates skips vector work when fuzzyDedupe is disabled", async () => {
    const vectorDb = {
      search: vi.fn(),
      hasDuplicate: vi.fn(),
    };

    const result = await resolveDistillVectorCandidates({
      fuzzyDedupe: false,
      vector: [0.1],
      vectorDb,
      factsDb: { getById: () => null },
      embeddingModelName: null,
    });

    expect(vectorDb.search).not.toHaveBeenCalled();
    expect(result.skipAsDuplicate).toBe(false);
    expect(result.vectorCandidates).toBeUndefined();
  });

  it("filterDistillVectorCandidates respects scoped neighbours", () => {
    dir = mkdtempSync(join(tmpdir(), "vector-dedupe-helpers-"));
    db = new FactsDB(join(dir, "facts.db"));
    const scoped = db.store({
      text: "Scoped distill fact",
      category: "project",
      importance: 0.8,
      entity: "hybrid-memory",
      key: "status",
      value: "in_progress",
      source: "distillation",
      scope: "agent",
      scopeTarget: "main",
    });

    const filtered = filterDistillVectorCandidates(
      [{ entry: { id: scoped.id }, score: 0.92 }],
      db,
      null,
      "agent",
      "main",
    );

    expect(filtered).toEqual([{ id: scoped.id, score: 0.92 }]);
    expect(filterDistillVectorCandidates([{ entry: { id: scoped.id }, score: 0.92 }], db, null)).toEqual([]);
  });

  it("filterWriteVectorCandidates keeps only same-source, in-scope live facts (#2027)", () => {
    dir = mkdtempSync(join(tmpdir(), "write-vector-dedupe-"));
    db = new FactsDB(join(dir, "facts.db"));
    const convo = db.store({
      text: "User likes tea",
      importance: 0.6,
      source: "conversation",
      category: "other",
      entity: null,
      key: null,
      value: null,
    });
    const distilled = db.store({
      text: "Distilled fact",
      importance: 0.6,
      source: "distillation",
      category: "other",
      entity: null,
      key: null,
      value: null,
    });

    const filtered = filterWriteVectorCandidates(
      [
        { entry: { id: convo.id }, score: 0.97 },
        { entry: { id: distilled.id }, score: 0.99 },
      ],
      db,
      { source: "conversation", embeddingModelName: null },
    );
    // Only the conversation-source neighbour survives; the distillation one is filtered out.
    expect(filtered).toEqual([{ id: convo.id, score: 0.97 }]);
  });

  it("resolveWriteVectorCandidates returns source-filtered candidates for the live store path (#2027)", async () => {
    dir = mkdtempSync(join(tmpdir(), "resolve-write-vector-dedupe-"));
    db = new FactsDB(join(dir, "facts.db"));
    const convo = db.store({
      text: "User likes tea",
      importance: 0.6,
      source: "conversation",
      category: "other",
      entity: null,
      key: null,
      value: null,
    });
    const vectorDb = {
      search: vi.fn().mockResolvedValue([{ entry: { id: convo.id }, score: 0.96 }]),
      getLastSearchFailReason: vi.fn().mockReturnValue(null),
    };

    const result = await resolveWriteVectorCandidates({
      fuzzyDedupe: true,
      vector: [0.1, 0.2],
      vectorDb,
      factsDb: db,
      source: "conversation",
      embeddingModelName: null,
    });

    expect(vectorDb.search).toHaveBeenCalledOnce();
    expect(result.vectorSearchDegraded).toBe(false);
    expect(result.vectorCandidates).toEqual([{ id: convo.id, score: 0.96 }]);
  });

  it("resolveWriteVectorCandidates degrades gracefully when vector search throws (#2027)", async () => {
    const vectorDb = {
      search: vi.fn().mockRejectedValue(new Error("lance down")),
      getLastSearchFailReason: vi.fn().mockReturnValue(null),
    };
    const result = await resolveWriteVectorCandidates({
      fuzzyDedupe: true,
      vector: [0.1],
      vectorDb,
      factsDb: { getById: () => null },
      source: "conversation",
      embeddingModelName: null,
    });
    expect(result.vectorSearchDegraded).toBe(true);
    expect(result.vectorCandidates).toBeUndefined();
  });

  it("resolveWriteVectorCandidates skips vector work when fuzzyDedupe is disabled (#2027)", async () => {
    const vectorDb = { search: vi.fn(), getLastSearchFailReason: vi.fn() };
    const result = await resolveWriteVectorCandidates({
      fuzzyDedupe: false,
      vector: [0.1],
      vectorDb,
      factsDb: { getById: () => null },
      source: "conversation",
      embeddingModelName: null,
    });
    expect(vectorDb.search).not.toHaveBeenCalled();
    expect(result.vectorCandidates).toBeUndefined();
  });

  it("classifyStoreDedupeMode distinguishes vector and degraded lexical paths", () => {
    expect(
      classifyStoreDedupeMode({
        fuzzyDedupe: true,
        vectorSearchDegraded: false,
        vectorCandidates: [{ id: "a", score: 0.9 }],
        usedHasDuplicateFallback: false,
        skipAsDuplicate: false,
      }),
    ).toBe("vector");
    expect(
      classifyStoreDedupeMode({
        fuzzyDedupe: true,
        vectorSearchDegraded: true,
        usedHasDuplicateFallback: true,
        skipAsDuplicate: true,
      }),
    ).toBe("mixed");
  });
});
