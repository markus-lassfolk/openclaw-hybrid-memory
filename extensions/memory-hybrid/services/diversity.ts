/**
 * MMR-style diversity for recall results (Issue #1910).
 * Demotes near-duplicates (Jaccard bigram > threshold) to bottom half; never drops.
 */

/** Tokenize into character bigrams for Jaccard similarity. */
export function textBigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const bigrams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) {
    bigrams.add(normalized.slice(i, i + 2));
  }
  return bigrams;
}

/** Jaccard similarity between two texts using character bigrams. */
export function jaccardBigramSimilarity(a: string, b: string): number {
  const setA = textBigrams(a);
  const setB = textBigrams(b);
  if (setA.size === 0 && setB.size === 0) {
    // Texts of length <= 1 (after normalization) have no bigrams at all, so the
    // set comparison below can't distinguish them. Fall back to direct equality
    // rather than treating every short text as maximally similar to every other.
    const normalize = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
    return normalize(a) === normalize(b) ? 1 : 0;
  }
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type DiversityConfig = {
  enabled: boolean;
  maxSimilarity: number;
  /**
   * "mmr": embedding-cosine Maximal Marginal Relevance selection (needs candidate vectors; falls
   * back to bigram demotion for vectorless items). "bigram": legacy surface-form demotion.
   * Default "bigram" until the eval harness compares the two (living-memory P3.2, staged flip).
   */
  mode?: "bigram" | "mmr";
  /** MMR relevance↔novelty trade-off λ (default 0.7 = mostly relevance). */
  mmrLambda?: number;
};

export const DEFAULT_DIVERSITY_CONFIG: DiversityConfig = {
  enabled: false,
  maxSimilarity: 0.6,
};

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Maximal Marginal Relevance over embedding vectors: greedily pick the item maximizing
 * λ·relevance − (1−λ)·max-similarity-to-already-selected. Real semantic diversity — paraphrases
 * that share few bigrams still repel; lexically-similar but semantically distinct items don't.
 * Items without a vector score novelty via bigram distance so nothing is silently dropped.
 */
export function applyMMR<T extends { text: string; score: number }>(
  ranked: T[],
  getVector: (item: T) => number[] | null | undefined,
  lambda = 0.7,
): DiversityResult<T> {
  if (ranked.length <= 2) return { items: ranked, demotedCount: 0 };
  const remaining = [...ranked];
  const selected: T[] = [remaining.shift() as T];
  let reordered = 0;

  const similarity = (a: T, b: T): number => {
    const va = getVector(a);
    const vb = getVector(b);
    if (va && vb && va.length > 0 && vb.length > 0) return cosine(va, vb);
    return jaccardBigramSimilarity(a.text, b.text);
  };

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i];
      const maxSim = selected.reduce((m, s) => Math.max(m, similarity(item, s)), 0);
      const mmr = lambda * item.score - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    if (bestIdx !== 0) reordered++;
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return { items: selected, demotedCount: reordered };
}

export type DiversityResult<T> = {
  items: T[];
  demotedCount: number;
};

/**
 * Apply diversity demotion to ranked results.
 * Items similar to a higher-ranked item are moved to the bottom half (cap 50% demoted).
 */
export function applyDiversityDemotion<T extends { text: string }>(
  ranked: T[],
  config: DiversityConfig = DEFAULT_DIVERSITY_CONFIG,
): DiversityResult<T> {
  if (!config.enabled || ranked.length <= 1) {
    return { items: ranked, demotedCount: 0 };
  }

  const maxDemote = Math.floor(ranked.length * 0.5);
  const kept: T[] = [];
  const demoted: T[] = [];

  for (const item of ranked) {
    const tooSimilar = kept.some((k) => jaccardBigramSimilarity(k.text, item.text) > config.maxSimilarity);
    if (tooSimilar && demoted.length < maxDemote) {
      demoted.push(item);
    } else {
      kept.push(item);
    }
  }

  const bottomStart = Math.ceil(ranked.length / 2);
  const result = [...kept];
  let insertAt = Math.min(bottomStart, result.length);
  for (const d of demoted) {
    result.splice(insertAt, 0, d);
    insertAt++;
  }

  return { items: result, demotedCount: demoted.length };
}
