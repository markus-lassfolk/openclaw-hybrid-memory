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
  if (setA.size === 0 && setB.size === 0) return 1;
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
};

export const DEFAULT_DIVERSITY_CONFIG: DiversityConfig = {
  enabled: false,
  maxSimilarity: 0.6,
};

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
    const tooSimilar = kept.some(
      (k) => jaccardBigramSimilarity(k.text, item.text) > config.maxSimilarity,
    );
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
