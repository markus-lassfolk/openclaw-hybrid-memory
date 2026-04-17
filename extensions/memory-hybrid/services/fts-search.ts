/**
 * FTS5 full-text search service (Issue #151).
 *
 * Provides a standalone search function over the facts_fts virtual table,
 * plus a backfill helper to rebuild the FTS index from existing facts.
 *
 * This is intentionally decoupled from FactsDB so that Issue #152 (RRF pipeline)
 * can call it as an independent retrieval strategy alongside vector search.
 */

import type { DatabaseSync } from "node:sqlite";
import { pluginLogger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FtsSearchResult {
	/** UUID of the matching fact in the facts table. */
	factId: string;
	text: string;
	entity?: string;
	/** FTS5 rank score (negative — closer to 0 is better). */
	rank: number;
	/** Highlighted excerpt produced by FTS5 snippet(). */
	snippet?: string;
	/** Comma-separated list of columns that contained a match. */
	matchInfo: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Indexed columns in facts_fts (in order). Used for snippet() column index. */
const FTS_COLUMNS = [
	"text",
	"category",
	"entity",
	"tags",
	"why",
	"key",
	"value",
] as const;

/**
 * Escape a raw user string so it can be used as a quoted FTS5 phrase.
 * Strips characters that would break the MATCH expression or allow SQL injection.
 */
function escapeForFts5(raw: string): string {
	return raw
		.replace(/\u0000/g, " ") // SQLite FTS5 terminates strings at NUL bytes
		.replace(/['"*();]/g, " ") // FTS5 special chars + semicolons
		.replace(/--/g, " ") // SQL line-comment marker
		.replace(/\b(AND|OR|NOT)\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Build a safe FTS5 MATCH query from a raw user string.
 *
 * - If the caller wraps the string in quotes themselves (phrase query), pass
 *   it through verbatim after light sanitisation.
 * - Otherwise split into tokens, wrap each in double quotes, and join with OR
 *   so that partial matches still return results.
 * - Advanced FTS5 syntax (AND / OR / NOT / prefix *) is passed through
 *   verbatim when the raw string already contains those operators.
 *
 * Note: `facts_fts` uses `tokenize='porter unicode61'`, so indexed terms are stemmed.
 * Quoted tokens here are not re-stemmed by this builder; very short or inflected
 * queries may miss stemmed index terms (#898). Prefer user vocabulary that matches
 * stored text or extend with prefix queries where appropriate.
 */
export function buildFts5Query(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	// If the user has explicitly used FTS5 operators, attempt to pass through
	// with only dangerous characters stripped.
	const operatorTokens = trimmed.split(/\s+/);
	const hasOperators =
		operatorTokens.some((t) => /^(AND|OR|NOT)$/i.test(t)) ||
		operatorTokens.some((t) => /^[a-zA-Z0-9_]+\*$/.test(t));
	if (hasOperators) {
		const sanitizedTokens: string[] = [];
		for (const token of operatorTokens) {
			if (/^(AND|OR|NOT)$/i.test(token)) {
				sanitizedTokens.push(token.toUpperCase());
				continue;
			}
			if (/^[a-zA-Z0-9_]+\*$/.test(token)) {
				sanitizedTokens.push(token);
				continue;
			}
			// Allow hyphens / dots in terms (e.g. api-key) so AND/OR queries are not stripped to invalid FTS (issue #850).
			if (/^[a-zA-Z0-9_.-]+$/.test(token)) {
				sanitizedTokens.push(`"${token}"`);
			}
		}

		// Verify there is at least one real term beyond operators.
		const realTokens = sanitizedTokens.filter((t) => !/^(AND|OR|NOT)$/.test(t));
		if (realTokens.length > 0) return sanitizedTokens.join(" ");
		// Fall through to keyword OR mode with the original sanitised value.
	}

	// Phrase search: user wrapped their query in "...".
	if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
		const inner = escapeForFts5(trimmed.slice(1, -1));
		if (!inner) return null;
		return `"${inner}"`;
	}

	// Default: keyword OR search (quoted term OR prefix) — aligns with porter-stemmed index (#898).
	const tokens = escapeForFts5(trimmed)
		.split(/\s+/)
		.filter((t) => t.length > 0);
	if (tokens.length === 0) return null;
	return tokens
		.map((t) => {
			if (/^[a-zA-Z0-9_]+$/.test(t) && t.length >= 3) {
				return `( "${t}" OR ${t}* )`;
			}
			return `"${t}"`;
		})
		.join(" OR ");
}

// ---------------------------------------------------------------------------
// searchFts
// ---------------------------------------------------------------------------

/**
 * Search the FTS5 index for facts matching `query`.
 *
 * @param db      - A node:sqlite `DatabaseSync` instance.
 * @param query   - Raw search string. May contain FTS5 operators (AND/OR/NOT/*),
 *                  phrase quotes, or plain keywords.
 * @param options - Optional filters and limits.
 * @returns Ranked list of matching facts (best first).
 */
export function searchFts(
	db: DatabaseSync,
	query: string,
	options: {
		/** Maximum results to return (default: 20). */
		limit?: number;
		/** Filter by entity (case-insensitive exact match). */
		entityFilter?: string;
		/** Filter by tag (must appear in tags column). */
		tagFilter?: string;
		/**
		 * Restrict the FTS match to specific columns.
		 * Valid values: "text" | "category" | "entity" | "tags" | "why" | "key" | "value"
		 * When omitted, all columns are searched.
		 */
		columns?: Array<(typeof FTS_COLUMNS)[number]>;
		/**
		 * When false (default), superseded and expired facts are excluded from results.
		 * Pass true only when explicitly querying historical/superseded content.
		 */
		includeSuperseded?: boolean;
		/**
		 * Point-in-time filter (epoch seconds). When provided, superseded/expired
		 * filtering uses this timestamp instead of the current wall-clock time,
		 * ensuring consistent results for historical queries.
		 */
		asOf?: number;
	} = {},
): FtsSearchResult[] {
	const {
		limit = 20,
		entityFilter,
		tagFilter,
		columns,
		includeSuperseded = false,
		asOf,
	} = options;

	const ftsQuery = buildFts5Query(query);
	if (!ftsQuery) return [];

	const validColumns = columns?.filter((c) => FTS_COLUMNS.includes(c)) ?? [];
	// Prefix query with column filter if requested.
	const matchExpr =
		validColumns.length > 0
			? `{ ${validColumns.join(" ")} } : ( ${ftsQuery} )`
			: ftsQuery;

	let rows: Array<{
		factId: string;
		text: string;
		entity: string | null;
		rank: number;
		snippet: string | null;
		matchInfo: string | null;
	}>;
	try {
		// Two-phase to avoid node:sqlite FTS5↔facts full-table JOIN pathology:
		// 1. Pure FTS query to get candidate rowids (fast, ~5ms)
		// 2. Batch-fetch from facts to apply structured filters
		// 3. Small targeted JOIN on surviving rowids for snippet/bm25 columns
		// Expand FTS LIMIT when post-filters reject most candidates (bounded cap).
		let ftsLimit = Math.max(limit * 10, 100);
		const maxFtsLimit = Math.min(100_000, Math.max(limit * 500, 2000));
		const ftsStmt = db.prepare(
			`SELECT rowid, rank FROM facts_fts WHERE facts_fts MATCH @query ORDER BY rank LIMIT @limit`,
		);

		let ftsRows: Array<{ rowid: number; rank: number }> = [];
		let filteredFacts: Array<{
			id: string;
			text: string;
			entity: string | null;
			_rowid: number;
		}> = [];

		for (;;) {
			ftsRows = ftsStmt.all({
				"@query": matchExpr,
				"@limit": ftsLimit,
			}) as Array<{
				rowid: number;
				rank: number;
			}>;
			if (ftsRows.length === 0) return [];

			const candidateRowids = ftsRows.map((r) => r.rowid);
			// Chunk to respect SQLite's bound-parameter limit (commonly 999/32766).
			const CHUNK_SIZE = 500;
			const allFiltered: Array<{
				id: string;
				text: string;
				entity: string | null;
				_rowid: number;
			}> = [];
			const nowSec = asOf ?? Math.floor(Date.now() / 1000);
			for (let i = 0; i < candidateRowids.length; i += CHUNK_SIZE) {
				const chunk = candidateRowids.slice(i, i + CHUNK_SIZE);
				const ph = chunk.map(() => "?").join(",");
				const filterParams: Array<string | number> = [...chunk];
				let filterSql = `SELECT id, text, entity, rowid AS _rowid FROM facts WHERE rowid IN (${ph})`;
				if (!includeSuperseded) {
					filterSql +=
						" AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
					filterParams.push(nowSec);
				}
				if (entityFilter?.trim()) {
					filterSql += " AND LOWER(entity) = LOWER(?)";
					filterParams.push(entityFilter.trim());
				}
				if (tagFilter?.trim()) {
					filterSql += " AND (',' || COALESCE(tags,'') || ',') LIKE ?";
					filterParams.push(`%,${tagFilter.toLowerCase().trim()},%`);
				}
				allFiltered.push(
					...(db.prepare(filterSql).all(...filterParams) as Array<{
						id: string;
						text: string;
						entity: string | null;
						_rowid: number;
					}>),
				);
			}
			filteredFacts = allFiltered;

			const ftsExhausted = ftsRows.length < ftsLimit;
			const enough = filteredFacts.length >= limit;
			const atCap = ftsLimit >= maxFtsLimit;
			if (enough || ftsExhausted || atCap) break;
			ftsLimit = Math.min(ftsLimit * 2, maxFtsLimit);
		}

		if (filteredFacts.length === 0) return [];

		// Phase 3: small JOIN for snippet/matchInfo on surviving rowids only
		const survivingRowids = filteredFacts.map((r) => r._rowid);
		const rankByRowid = new Map(ftsRows.map((r) => [r.rowid, r.rank]));
		const factById = new Map(filteredFacts.map((r) => [r._rowid, r]));

		const SNIPPET_CHUNK_SIZE = 500;
		const allSnippetRows: Array<{
			_rowid: number;
			snippet: string | null;
			matchInfo: string | null;
		}> = [];
		for (let i = 0; i < survivingRowids.length; i += SNIPPET_CHUNK_SIZE) {
			const chunk = survivingRowids.slice(i, i + SNIPPET_CHUNK_SIZE);
			const ph2 = chunk.map(() => "?").join(",");
			const snippetParams: Array<string | number> = [
				...chunk,
				matchExpr,
				limit,
			];
			allSnippetRows.push(
				...(db
					.prepare(
						`SELECT
           fts.rowid AS _rowid,
           snippet(facts_fts, 0, '[', ']', '...', 16) AS snippet,
           (
             CASE WHEN bm25(facts_fts, 1, 0, 0, 0, 0, 0, 0) < 0 THEN 'text ' ELSE '' END ||
             CASE WHEN bm25(facts_fts, 0, 1, 0, 0, 0, 0, 0) < 0 THEN 'category ' ELSE '' END ||
             CASE WHEN bm25(facts_fts, 0, 0, 1, 0, 0, 0, 0) < 0 THEN 'entity ' ELSE '' END ||
             CASE WHEN bm25(facts_fts, 0, 0, 0, 1, 0, 0, 0) < 0 THEN 'tags ' ELSE '' END ||
             CASE WHEN bm25(facts_fts, 0, 0, 0, 0, 1, 0, 0) < 0 THEN 'why ' ELSE '' END ||
             CASE WHEN bm25(facts_fts, 0, 0, 0, 0, 0, 1, 0) < 0 THEN 'key ' ELSE '' END ||
             CASE WHEN bm25(facts_fts, 0, 0, 0, 0, 0, 0, 1) < 0 THEN 'value' ELSE '' END
           ) AS matchInfo
         FROM facts_fts fts
         WHERE fts.rowid IN (${ph2})
           AND facts_fts MATCH ?
         ORDER BY fts.rank
         LIMIT ?`,
					)
					.all(...snippetParams) as Array<{
					_rowid: number;
					snippet: string | null;
					matchInfo: string | null;
				}>),
			);
		}

		const snippetByRowid = new Map(allSnippetRows.map((r) => [r._rowid, r]));
		rows = survivingRowids
			.filter((rid) => snippetByRowid.has(rid))
			.sort((a, b) => (rankByRowid.get(a) ?? 0) - (rankByRowid.get(b) ?? 0))
			.slice(0, limit)
			.map((rid) => {
				const fact = factById.get(rid)!;
				const snip = snippetByRowid.get(rid);
				return {
					factId: fact.id,
					text: fact.text,
					entity: fact.entity,
					rank: rankByRowid.get(rid) ?? 0,
					snippet: snip?.snippet ?? null,
					matchInfo: snip?.matchInfo ?? null,
				};
			});
	} catch (err) {
		pluginLogger.warn(
			`memory-hybrid: FTS query failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}

	return rows.map((r) => ({
		factId: r.factId,
		text: r.text,
		entity: r.entity ?? undefined,
		rank: r.rank,
		snippet: r.snippet ?? undefined,
		matchInfo: (r.matchInfo ?? "").trim(),
	}));
}

// ---------------------------------------------------------------------------
// rebuildFtsIndex
// ---------------------------------------------------------------------------

/**
 * Repopulate the FTS5 index from scratch using existing facts.
 *
 * Safe to call on an empty index (no-op if already fully populated) or after
 * the facts_fts schema was recreated (e.g., during the tags migration).
 *
 * Called automatically by FactsDB on migration; exposed here so that callers
 * that hold a raw `Database` can also trigger a rebuild (e.g., CLI tools,
 * database repair scripts, tests).
 *
 * @returns Number of facts indexed.
 */
export function rebuildFtsIndex(db: DatabaseSync): number {
	// Delete whatever is currently in the FTS index.
	db.exec("DELETE FROM facts_fts");

	// Re-insert all facts.
	db.exec(`
    INSERT INTO facts_fts(rowid, text, category, entity, tags, why, key, value)
    SELECT rowid, text, category, entity, tags, why, key, value FROM facts
  `);

	const row = db.prepare("SELECT COUNT(*) AS cnt FROM facts").get() as {
		cnt: number;
	};
	return row.cnt;
}
