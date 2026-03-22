/**
 * Lightweight guard for deciding whether a user message should enter memory retrieval.
 *
 * The validator is intentionally conservative: it only blocks obvious conversational
 * filler / social chatter so we avoid wasting embedding + retrieval work on turns that
 * clearly do not need memory lookup.
 */

export interface QueryValidationResult {
  requiresLookup: boolean;
  reason: string;
}

const FILLER_PATTERNS: RegExp[] = [
  /^(?:hi|hello|hey|yo|hiya)[!. ]*$/i,
  /^(?:thanks|thank you|thx|tysm)[!. ]*$/i,
  /^(?:ok|okay|kk|cool|nice|great|awesome|got it|sounds good|sure|yep|yup|nah|nope)[!. ]*$/i,
  /^(?:good morning|good afternoon|good evening|good night)[!. ]*$/i,
  /^(?:how are you|how's it going|what's up|sup|who are you|tell me a joke)[?!. ]*$/i,
  /^(?:please continue|continue|go on|carry on)[!. ]*$/i,
];

/**
 * Returns whether the query should go through memory retrieval.
 *
 * Only obviously non-retrieval chatter is rejected; everything else is allowed so we
 * don't accidentally suppress legitimate memory lookups.
 */
export function validateQueryForMemoryLookup(query: string): QueryValidationResult {
  const normalized = query.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return { requiresLookup: false, reason: "empty-query" };
  }

  if (!/[\p{L}\p{N}]/u.test(normalized)) {
    return { requiresLookup: false, reason: "non-semantic-input" };
  }

  if (FILLER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { requiresLookup: false, reason: "conversational-filler" };
  }

  return { requiresLookup: true, reason: "memory-lookup-candidate" };
}
