/**
 * Auto-select retrieval mode based on query signals (#1802).
 */

export type RetrievalModeChoice = "constrained-recall" | "explicit-deep";

export type RetrievalModeSelectorInput = {
  entity?: string;
  tag?: string;
  category?: string;
  source?: string;
  verificationTier?: string;
  sourceSession?: string;
  validFromSec?: number;
  validUntilSec?: number;
};

const ENTITY_IN_QUERY =
  /\b(?:project|repo|repository|service|person|contact|org(?:anization)?|team)\s+[:=]?\s*[\w.-]+/i;
const TAG_IN_QUERY = /(?:#|tag:)[\w-]+/i;
const BOUNDED_TIME = /\b(?:last|past|recent|since|from)\s+\d+\s*(?:day|week|month|hour)s?\b/i;

/**
 * Infer retrieval mode when caller did not specify one explicitly.
 * Bounded queries → constrained-recall; open-ended → explicit-deep (with graph).
 */
export function inferRetrievalModeFromQuery(
  query: string,
  filters: RetrievalModeSelectorInput = {},
): RetrievalModeChoice {
  const hasStructuredFilter = Boolean(
    filters.entity ||
      filters.tag ||
      filters.category ||
      filters.source ||
      filters.verificationTier ||
      filters.sourceSession ||
      filters.validFromSec != null ||
      filters.validUntilSec != null,
  );
  if (hasStructuredFilter) return "constrained-recall";

  const q = query.trim();
  if (!q) return "explicit-deep";

  if (ENTITY_IN_QUERY.test(q) || TAG_IN_QUERY.test(q) || BOUNDED_TIME.test(q)) {
    return "constrained-recall";
  }

  // Short entity-like tokens: "openclaw-hybrid-memory deploy status"
  const tokens = q.match(/\b[a-z0-9][a-z0-9_-]{2,}\b/gi) ?? [];
  const hyphenated = tokens.filter((t) => t.includes("-") && t.length >= 4);
  if (hyphenated.length >= 1 && q.split(/\s+/).length <= 8) {
    return "constrained-recall";
  }

  return "explicit-deep";
}

/**
 * Extract implicit entity filter from query when none was provided explicitly.
 */
export function inferEntityFilterFromQuery(query: string): string | undefined {
  const explicit = query.match(/\b(?:project|repo|repository|service|entity)\s+[:=]?\s*([a-z0-9][a-z0-9_.-]{1,60})/i);
  if (explicit?.[1]) return explicit[1].trim();

  // Single hyphenated token queries: "openclaw-hybrid-memory deploy status"
  const tokens = query.match(/\b[a-z0-9][a-z0-9_-]{3,}\b/gi) ?? [];
  const hyphenated = tokens.filter((t) => t.includes("-") && t.length >= 4);
  if (hyphenated.length === 1) return hyphenated[0].toLowerCase();

  return undefined;
}
