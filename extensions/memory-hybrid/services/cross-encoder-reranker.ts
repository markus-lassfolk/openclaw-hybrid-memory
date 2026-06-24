/**
 * Cross-encoder reranker provider (Issue #1910).
 * Talks to llama-server /v1/rerank or returns original order on failure.
 */

import type { ScoredFact } from "./reranker.js";

export type CrossEncoderConfig = {
  endpoint?: string;
  model: string;
  timeoutMs: number;
};

export const DEFAULT_CROSS_ENCODER_CONFIG: CrossEncoderConfig = {
  model: "Qwen3-Reranker-0.6B-Q8_0",
  timeoutMs: 200,
};

/** Position-aware blend α between rerank and pre-rerank scores. */
export function positionAwareAlpha(rankIndex: number): number {
  if (rankIndex < 3) return 0.75;
  if (rankIndex < 10) return 0.6;
  return 0.4;
}

/** Blend reranked order with pre-rerank scores using position-aware α. */
export function blendRerankScores(facts: ScoredFact[], rerankScores: Map<string, number>): ScoredFact[] {
  return facts
    .map((fact, index) => {
      const rerankScore = rerankScores.get(fact.factId) ?? fact.finalScore;
      const alpha = positionAwareAlpha(index);
      const blended = alpha * rerankScore + (1 - alpha) * fact.finalScore;
      return { ...fact, finalScore: blended };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

type RerankApiResponse = {
  results?: Array<{ index: number; relevance_score?: number; score?: number }>;
};

/** Call external /v1/rerank endpoint; returns score map or null on failure. */
export async function crossEncoderRerank(
  query: string,
  facts: ScoredFact[],
  config: CrossEncoderConfig,
): Promise<Map<string, number> | null> {
  const endpoint = config.endpoint?.trim();
  if (!endpoint || facts.length === 0) return null;

  const url = endpoint.replace(/\/$/, "") + "/v1/rerank";
  const documents = facts.map((f) => f.text.slice(0, 512));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        query,
        documents,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as RerankApiResponse;
    const results = body.results ?? [];
    const scoreMap = new Map<string, number>();
    for (const r of results) {
      const fact = facts[r.index];
      if (!fact) continue;
      const score = r.relevance_score ?? r.score ?? 0;
      scoreMap.set(fact.factId, score);
    }
    return scoreMap.size > 0 ? scoreMap : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Rerank facts via cross-encoder with position-aware blend; falls back to input order. */
export async function rerankWithCrossEncoder(
  query: string,
  facts: ScoredFact[],
  config: CrossEncoderConfig,
  outputCount: number,
): Promise<ScoredFact[]> {
  const candidates = facts.slice(0, 50);
  const tail = facts.slice(50);
  const scoreMap = await crossEncoderRerank(query, candidates, config);
  if (!scoreMap) {
    return facts.slice(0, outputCount);
  }
  const blended = blendRerankScores(candidates, scoreMap);
  return [...blended, ...tail].slice(0, outputCount);
}
