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

/** Truncate for storage (config-driven); appends " [truncated]" when truncated. Handles null/undefined gracefully. */
export function truncateForStorage(text: string | null | undefined, maxChars: number): string {
  if (text == null) return "";
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text.trim();
  return `${text.slice(0, maxChars).trim()} [truncated]`;
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
 * Used by distill CLI for oversized sessions.
 *
 * @param text - Full session text
 * @param maxTokens - Max tokens per chunk (~4 chars per token)
 * @param overlapRatio - Fraction of chunk to overlap (default 0.1)
 */
export function chunkSessionText(text: string, maxTokens: number, overlapRatio = 0.1): string[] {
  const maxChars = Math.max(1, maxTokens * 4);
  if (text.length <= maxChars) return [text];
  // Clamp below maxChars so the offset always advances by at least 1 char per iteration --
  // an unclamped overlapChars (e.g. from a maxTokens <= 0 caller, or overlapRatio >= 1) can make
  // maxChars - overlapChars <= 0, which loops forever pushing empty-or-non-advancing chunks.
  const overlapChars = Math.min(maxChars - 1, Math.max(0, Math.floor(maxChars * overlapRatio)));
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
 * Format a single progressive index line as "[category] title (N tok)".
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
  return `${t.slice(0, max)}...`;
}

/**
 * Extract timestamp from session filename if it looks like YYYY-MM-DD-*.jsonl.
 */
export function timestampFromFilename(name: string): string | undefined {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

/**
 * Shared helper for generating directory-safe slugs (lowercase, hyphens, alphanumeric; max 60 chars).
 * @param text - The text to slugify.
 * @param fallback - Fallback value when the slug is empty after processing (default: `"skill"`).
 *   Pass `"procedure"` when generating slugs for the generate-auto-skills pipeline to preserve
 *   its original fallback behavior.
 */
export function slugifyForSkill(text: string, fallback = "skill"): string {
  const slug = text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

/**
 * Deduplicate and clean an array of strings (trim, filter empty).
 */
export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

/**
 * Convert a hyphenated slug to title case (e.g., "my-skill-name" → "My Skill Name").
 * Uses the basename of the slug to handle paths correctly.
 */
export function titleCase(slug: string): string {
  const base = slug.includes("/") ? (slug.split("/").pop() ?? slug) : slug;
  return base
    .split("-")
    .map((p) => (p ? p[0]?.toUpperCase() + p.slice(1) : p))
    .join(" ");
}

/**
 * Sanitize recalled fact text by removing thinking/reasoning wrappers and normalizing whitespace.
 * Used by recall injection and context audit to ensure consistent token estimates.
 */
export function sanitizeRecallFactText(text: string): string {
  return text
    .replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, " ")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, " ")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @deprecated Use sanitizeRecallFactText. Kept as an alias for existing callers/tests.
 */
export const sanitizeHotFactText = sanitizeRecallFactText;

/**
 * Escape a string for use in a regular expression literal.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip leading whitespace plus repeated HTML comment blocks from skill content.
 *
 * Skill installers can prepend metadata comments before YAML frontmatter. This
 * helper keeps parser behavior consistent across generated-skill validation,
 * legacy crystallization detection, and static skill validation. If a closing
 * comment marker is followed by content on the same line (for example
 * `<!-- meta --> ---`), scanning resumes at that content instead of discarding
 * the whole line.
 */
export function stripLeadingHtmlComments(content: string): string {
  let body = content.replace(/^\uFEFF/, "");

  while (true) {
    const trimmed = body.replace(/^\s*/, "");
    if (!trimmed.startsWith("<!--")) return trimmed;

    const closeIndex = trimmed.indexOf("-->");
    if (closeIndex === -1) return trimmed;

    body = trimmed.slice(closeIndex + 3);
  }
}
