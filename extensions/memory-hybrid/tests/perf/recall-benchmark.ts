/**
 * Recall benchmark harness (Issue #1910 / Epic #1918).
 * Runs labeled corpus queries and writes recall-benchmark-<commit>.json
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FactsDB } from "../../backends/facts-db.js";
import { classifyIntentHeuristic } from "../../services/intent-classifier.js";
import { computeCompositeScore } from "../../services/composite-score.js";
import { searchFts } from "../../services/fts-search.js";

export type CorpusRow = {
  query: string;
  expected_fact_ids?: string[];
  intent?: string;
  seed_text?: string;
};

export type BenchmarkResult = {
  commit: string;
  timestamp: string;
  rows: number;
  intentAccuracy: number;
  avgCompositeV2: number;
  ndcgAt5: number;
};

export const RECALL_BENCHMARK_MIN_INTENT_ACCURACY = 0.6;
export const RECALL_BENCHMARK_MIN_NDCG_AT_5 = 0.4;

export function ndcgAtK(relevant: Set<string>, ranked: string[], k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevant.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  const ideal = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function loadCorpus(path: string): CorpusRow[] {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CorpusRow);
}

/** Seed corpus rows into a facts DB; returns logical expected id → stored fact id. */
export function seedCorpusFacts(factsDb: FactsDB, rows: CorpusRow[]): Map<string, string> {
  const idMap = new Map<string, string>();
  for (const row of rows) {
    const text = row.seed_text ?? row.query;
    const stored = factsDb.store({
      text,
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "recall-benchmark",
    });
    const logicalId = row.expected_fact_ids?.[0];
    if (logicalId) idMap.set(logicalId, stored.id);
    // Distractor facts to make ranking non-trivial
    factsDb.store({
      text: `Unrelated note about ${row.query.split(" ").slice(-2).join(" ")} and miscellaneous context`,
      category: "fact",
      importance: 0.3,
      entity: null,
      key: null,
      value: null,
      source: "recall-benchmark-distractor",
    });
  }
  return idMap;
}

/** Compute average NDCG@k using FTS5 ranking against seeded corpus facts. */
export function measureFtsNdcg(factsDb: FactsDB, rows: CorpusRow[], idMap: Map<string, string>, k = 5): number {
  const db = factsDb.getRawDb();
  let sum = 0;
  let counted = 0;
  for (const row of rows) {
    const expected = row.expected_fact_ids ?? [];
    if (expected.length === 0) continue;
    const relevant = new Set(expected.map((lid) => idMap.get(lid)).filter((id): id is string => Boolean(id)));
    if (relevant.size === 0) continue;
    const hits = searchFts(db, row.query, { limit: k });
    const ranked = hits.map((h) => h.factId);
    sum += ndcgAtK(relevant, ranked, k);
    counted++;
  }
  return counted > 0 ? sum / counted : 0;
}

export function runRecallBenchmark(
  corpusPath: string,
  commit = "local",
  opts?: { factsDb?: FactsDB; idMap?: Map<string, string> },
): BenchmarkResult {
  const rows = loadCorpus(corpusPath);
  let intentHits = 0;
  let intentTotal = 0;
  let compositeSum = 0;

  for (const row of rows) {
    const intent = classifyIntentHeuristic(row.query);
    if (row.intent) {
      intentTotal++;
      if (intent.intent === row.intent) intentHits++;
    }
    compositeSum += computeCompositeScore(
      {
        searchScore: 0.7,
        recencyScore: 0.6,
        confidence: 0.8,
        bodyLength: 400,
        intent: intent.intent,
      },
      { version: 2, pinBoostDefault: 0.3, pinBoostCap: 1 },
    );
  }

  let ndcg = 0;
  if (opts?.factsDb && opts.idMap) {
    ndcg = measureFtsNdcg(opts.factsDb, rows, opts.idMap, 5);
  }

  return {
    commit,
    timestamp: new Date().toISOString(),
    rows: rows.length,
    intentAccuracy: intentTotal > 0 ? intentHits / intentTotal : 0,
    avgCompositeV2: rows.length > 0 ? compositeSum / rows.length : 0,
    ndcgAt5: ndcg,
  };
}

export function assertRecallBenchmarkGate(result: BenchmarkResult): void {
  if (result.intentAccuracy < RECALL_BENCHMARK_MIN_INTENT_ACCURACY) {
    throw new Error(
      `recall benchmark gate failed: intentAccuracy ${result.intentAccuracy.toFixed(3)} < ${RECALL_BENCHMARK_MIN_INTENT_ACCURACY}`,
    );
  }
  if (result.ndcgAt5 < RECALL_BENCHMARK_MIN_NDCG_AT_5) {
    throw new Error(
      `recall benchmark gate failed: ndcgAt5 ${result.ndcgAt5.toFixed(3)} < ${RECALL_BENCHMARK_MIN_NDCG_AT_5}`,
    );
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusDefault = join(__dirname, "../fixtures/recall-corpus.jsonl");

if (import.meta.url === `file://${process.argv[1]}`) {
  const corpus = process.argv[2] ?? corpusDefault;
  if (!existsSync(corpus)) {
    console.error(`Corpus not found: ${corpus}`);
    process.exit(1);
  }
  const commit = process.env.GIT_COMMIT ?? "local";
  const result = runRecallBenchmark(corpus, commit);
  const out = join(__dirname, `../../.benchmark/recall-benchmark-${commit}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
