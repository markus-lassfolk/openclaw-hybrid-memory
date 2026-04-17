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

import type { IssueStore } from "../backends/issue-store.js";
import type { AmbientConfig } from "../config.js";
import type { Issue } from "../types/issue-types.js";

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

interface AmbientContext {
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
 * This is the general-purpose version that handles arbitrary (non-normalized) vectors
 * by computing magnitudes and normalizing internally.
 *
 * Returns a value in [-1, 1], where 1 = identical direction, -1 = opposite.
 * Returns 0 when either vector has zero magnitude or when lengths differ.
 *
 * NOTE: For pre-normalized vectors, reflection.ts has an optimized version
 * that skips magnitude computation (just computes dot product).
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
	threshold = 0.4,
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
	"the",
	"this",
	"that",
	"when",
	"what",
	"which",
	"where",
	"who",
	"how",
	"and",
	"but",
	"for",
	"now",
	"then",
	"are",
	"was",
	"has",
	"have",
	"had",
	"not",
	"can",
	"does",
	"did",
	"will",
	"may",
	"use",
	"get",
	"set",
	"run",
	"all",
	"any",
	"each",
	"one",
	"two",
	"new",
	"old",
	"my",
	"your",
	"our",
	"his",
	"her",
	"its",
	"they",
	"them",
	"with",
	"from",
	"into",
	"over",
	"also",
	"just",
	"more",
	"most",
	"very",
	"some",
	"such",
	"true",
	"false",
]);

const ENTITY_PREFIX_LEN = 3;
const entityCache = new Map<
	string,
	{ prefixMap: Map<string, string[]>; timestamp: number }
>();
const ENTITY_CACHE_TTL_MS = 5 * 60 * 1000;
/** Issue #463: Maximum entity cache entries to prevent unbounded growth. */
const ENTITY_CACHE_MAX_SIZE = 50;

function getEntityPrefixMap(knownEntities: string[]): Map<string, string[]> {
	const cacheKey = knownEntities.join("\x00");
	const now = Date.now();
	const cached = entityCache.get(cacheKey);
	if (cached && now - cached.timestamp < ENTITY_CACHE_TTL_MS) {
		return cached.prefixMap;
	}
	const prefixMap = new Map<string, string[]>();
	const seen = new Set<string>();
	for (const entity of knownEntities) {
		const lower = entity.toLowerCase().trim();
		if (lower.length < 2 || seen.has(lower)) continue;
		seen.add(lower);
		const firstWordMatch = lower.match(/^[a-z0-9][a-z0-9_-]*/);
		if (firstWordMatch) {
			const word = firstWordMatch[0];
			for (
				let len = Math.min(word.length, ENTITY_PREFIX_LEN);
				len >= 2;
				len--
			) {
				const prefix = word.slice(0, len);
				const list = prefixMap.get(prefix);
				if (list) list.push(lower);
				else prefixMap.set(prefix, [lower]);
			}
		} else {
			const prefix = lower.slice(0, ENTITY_PREFIX_LEN);
			const list = prefixMap.get(prefix);
			if (list) list.push(lower);
			else prefixMap.set(prefix, [lower]);
		}
	}
	entityCache.set(cacheKey, { prefixMap, timestamp: now });
	// Evict stale entries to prevent unbounded growth when entity lists change over time.
	for (const [k, v] of entityCache) {
		if (now - v.timestamp >= ENTITY_CACHE_TTL_MS) entityCache.delete(k);
	}
	// Issue #463: Hard cap on cache size to prevent unbounded growth
	if (entityCache.size > ENTITY_CACHE_MAX_SIZE) {
		const excess = entityCache.size - ENTITY_CACHE_MAX_SIZE;
		const keys = entityCache.keys();
		for (let i = 0; i < excess; i++) {
			const { value } = keys.next();
			if (value) entityCache.delete(value);
		}
	}
	return prefixMap;
}

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
	if (knownEntities.length > 0) {
		const prefixMap = getEntityPrefixMap(knownEntities);
		const seenPrefixes = new Set<string>();
		for (const m of lower.matchAll(/\b[a-z0-9][a-z0-9_-]{1,}\b/g)) {
			const token = m[0];
			for (
				let len = Math.min(token.length, ENTITY_PREFIX_LEN);
				len >= 2;
				len--
			) {
				seenPrefixes.add(token.slice(0, len));
			}
		}
		for (const prefix of seenPrefixes) {
			const list = prefixMap.get(prefix);
			if (!list) continue;
			for (const entity of list) {
				if (lower.includes(entity)) candidates.add(entity);
			}
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
		if (!COMMON_STOP_WORDS.has(word.toLowerCase())) {
			candidates.add(word.toLowerCase());
		}
	}

	// 6. Quoted strings (single or double), 3–40 chars
	for (const m of text.matchAll(/["']([^"']{3,40})["']/g)) {
		const val = m[1].toLowerCase().trim();
		if (val.length > 0) candidates.add(val);
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

// ---------------------------------------------------------------------------
// Issue-aware ambient context (Issue #137)
// ---------------------------------------------------------------------------

/** Keywords that suggest the conversation involves an active problem or error. */
const ERROR_KEYWORDS = [
	"error",
	"failed",
	"crash",
	"timeout",
	"broken",
	"not working",
	"exception",
	"bug",
	"issue",
	"problem",
	"fault",
	"failure",
	"down",
];

/**
 * Detect whether a message text contains error-like keywords that suggest
 * the user is dealing with an active problem.
 */
function hasErrorKeywords(text: string): boolean {
	const lower = text.toLowerCase();
	return ERROR_KEYWORDS.some((kw) => lower.includes(kw));
}

interface IssueAmbientResult {
	/** Open issues that may be relevant to the current message. */
	openIssues: Issue[];
	/** Resolved/verified issues that may contain relevant resolution context. */
	resolvedIssues: Issue[];
}

/**
 * Search the issue store for issues relevant to the current conversation message.
 * Called when the message contains error-like keywords.
 *
 * - Searches open issues so the user knows about known active problems.
 * - Searches resolved/verified issues to surface past resolutions that may help.
 *
 * Returns at most 3 open + 3 resolved issues.
 */
export function searchAmbientIssues(
	message: string,
	issueStore: IssueStore,
): IssueAmbientResult {
	if (!hasErrorKeywords(message)) {
		return { openIssues: [], resolvedIssues: [] };
	}

	const lower = message.toLowerCase();
	const keywords: string[] = [];
	for (const kw of ERROR_KEYWORDS) {
		if (lower.includes(kw)) {
			keywords.push(kw);
		}
	}
	const words = message.match(/\b[a-zA-Z0-9_-]{3,}\b/g) || [];
	for (const word of words.slice(0, 5)) {
		if (!ERROR_KEYWORDS.includes(word.toLowerCase())) {
			keywords.push(word);
		}
	}

	const allMatches = new Map<string, Issue>();
	for (const keyword of keywords.slice(0, 3)) {
		const matches = issueStore.search(keyword);
		for (const match of matches) {
			allMatches.set(match.id, match);
		}
	}

	const matchList = Array.from(allMatches.values());
	const openIssues = matchList
		.filter(
			(i) =>
				i.status === "open" ||
				i.status === "diagnosed" ||
				i.status === "fix-attempted",
		)
		.slice(0, 3);

	const resolvedIssues = matchList
		.filter((i) => i.status === "resolved" || i.status === "verified")
		.slice(0, 3);

	return { openIssues, resolvedIssues };
}
