/**
 * Dream canary attribution (#2173) — optionally prefer recently promoted dream-run facts in recall.
 */

import { DREAM_RUN_TAG_PREFIX } from "./dream-metrics.js";

export const DREAM_CANARY_BOOST = 1.08;

/** True when any tag is a dream-run attribution tag. */
export function hasDreamCanaryTag(tags: string[] | null | undefined): boolean {
  if (!tags?.length) return false;
  const prefix = DREAM_RUN_TAG_PREFIX.toLowerCase();
  return tags.some((t) => t.toLowerCase().startsWith(prefix));
}

/**
 * Mildly boost recall scores for dream-run-tagged facts during the post-promote
 * observation window so canary curriculum is exercised (#2173).
 */
export function applyDreamCanaryBoost<T extends { score: number; entry: { tags?: string[] | null } }>(
  candidates: T[],
  options: { enabled: boolean; boost?: number } = { enabled: false },
): T[] {
  if (!options.enabled || candidates.length === 0) return candidates;
  const factor = options.boost ?? DREAM_CANARY_BOOST;
  let changed = false;
  const out = candidates.map((c) => {
    if (!hasDreamCanaryTag(c.entry.tags)) return c;
    changed = true;
    return { ...c, score: c.score * factor };
  });
  if (!changed) return candidates;
  out.sort((a, b) => b.score - a.score);
  return out;
}
