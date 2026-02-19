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

/**
 * Chunk session text into overlapping windows. No content is dropped.
 * Used by distill CLI for oversized sessions (issue #32).
 *
 * @param text - Full session text
 * @param maxTokens - Max tokens per chunk (~4 chars per token)
 * @param overlapRatio - Fraction of chunk to overlap (default 0.1)
 */
export function chunkSessionText(text: string, maxTokens: number, overlapRatio = 0.1): string[] {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return [text];
  const overlapChars = Math.floor(maxChars * overlapRatio);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const end = Math.min(offset + maxChars, text.length);
    chunks.push(text.slice(offset, end));
    if (end >= text.length) break;
    offset = end - overlapChars;
  }
  return chunks;
}

/**
 * Chunk text by character size with overlap. Used by ingest-files.
 */
export function chunkTextByChars(text: string, chunkSize: number, overlap: number): string[] {
  if (chunkSize <= 0 || text.length <= chunkSize) return text ? [text] : [""];
  const step = Math.max(1, chunkSize - overlap);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + chunkSize));
    offset += step;
    if (offset >= text.length) break;
  }
  return chunks;
}

/**
 * FR-009: Format a single progressive index line as "[category] title (N tok)".
 * Used by auto-recall when injectionFormat is progressive or progressive_hybrid.
 */
export function formatProgressiveIndexLine(
  category: string,
  title: string,
  tokenCost: number,
  position: number,
): string {
  return `  ${position}. [${category}] ${title} (${tokenCost} tok)`;
}

/**
 * Extract text content from message content blocks (used by extraction services).
 * Handles array of content blocks with type "text".
 */
export function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: string }).text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  return parts.join("\n");
}

/**
 * Simple truncate with ellipsis (used by extraction services).
 * Different from truncateText which uses a configurable suffix.
 */
export function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "...";
}

/**
 * Extract timestamp from session filename if it looks like YYYY-MM-DD-*.jsonl.
 */
export function timestampFromFilename(name: string): string | undefined {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}
