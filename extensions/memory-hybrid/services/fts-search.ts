/**
 * FTS5 full-text search service (Issue #151).
 *
 * Provides a standalone search function over the facts_fts virtual table,
 * plus a backfill helper to rebuild the FTS index from existing facts.
 *
 * This is intentionally decoupled from FactsDB so that Issue #152 (RRF pipeline)
 * can call it as an independent retrieval strategy alongside vector search.
 */

import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FtsSearchResult {
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
const FTS_COLUMNS = ["text", "category", "entity", "tags", "key", "value"] as const;

/**
 * Escape a raw user string so it can be used as a quoted FTS5 phrase.
 * Strips characters that would break the MATCH expression or allow SQL injection.
 */
function escapeForFts5(raw: string): string {
  return raw
    .replace(/['"*();]/g, " ")     // FTS5 special chars + semicolons
    .replace(/--/g, " ")           // SQL line-comment marker
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
 */
export function buildFts5Query(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // If the user has explicitly used FTS5 operators, attempt to pass through
  // with only dangerous characters stripped.
  const hasOperators = /\b(AND|OR|NOT)\b/.test(trimmed) || trimmed.includes("*");
  if (hasOperators) {
    // Light sanitise: remove quotes, parens, semicolons, and SQL comment markers.
    const sanitized = trimmed
      .replace(/['"]/g, "")
      .replace(/[();]/g, "")
      .replace(/--/g, "")
      .trim();

    // Verify there is at least one real token beyond operators/wildcards.
    // If only operators remain (e.g. "* AND OR NOT"), fall through to keyword mode.
    const realTokens = sanitized
      .split(/\s+/)
      .filter((t) => t && !/^(AND|OR|NOT|\*)$/.test(t));
    if (realTokens.length > 0) return sanitized;
    // Fall through to keyword OR mode with the original sanitised value.
  }

  // Phrase search: user wrapped their query in "...".
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
    const inner = escapeForFts5(trimmed.slice(1, -1));
    if (!inner) return null;
    return `"${inner}"`;
  }

  // Default: keyword OR search.
  const tokens = escapeForFts5(trimmed)
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

// ---------------------------------------------------------------------------
// searchFts
// ---------------------------------------------------------------------------

/**
 * Search the FTS5 index for facts matching `query`.
 *
 * @param db      - A better-sqlite3 `Database` instance.
 * @param query   - Raw search string. May contain FTS5 operators (AND/OR/NOT/*),
 *                  phrase quotes, or plain keywords.
 * @param options - Optional filters and limits.
 * @returns Ranked list of matching facts (best first).
 */
export function searchFts(
  db: Database.Database,
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
     * Valid values: "text" | "category" | "entity" | "tags" | "key" | "value"
     * When omitted, all columns are searched.
     */
    columns?: Array<(typeof FTS_COLUMNS)[number]>;
    /** Include superseded facts (default: false). */
    includeSuperseded?: boolean;
    /** Point-in-time query: only facts valid at this epoch second. */
    asOf?: number;
    /** 'warm' = only warm tier (default), 'all' = warm + cold. */
    tierFilter?: "warm" | "all";
    /** Scope filter — only return global + matching user/agent/session. */
    scopeFilter?: { userId?: string | null; agentId?: string | null; sessionId?: string | null } | null;
  } = {},
): FtsSearchResult[] {
  const { limit = 20, entityFilter, tagFilter, columns, includeSuperseded = false, asOf, tierFilter = "warm", scopeFilter } = options;

  const ftsQuery = buildFts5Query(query);
  if (!ftsQuery) return [];

  // Prefix query with column filter if requested.
  const matchExpr =
    columns && columns.length > 0
      ? `{ ${columns.join(" ")} } : ( ${ftsQuery} )`
      : ftsQuery;

  // Build WHERE clauses for structured filters.
  const extraClauses: string[] = [];
  const params: Record<string, unknown> = { query: matchExpr, limit };
  const nowSec = Math.floor(Date.now() / 1000);
  params.now = nowSec;

  if (entityFilter && entityFilter.trim()) {
    extraClauses.push("AND LOWER(f.entity) = LOWER(@entityFilter)");
    params.entityFilter = entityFilter.trim();
  }
  if (tagFilter && tagFilter.trim()) {
    extraClauses.push("AND (',' || COALESCE(f.tags,'') || ',') LIKE @tagPattern");
    params.tagPattern = `%,${tagFilter.toLowerCase().trim()},%`;
  }

  // Expiry filter (always exclude expired facts)
  extraClauses.push("AND (f.expires_at IS NULL OR f.expires_at > @now)");

  // Temporal/superseded filter
  if (asOf != null) {
    extraClauses.push("AND f.valid_from <= @asOf AND (f.valid_until IS NULL OR f.valid_until > @asOf)");
    params.asOf = asOf;
  } else if (!includeSuperseded) {
    extraClauses.push("AND f.superseded_at IS NULL");
  }

  // Tier filter
  if (tierFilter === "warm") {
    extraClauses.push("AND (f.tier IS NULL OR f.tier = 'warm' OR f.tier = 'hot')");
  }

  // Scope filter
  if (scopeFilter && (scopeFilter.userId || scopeFilter.agentId || scopeFilter.sessionId)) {
    const scopeParts: string[] = ["(", "f.scope = 'global'"];
    if (scopeFilter.userId) {
      scopeParts.push("OR (f.scope = 'user' AND f.scope_target = @scopeUserId)");
      params.scopeUserId = scopeFilter.userId;
    }
    if (scopeFilter.agentId) {
      scopeParts.push("OR (f.scope = 'agent' AND f.scope_target = @scopeAgentId)");
      params.scopeAgentId = scopeFilter.agentId;
    }
    if (scopeFilter.sessionId) {
      scopeParts.push("OR (f.scope = 'session' AND f.scope_target = @scopeSessionId)");
      params.scopeSessionId = scopeFilter.sessionId;
    }
    scopeParts.push(")");
    extraClauses.push("AND " + scopeParts.join(" "));
  }

  const rows = db
    .prepare(
      `SELECT
         f.id             AS factId,
         f.text,
         f.entity,
         fts.rank,
         snippet(facts_fts, 0, '[', ']', '...', 16) AS snippet,
         (
           CASE WHEN bm25(facts_fts, 1, 0, 0, 0, 0, 0) < 0 THEN 'text ' ELSE '' END ||
           CASE WHEN bm25(facts_fts, 0, 1, 0, 0, 0, 0) < 0 THEN 'category ' ELSE '' END ||
           CASE WHEN bm25(facts_fts, 0, 0, 1, 0, 0, 0) < 0 THEN 'entity ' ELSE '' END ||
           CASE WHEN bm25(facts_fts, 0, 0, 0, 1, 0, 0) < 0 THEN 'tags ' ELSE '' END ||
           CASE WHEN bm25(facts_fts, 0, 0, 0, 0, 1, 0) < 0 THEN 'key ' ELSE '' END ||
           CASE WHEN bm25(facts_fts, 0, 0, 0, 0, 0, 1) < 0 THEN 'value' ELSE '' END
         ) AS matchInfo
       FROM facts_fts fts
       JOIN facts f ON f.rowid = fts.rowid
       WHERE facts_fts MATCH @query
         ${extraClauses.join(" ")}
       ORDER BY fts.rank
       LIMIT @limit`,
    )
    .all(params) as Array<{
    factId: string;
    text: string;
    entity: string | null;
    rank: number;
    snippet: string | null;
    matchInfo: string | null;
  }>;

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
export function rebuildFtsIndex(db: Database.Database): number {
  // Delete whatever is currently in the FTS index.
  db.exec(`DELETE FROM facts_fts`);

  // Re-insert all facts.
  db.exec(`
    INSERT INTO facts_fts(rowid, text, category, entity, tags, key, value)
    SELECT rowid, text, category, entity, tags, key, value FROM facts
  `);

  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM facts`).get() as { cnt: number };
  return row.cnt;
}
