/**
 * Recall benchmark CI gate (Issue #1910 / Epic #1918).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../../backends/facts-db.js";
import {
  assertRecallBenchmarkGate,
  loadCorpus,
  ndcgAtK,
  runRecallBenchmark,
  seedCorpusFacts,
  RECALL_BENCHMARK_MIN_INTENT_ACCURACY,
  RECALL_BENCHMARK_MIN_NDCG_AT_5,
} from "./recall-benchmark.js";

const corpusPath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/recall-corpus.jsonl");

describe("ndcgAtK", () => {
  it("returns 1 for perfect ranking", () => {
    const rel = new Set(["a"]);
    expect(ndcgAtK(rel, ["a", "b", "c"], 5)).toBe(1);
  });

  it("returns 0 when no relevant items in top-k", () => {
    const rel = new Set(["a"]);
    expect(ndcgAtK(rel, ["b", "c"], 5)).toBe(0);
  });
});

describe("recall benchmark gate (#1910 / #1918)", () => {
  let tmpDir: string;
  let factsDb: FactsDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-recall-bench-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"), { fuzzyDedupe: false, storeConfig: { fuzzyDedupe: false } });
  });

  afterEach(() => {
    factsDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes intent and FTS NDCG gates on seeded corpus", () => {
    const rows = loadCorpus(corpusPath);
    const idMap = seedCorpusFacts(factsDb, rows);
    const result = runRecallBenchmark(corpusPath, "test", { factsDb, idMap });

    expect(result.intentAccuracy).toBeGreaterThanOrEqual(RECALL_BENCHMARK_MIN_INTENT_ACCURACY);
    expect(result.ndcgAt5).toBeGreaterThanOrEqual(RECALL_BENCHMARK_MIN_NDCG_AT_5);
    expect(() => assertRecallBenchmarkGate(result)).not.toThrow();
  });
});
