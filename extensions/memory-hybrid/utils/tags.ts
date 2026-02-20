/**
 * Tag extraction and fuzzy dedupe helpers for facts.
 */

import { createHash } from "node:crypto";

/** Normalize text for fuzzy dedupe (2.3): trim, collapse whitespace, lowercase. */
export function normalizeTextForDedupe(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizedHash(text: string): string {
  return createHash("sha256").update(normalizeTextForDedupe(text)).digest("hex");
}

/** Tag patterns: [tag, regex]. Order matters; first match wins. */
export const TAG_PATTERNS: Array<[string, RegExp]> = [
  ["nibe", /\bnibe\b/i],
  ["zigbee", /\bzigbee\b/i],
  ["z-wave", /\bz-?wave\b/i],
  ["auth", /\bauth(entication|orization)?\b/i],
  ["homeassistant", /\bhome[- ]?assistant\b/i],
  ["openclaw", /\bopenclaw\b/i],
  ["postgres", /\bpostgres(ql)?\b/i],
  ["sqlite", /\bsqlite\b/i],
  ["lancedb", /\blancedb\b/i],
  ["api", /\bapi\s+(key|endpoint|url)\b/i],
  ["docker", /\bdocker\b/i],
  ["kubernetes", /\bkubernetes|k8s\b/i],
  ["ha", /\bha\b/i],
];

/** Extract topic tags from text. Returns lowercase, deduplicated tags. */
export function extractTags(text: string, entity?: string | null): string[] {
  const combined = [text, entity].filter(Boolean).join(" ").toLowerCase();
  const seen = new Set<string>();
  for (const [tag, re] of TAG_PATTERNS) {
    if (re.test(combined) && !seen.has(tag)) {
      seen.add(tag);
    }
  }
  return [...seen];
}

/** Serialize tags for SQLite storage (comma-separated). */
export function serializeTags(tags: string[]): string | null {
  if (tags.length === 0) return null;
  return tags.join(",");
}

/** Parse tags from SQLite (comma-separated). */
export function parseTags(s: string | null | undefined): string[] {
  if (!s || typeof s !== "string") return [];
  return s
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/** Check if tags string contains tag (comma-separated, exact match). */
export function tagsContains(tagsStr: string | null | undefined, tag: string): boolean {
  if (!tagsStr) return false;
  const tagLower = tag.toLowerCase().trim();
  return parseTags(tagsStr).includes(tagLower);
}
