/**
 * Model tier classification utilities.
 *
 * These heuristics classify models into tiers based on their name patterns:
 * - Nano:   nano, mini, haiku, lite, turbo-mini — ultra-cheap for classify/HyDE/summarize
 * - Heavy:  pro, opus, o3, o1, large, ultra, gpt-5 — capable/expensive models
 * - Light:  flash, small — fast/cheap (but not nano-cheap)
 * - Medium: everything else (sonnet, gpt-4o, etc.)
 *
 * All ollama/* models are nano-tier (local = free, no API cost).
 */

/**
 * Returns true if the model should be classified as nano-tier (ultra-cheap or local).
 */
export function isNanoModel(m: string): boolean {
  return (
    m.split("/")[0]?.toLowerCase() === "ollama" ||
    /nano|\bmini\b|haiku|\blite\b|\bturbo-mini\b/.test((m.split("/").pop() ?? m).toLowerCase())
  );
}

/**
 * Returns true if the model should be classified as heavy-tier (expensive/capable).
 * Ollama models are never heavy-tier (they're local/free).
 */
export function isHeavyModel(m: string): boolean {
  return (
    m.split("/")[0]?.toLowerCase() !== "ollama" &&
    /\bpro\b|opus|\bo3\b|\bo1\b|\blarge\b|ultra|heavy|gpt-5/.test((m.split("/").pop() ?? m).toLowerCase())
  );
}

/**
 * Returns true if the model should be classified as light-tier (fast/cheap).
 * Ollama models are never light-tier (they're local/free, nano-tier).
 */
export function isLightModel(m: string): boolean {
  return m.split("/")[0]?.toLowerCase() !== "ollama" && /flash|\bsmall\b/.test((m.split("/").pop() ?? m).toLowerCase());
}
