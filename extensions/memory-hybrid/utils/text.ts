/**
 * Shared text utilities (truncation, etc.).
 */

/** Single place for text truncation. Returns text up to maxLen, with suffix if truncated. */
export function truncateText(text: string, maxLen: number, suffix = "…"): string {
  if (maxLen <= 0) return "";
  if (maxLen <= suffix.length) return suffix.slice(0, maxLen);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - suffix.length).trim() + suffix;
}

/** Truncate for storage (config-driven); appends " [truncated]" when truncated. */
export function truncateForStorage(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text.trim();
  return text.slice(0, maxChars).trim() + " [truncated]";
}

/** Rough token count (OpenAI-style: ~4 chars per token for English). Used for auto-recall cap. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * More accurate token estimate for display (e.g. progressive index cost).
 * Uses word-boundary heuristic: each word contributes max(1, ceil(len/4)) so short words
 * aren't overcounted. Improves accuracy vs length/4 for typical English without a tokenizer dependency.
 */
export function estimateTokensForDisplay(text: string): number {
  if (!text.trim()) return 0;
  const words = text.split(/\s+/).filter(Boolean);
  return words.reduce((sum, w) => sum + Math.max(1, Math.ceil(w.length / 4)), 0);
}
