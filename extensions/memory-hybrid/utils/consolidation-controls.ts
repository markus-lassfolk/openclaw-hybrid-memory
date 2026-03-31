import type { DecayClass } from "../config.js";

export const CONSOLIDATED_FACT_DECAY_CLASS: DecayClass = "durable";
const CONSOLIDATED_RETRIEVAL_SCORE_MULTIPLIER = 0.85;

type ConsolidatedFactLike = {
  source?: string | null;
  key?: string | null;
  tags?: string[] | null;
};

export function isConsolidatedDerivedFact(entry: ConsolidatedFactLike): boolean {
  const source = (entry.source ?? "").trim().toLowerCase();
  if (source === "consolidation" || source === "dream-cycle") return true;

  const key = (entry.key ?? "").trim().toLowerCase();
  if (key === "consolidated") return true;

  return (entry.tags ?? []).some((tag) => tag.trim().toLowerCase() === "consolidated");
}

export function applyConsolidationRetrievalControls(score: number, entry: ConsolidatedFactLike): number {
  return isConsolidatedDerivedFact(entry) ? score * CONSOLIDATED_RETRIEVAL_SCORE_MULTIPLIER : score;
}
