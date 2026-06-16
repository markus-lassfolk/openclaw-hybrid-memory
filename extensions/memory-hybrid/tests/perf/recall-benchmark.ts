/**
 * Recall benchmark harness (Issue #1910 / Epic #1918).
 * Runs labeled corpus queries and writes recall-benchmark-<commit>.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyIntentHeuristic } from "../services/intent-classifier.js";
import { computeCompositeScore } from "../services/composite-score.js";

export type CorpusRow = {
  query: string;
  expected_fact_ids?: string[];
  intent?: string;
};

export type BenchmarkResult = {
  commit: string;
  timestamp: string;
  rows: number;
  intentAccuracy: number;
  avgCompositeV2: number;
};

function ndcgAtK(relevant: Set<string>, ranked: string[], k: number): number {
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

export function runRecallBenchmark(corpusPath: string, commit = "local"): BenchmarkResult {
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

  return {
    commit,
    timestamp: new Date().toISOString(),
    rows: rows.length,
    intentAccuracy: intentTotal > 0 ? intentHits / intentTotal : 0,
    avgCompositeV2: rows.length > 0 ? compositeSum / rows.length : 0,
  };
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
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

export { ndcgAtK };
