import { REFLECTION_PATTERN_MAX_CHARS } from "../../utils/constants.js";

export const REFLECTION_PATTERN_MIN_CHARS = 20;
export const REFLECTION_RULE_MIN_CHARS = 10;
export const REFLECTION_RULE_MAX_CHARS = 120;
export const REFLECTION_META_MIN_CHARS = 20;
export const REFLECTION_MAX_PATTERNS_FOR_RULES = 50;
export const REFLECTION_MAX_PATTERNS_FOR_META = 30;

/**
 * Normalize vector to unit length.
 */
export function normalizeVector(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/**
 * Compute dot product between two PRE-NORMALIZED vectors.
 * This is an optimized version that assumes both vectors are already unit-length.
 * Returns the dot product, which equals cosine similarity for normalized vectors.
 *
 * IMPORTANT: Use this ONLY when vectors are normalized via normalizeVector() first.
 * For arbitrary (non-normalized) vectors, use cosineSimilarity from ambient-retrieval.ts instead.
 */
export function dotProductSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Parse PATTERN: lines from reflection LLM response. Exported for tests.
 */
export function parsePatternsFromReflectionResponse(rawResponse: string): string[] {
  const patterns: string[] = [];
  for (const line of rawResponse.split(/\n/)) {
    const m = line.match(/^\s*PATTERN:\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length >= REFLECTION_PATTERN_MIN_CHARS && text.length <= REFLECTION_PATTERN_MAX_CHARS) {
      patterns.push(text);
    }
  }
  const seenInBatch = new Set<string>();
  const unique: string[] = [];
  for (const p of patterns) {
    const key = p.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    unique.push(p);
  }
  return unique;
}
