/** Ranking metrics for the retrieval-eval harness: P@k, R@k, nDCG@k over gold relevant-id sets. */

export function precisionAtK(ranked: string[], relevant: ReadonlySet<string>, k: number): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  const hits = top.filter((id) => relevant.has(id)).length;
  return hits / k;
}

export function recallAtK(ranked: string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 1;
  const hits = ranked.slice(0, k).filter((id) => relevant.has(id)).length;
  return hits / relevant.size;
}

export function ndcgAtK(ranked: string[], relevant: ReadonlySet<string>, k: number): number {
  const dcg = ranked.slice(0, k).reduce((sum, id, i) => sum + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const idealHits = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 1 : dcg / idcg;
}

export interface EvalSummary {
  queries: number;
  meanPrecisionAt5: number;
  meanRecallAt10: number;
  meanNdcgAt10: number;
}

export function summarize(perQuery: Array<{ ranked: string[]; relevant: ReadonlySet<string> }>): EvalSummary {
  const n = perQuery.length || 1;
  const sum = perQuery.reduce(
    (acc, q) => ({
      p5: acc.p5 + precisionAtK(q.ranked, q.relevant, 5),
      r10: acc.r10 + recallAtK(q.ranked, q.relevant, 10),
      ndcg10: acc.ndcg10 + ndcgAtK(q.ranked, q.relevant, 10),
    }),
    { p5: 0, r10: 0, ndcg10: 0 },
  );
  return {
    queries: perQuery.length,
    meanPrecisionAt5: sum.p5 / n,
    meanRecallAt10: sum.r10 / n,
    meanNdcgAt10: sum.ndcg10 / n,
  };
}
