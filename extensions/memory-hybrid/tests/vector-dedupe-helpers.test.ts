import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyStoreDedupeMode,
  filterDistillVectorCandidates,
  resolveDistillVectorCandidates,
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

  it("resolveDistillVectorCandidates falls back to hasDuplicate when vector search is degraded", async () => {
    const vectorDb = {
      search: vi.fn(),
      hasDuplicate: vi.fn().mockResolvedValue(true),
      getLastSearchFailReason: vi.fn().mockReturnValue("schema_invalid"),
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
    expect(result.skipAsDuplicate).toBe(true);
    expect(result.vectorSearchDegraded).toBe(true);
    expect(result.usedHasDuplicateFallback).toBe(true);
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
