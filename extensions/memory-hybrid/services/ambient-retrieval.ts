/**
 * Ambient Retrieval Engine — Issue #156.
 *
 * Generates multiple implicit queries from conversation context to improve
 * ambient (auto-recall) memory injection quality.
 *
 * Query types:
 *   1. "message"  — Direct semantic match from the incoming message (current behaviour).
 *   2. "entity"   — Entity-neighbourhood lookups for entities mentioned in the message.
 *   3. "temporal" — Time-aware queries ("action items from last 48h", "upcoming deadlines").
 *   4. "context"  — User/channel context queries ("recent topics with [user]").
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AmbientQueryType = "message" | "entity" | "temporal" | "context";

export interface AmbientQuery {
  /** The query text to run against the retrieval pipeline. */
  text: string;
  /** What generated this query. */
  type: AmbientQueryType;
  /** If type=entity, which entity triggered this query. */
  entity?: string;
}

export interface AmbientConfig {
  /** Whether enhanced ambient retrieval is enabled (default: false). */
  enabled: boolean;
  /** When true, generate multiple queries per trigger (default: false). */
  multiQuery: boolean;
  /** Cosine distance threshold for topic-shift detection (0–1, default: 0.4). */
  topicShiftThreshold: number;
  /** Max queries to generate per retrieval trigger (2–4, default: 4). */
  maxQueriesPerTrigger: number;
  /** Token budget for ambient injection (default: 2000). */
  budgetTokens: number;
}

export interface AmbientContext {
  /** User/author identifier (e.g. userId). */
  userId?: string;
  /** Channel or conversation identifier. */
  channelId?: string;
  /** Current time in milliseconds (default: Date.now()). */
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// Cosine similarity & topic-shift detection
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two equal-length numeric vectors.
 * Returns a value in [-1, 1], where 1 = identical direction, -1 = opposite.
 * Returns 0 when either vector has zero magnitude or when lengths differ.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Compute cosine distance between two embeddings (1 − cosine_similarity).
 * Returns a value in [0, 2], where 0 = identical, 2 = opposite directions.
 */
export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Detect whether the topic has shifted significantly between two consecutive
 * message embeddings, based on a configurable cosine distance threshold.
 *
 * @param prev      - Embedding of the previous message.
 * @param next      - Embedding of the current message.
 * @param threshold - Cosine distance threshold (default: 0.4). Higher = less sensitive.
 * @returns true when the distance exceeds the threshold (topic shifted).
 */
export function detectTopicShift(
  prev: number[],
  next: number[],
  threshold: number = 0.4,
): boolean {
  if (prev.length === 0 || next.length === 0) return false;
  const distance = cosineDistance(prev, next);
  return distance > threshold;
}

// ---------------------------------------------------------------------------
// Entity extraction (rule-based, cheap)
// ---------------------------------------------------------------------------

/** Common English stop-words / sentence starters to exclude from capitalised-word extraction. */
const COMMON_STOP_WORDS = new Set([
  "The", "This", "That", "When", "What", "Which", "Where", "Who", "How",
  "And", "But", "For", "Now", "Then", "Are", "Was", "Has", "Have", "Had",
  "Not", "Can", "Does", "Did", "Will", "May", "Use", "Get", "Set", "Run",
  "All", "Any", "Each", "One", "Two", "New", "Old", "My", "Your", "Our",
  "His", "Her", "Its", "They", "Them", "With", "From", "Into", "Over",
  "Also", "Just", "More", "Most", "Very", "Some", "Such", "True", "False",
]);

/**
 * Extract entity candidates from a message using lightweight heuristics:
 *   - Known entities (case-insensitive substring match)
 *   - @mentions and #tags
 *   - IPv4 addresses
 *   - Capitalised words (PascalCase / ALL_CAPS, 3+ chars, not stop-words)
 *   - Quoted strings
 *
 * Returns distinct lowercase entity strings (max 10).
 */
export function extractEntitiesFromMessage(
  text: string,
  knownEntities: string[] = [],
): string[] {
  const candidates = new Set<string>();
  const lower = text.toLowerCase();

  // 1. Known entities (case-insensitive)
  for (const entity of knownEntities) {
    if (entity && entity.length >= 2 && lower.includes(entity.toLowerCase())) {
      candidates.add(entity.toLowerCase());
    }
  }

  // 2. @mentions
  for (const m of text.matchAll(/@([\w.-]+)/g)) {
    if (m[1] && m[1].length >= 2) candidates.add(m[1].toLowerCase());
  }

  // 3. #tags
  for (const m of text.matchAll(/#([\w-]+)/g)) {
    if (m[1] && m[1].length >= 2) candidates.add(m[1].toLowerCase());
  }

  // 4. IPv4 addresses
  for (const m of text.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)) {
    candidates.add(m[1]);
  }

  // 5. Capitalised words (PascalCase or ALL_CAPS, 3+ chars)
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9_]{2,}|[A-Z]{3,})\b/g)) {
    const word = m[1];
    if (!COMMON_STOP_WORDS.has(word)) {
      candidates.add(word.toLowerCase());
    }
  }

  // 6. Quoted strings (single or double), 3–40 chars
  for (const m of text.matchAll(/["']([^"']{3,40})["']/g)) {
    candidates.add(m[1].toLowerCase().trim());
  }

  return [...candidates].slice(0, 10);
}

// ---------------------------------------------------------------------------
// Temporal query generation
// ---------------------------------------------------------------------------

/**
 * Generate time-aware retrieval queries based on the current hour.
 * Returns up to 2 query strings.
 */
export function generateTemporalQueries(nowMs: number = Date.now()): string[] {
  const hour = new Date(nowMs).getHours();

  if (hour >= 6 && hour < 12) {
    // Morning: today's plan and pending items
    return [
      "action items and tasks for today",
      "pending decisions and upcoming deadlines",
    ];
  }
  if (hour >= 12 && hour < 18) {
    // Afternoon: recent progress and blockers
    return [
      "action items from last 48 hours",
      "upcoming deadlines and commitments",
    ];
  }
  // Evening/night: unresolved issues and follow-ups
  return [
    "unresolved issues and follow-ups",
    "action items from last 48 hours",
  ];
}

// ---------------------------------------------------------------------------
// Session-seen facts tracking
// ---------------------------------------------------------------------------

/**
 * Tracks which fact IDs have already been injected during this session.
 * Used to prevent re-injecting the same facts after a topic shift.
 */
export class SessionSeenFacts {
  private readonly _seen = new Set<string>();

  /** Mark a list of fact IDs as seen/injected. */
  markSeen(factIds: string[]): void {
    for (const id of factIds) {
      this._seen.add(id);
    }
  }

  /** Return true when a fact ID has already been injected this session. */
  hasBeenSeen(factId: string): boolean {
    return this._seen.has(factId);
  }

  /** Filter a list of fact IDs, returning only those not yet seen. */
  filterUnseen(factIds: string[]): string[] {
    return factIds.filter((id) => !this._seen.has(id));
  }

  /** Number of unique fact IDs seen so far. */
  get size(): number {
    return this._seen.size;
  }

  /** Clear all seen state (e.g. on session end or reset). */
  clear(): void {
    this._seen.clear();
  }
}

// ---------------------------------------------------------------------------
// Multi-query generation
// ---------------------------------------------------------------------------

/**
 * Generate 2–4 implicit ambient retrieval queries from conversation context.
 *
 * Query types:
 *   1. message   — Direct semantic match (current behaviour, always included).
 *   2. entity    — One query per distinct entity detected in the message.
 *   3. temporal  — Time-aware queries (action items, upcoming deadlines).
 *   4. context   — User/channel context when userId or channelId is available.
 *
 * Total queries are capped by `config.maxQueriesPerTrigger` (default 4).
 * When `config.multiQuery` is false, only the direct message query is returned.
 */
export function generateAmbientQueries(
  message: string,
  config: Pick<AmbientConfig, "maxQueriesPerTrigger" | "multiQuery">,
  context: AmbientContext = {},
  knownEntities: string[] = [],
): AmbientQuery[] {
  const queries: AmbientQuery[] = [];
  const trimmed = message.trim();

  // 1. Message-based query (always included — current behaviour)
  if (trimmed.length > 0) {
    queries.push({ text: trimmed, type: "message" });
  }

  if (!config.multiQuery) {
    return queries;
  }

  const max = Math.max(1, Math.min(4, config.maxQueriesPerTrigger ?? 4));

  // 2. Entity-based queries
  const entities = extractEntitiesFromMessage(trimmed, knownEntities);
  for (const entity of entities) {
    if (queries.length >= max) break;
    queries.push({ text: entity, type: "entity", entity });
  }

  // 3. Temporal context queries
  if (queries.length < max) {
    const nowMs = context.nowMs ?? Date.now();
    const temporal = generateTemporalQueries(nowMs);
    for (const t of temporal) {
      if (queries.length >= max) break;
      queries.push({ text: t, type: "temporal" });
    }
  }

  // 4. User/channel context query
  if (queries.length < max && (context.userId || context.channelId)) {
    const parts: string[] = [];
    if (context.userId) parts.push(`recent topics with ${context.userId}`);
    if (context.channelId) parts.push(`discussion in ${context.channelId}`);
    if (parts.length > 0) {
      queries.push({ text: parts.join(" and "), type: "context" });
    }
  }

  return queries.slice(0, max);
}

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

/**
 * Deduplicate results from multiple queries by factId.
 * First occurrence wins (earlier queries take priority).
 *
 * @param resultSets - Arrays of results from each query. Each element must have `factId`.
 * @returns Flat deduplicated list, preserving priority order.
 */
export function deduplicateByFactId<T extends { factId: string }>(
  resultSets: T[][],
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const results of resultSets) {
    for (const r of results) {
      if (!seen.has(r.factId)) {
        seen.add(r.factId);
        deduped.push(r);
      }
    }
  }
  return deduped;
}

/**
 * Deduplicate results from multiple query runs by an arbitrary ID field.
 * Generic helper compatible with SearchResult-like objects.
 *
 * @param resultSets - Arrays of results to deduplicate.
 * @param getId      - Function that extracts the unique ID from a result.
 * @returns Flat deduplicated list, first occurrence wins.
 */
export function deduplicateResultsById<T>(
  resultSets: T[][],
  getId: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const results of resultSets) {
    for (const r of results) {
      const id = getId(r);
      if (!seen.has(id)) {
        seen.add(id);
        deduped.push(r);
      }
    }
  }
  return deduped;
}
