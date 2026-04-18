/**
 * FTS search, entity/key lookup, ID prefix resolution, superseded-text cache (Issue #954).
 */
import type { SQLInputValue } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

import type { ScopeFilter, SearchResult } from "../../types/memory.js";
import { applyConsolidationRetrievalControls } from "../../utils/consolidation-controls.js";
import { INTERACTIVE_FTS_MAX_OR_TERMS } from "../../utils/constants.js";
import { computeDynamicSalience } from "../../utils/salience.js";
import type { SupersededTextsCache } from "./cache-manager.js";
import { refreshAccessedFacts } from "./crud.js";
import { buildFactsSearchFtsOrClause, fetchSupersededFactTextsLower } from "./fact-queries.js";
import {
  batchGetReinforcementEvents as batchGetReinforcementEventsHelper,
  computeDiversityFromEvents as computeDiversityFromEventsHelper,
} from "./reinforcement.js";
import { rowToMemoryEntry } from "./row-mapper.js";
import { scopeFilterClauseNamed, scopeFilterClausePositional } from "./scope-sql.js";

/**
 * Shared JS-side row filter for two-phase FTS search results.
 * Replicates the SQL WHERE clause semantics (expiry, temporal, tag, tier, scope)
 * using an allowlist for scope (matching `scopeFilterClauseNamed` behavior).
 */
function passesTwoPhaseFilter(
  row: Record<string, unknown>,
  opts: {
    nowSec: number;
    includeExpired: boolean;
    includeSuperseded: boolean;
    asOf: number | undefined;
    tag: string | undefined;
    tierFilter: "warm" | "all";
    scopeFilter: ScopeFilter | null | undefined;
  },
): boolean {
  if (!opts.includeExpired) {
    const ea = row.expires_at as number | null | undefined;
    if (ea != null && ea <= opts.nowSec) return false;
  }
  if (opts.asOf != null) {
    const vf = row.valid_from as number | null | undefined;
    const vu = row.valid_until as number | null | undefined;
    if (vf != null && vf > opts.asOf) return false;
    if (vu != null && vu <= opts.asOf) return false;
  } else if (!opts.includeSuperseded) {
    if (row.superseded_at != null) return false;
  }
  if (opts.tag?.trim()) {
    const t = `,${((row.tags as string) ?? "").toLowerCase()},`;
    if (!t.includes(`,${opts.tag.toLowerCase().trim()},`)) return false;
  }
  if (opts.tierFilter === "warm") {
    const tier = row.tier as string | null | undefined;
    if (tier != null && tier !== "warm" && tier !== "hot") return false;
  }
  const sf = opts.scopeFilter;
  if (sf && (sf.userId || sf.agentId || sf.sessionId)) {
    const s = row.scope as string | null | undefined;
    const st = row.scope_target as string | null | undefined;
    const matchesGlobal = s === "global" || s == null;
    const matchesUser = !!sf.userId && s === "user" && st === sf.userId;
    const matchesAgent = !!sf.agentId && s === "agent" && st === sf.agentId;
    const matchesSession = !!sf.sessionId && s === "session" && st === sf.sessionId;
    if (!matchesGlobal && !matchesUser && !matchesAgent && !matchesSession) return false;
  }
  return true;
}

export function searchFacts(
  db: DatabaseSync,
  query: string,
  limit = 5,
  options: {
    includeExpired?: boolean;
    tag?: string;
    includeSuperseded?: boolean;
    asOf?: number;
    tierFilter?: "warm" | "all";
    scopeFilter?: ScopeFilter | null;
    reinforcementBoost?: number;
    diversityWeight?: number;
    interactiveFtsFastPath?: boolean;
  } = {},
): SearchResult[] {
  const {
    includeExpired = false,
    tag,
    includeSuperseded = false,
    asOf,
    tierFilter = "warm",
    scopeFilter,
    reinforcementBoost = 0.1,
    diversityWeight = 1.0,
    interactiveFtsFastPath = false,
  } = options;

  const safeQuery = interactiveFtsFastPath
    ? buildFactsSearchFtsOrClause(query, {
        maxOrTerms: INTERACTIVE_FTS_MAX_OR_TERMS,
      })
    : buildFactsSearchFtsOrClause(query);
  if (!safeQuery) return [];

  const nowSec = Math.floor(Date.now() / 1000);
  const decayWindowSec = 7 * 24 * 3600;

  const filterOpts = { nowSec, includeExpired, includeSuperseded, asOf, tag, tierFilter, scopeFilter };

  // Both paths use two-phase search to avoid the node:sqlite FTS5↔facts
  // rowid JOIN pathology (~1000x slower than separate queries).
  // Phase 1: pure FTS query for candidate rowids (fast, ~5-18ms).
  // Phase 2: batch-fetch from facts + filter in JS.
  // A fixed FTS LIMIT can truncate after heavy post-filter rejection; expand
  // the candidate pool (doubling, capped) until we have enough rows or FTS
  // is exhausted — same semantics as SQL WHERE ... LIMIT on a single query.
  const needCandidates = limit * 2;
  let ftsLimit = Math.max(limit * 10, 100);
  const maxFtsLimit = Math.min(100_000, Math.max(limit * 500, 2000));
  const ftsStmt = db.prepare(
    `SELECT rowid, rank FROM facts_fts WHERE facts_fts MATCH @query ORDER BY rank LIMIT @limit`,
  );

  let rows: Array<Record<string, unknown>> = [];
  for (;;) {
    const ftsRows = ftsStmt.all({ "@query": safeQuery, "@limit": ftsLimit }) as Array<{
      rowid: number;
      rank: number;
    }>;
    if (ftsRows.length === 0) {
      rows = [];
      break;
    }

    const rowids = ftsRows.map((r) => r.rowid);
    const rankByRowid = new Map(ftsRows.map((r) => [r.rowid, r.rank]));
    const CHUNK_SIZE = 500;
    const allFullRows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < rowids.length; i += CHUNK_SIZE) {
      const chunk = rowids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      allFullRows.push(
        ...(db.prepare(`SELECT *, rowid AS _rowid FROM facts WHERE rowid IN (${placeholders})`).all(...chunk) as Array<
          Record<string, unknown>
        >),
      );
    }

    rows = [];
    for (const row of allFullRows) {
      if (!passesTwoPhaseFilter(row, filterOpts)) continue;
      const rid = row._rowid as number;
      const expiresAt = row.expires_at as number | null | undefined;
      let freshness: number;
      if (expiresAt == null) freshness = 1.0;
      else if (expiresAt <= nowSec) freshness = 0.0;
      else freshness = Math.min(1.0, (expiresAt - nowSec) / decayWindowSec);
      rows.push({
        ...row,
        fts_score: rankByRowid.get(rid) ?? 0,
        freshness,
      });
    }
    rows.sort((a, b) => (a.fts_score as number) - (b.fts_score as number));
    rows = rows.slice(0, needCandidates);

    const ftsExhausted = ftsRows.length < ftsLimit;
    const enoughFiltered = rows.length >= needCandidates;
    const atCap = ftsLimit >= maxFtsLimit;
    if (enoughFiltered || ftsExhausted || atCap) break;
    ftsLimit = Math.min(ftsLimit * 2, maxFtsLimit);
  }

  if (rows.length === 0) return [];

  const minScore = Math.min(...rows.map((r) => r.fts_score as number));
  const maxScore = Math.max(...rows.map((r) => r.fts_score as number));
  const range = maxScore - minScore || 1;

  const reinforcedFactIds = rows
    .filter((row) => ((row.reinforced_count as number) || 0) > 0)
    .map((row) => row.id as string);
  const eventsByFactId = batchGetReinforcementEventsHelper(db, reinforcedFactIds);

  const results = rows.map((row) => {
    const rawScore = 1 - ((row.fts_score as number) - minScore) / range;
    const bm25Score = Number.isNaN(rawScore) ? 0.8 : rawScore;
    const freshness = (row.freshness as number) || 1.0;
    const confidence = (row.confidence as number) || 1.0;
    const reinforcedCount = (row.reinforced_count as number) || 0;
    let reinforcement = 0;
    if (reinforcedCount > 0) {
      const events = eventsByFactId.get(row.id as string) || [];
      if (events.length === 0) {
        reinforcement = reinforcementBoost;
      } else {
        const diversityScore = computeDiversityFromEventsHelper(events);
        reinforcement = reinforcementBoost * (1 - diversityWeight + diversityWeight * diversityScore);
      }
    }
    const composite = Math.min(1.0, bm25Score * 0.6 + freshness * 0.25 + confidence * 0.15 + reinforcement);
    const entry = rowToMemoryEntry(row);
    const salienceScore = computeDynamicSalience(composite, entry);
    const controlledScore = applyConsolidationRetrievalControls(salienceScore, entry);

    return {
      entry,
      score: controlledScore,
      backend: "sqlite" as const,
    };
  });

  results.sort((a, b) => {
    const s = b.score - a.score;
    if (s !== 0) return s;
    const da = a.entry.sourceDate ?? a.entry.createdAt;
    const db_ = b.entry.sourceDate ?? b.entry.createdAt;
    return db_ - da;
  });
  const topResults = results.slice(0, limit);

  refreshAccessedFacts(
    db,
    topResults.map((r) => r.entry.id),
  );

  return topResults;
}

export function lookupFacts(
  db: DatabaseSync,
  entity: string,
  key?: string,
  tag?: string,
  options?: {
    includeSuperseded?: boolean;
    asOf?: number;
    scopeFilter?: ScopeFilter | null;
    limit?: number;
  },
): SearchResult[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const { includeSuperseded = false, asOf, scopeFilter } = options ?? {};
  const limit = typeof options?.limit === "number" && options.limit > 0 ? Math.floor(options.limit) : null;
  const temporalFilter =
    asOf != null
      ? " AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)"
      : includeSuperseded
        ? ""
        : " AND superseded_at IS NULL";
  const tagFilter = tag?.trim() ? " AND (',' || COALESCE(tags,'') || ',') LIKE ?" : "";
  const tagParam = tag?.trim() ? `%,${tag.toLowerCase().trim()},%` : null;
  const { clause: scopeClause, params: scopeParamsArr } = scopeFilterClausePositional(scopeFilter);
  const limitClause = limit ? " LIMIT ?" : "";

  const base = key
    ? `SELECT * FROM facts WHERE lower(entity) = lower(?) AND lower(key) = lower(?) AND (expires_at IS NULL OR expires_at > ?)${temporalFilter}${tagFilter}${scopeClause} ORDER BY confidence DESC, COALESCE(source_date, created_at) DESC${limitClause}`
    : `SELECT * FROM facts WHERE lower(entity) = lower(?) AND (expires_at IS NULL OR expires_at > ?)${temporalFilter}${tagFilter}${scopeClause} ORDER BY confidence DESC, COALESCE(source_date, created_at) DESC${limitClause}`;

  const params = key
    ? tagParam !== null
      ? asOf != null
        ? [...[entity, key, nowSec, asOf, asOf, tagParam], ...scopeParamsArr]
        : [...[entity, key, nowSec, tagParam], ...scopeParamsArr]
      : asOf != null
        ? [...[entity, key, nowSec, asOf, asOf], ...scopeParamsArr]
        : [...[entity, key, nowSec], ...scopeParamsArr]
    : tagParam !== null
      ? asOf != null
        ? [...[entity, nowSec, asOf, asOf, tagParam], ...scopeParamsArr]
        : [...[entity, nowSec, tagParam], ...scopeParamsArr]
      : asOf != null
        ? [...[entity, nowSec, asOf, asOf], ...scopeParamsArr]
        : [...[entity, nowSec], ...scopeParamsArr];
  const finalParams = limit ? [...params, limit] : params;
  const rows = db.prepare(base).all(...finalParams) as Array<Record<string, unknown>>;

  const results = rows.map((row) => {
    const entry = rowToMemoryEntry(row);
    const baseScore = (row.confidence as number) || 1.0;
    const salienceScore = computeDynamicSalience(baseScore, entry);
    const controlledScore = applyConsolidationRetrievalControls(salienceScore, entry);
    return {
      entry,
      score: controlledScore,
      backend: "sqlite" as const,
    };
  });

  refreshAccessedFacts(
    db,
    results.map((r) => r.entry.id),
  );

  return results;
}

export function findByIdPrefix(
  db: DatabaseSync,
  prefix: string,
): { id: string } | { ambiguous: true; count: number } | null {
  if (!prefix || prefix.length < 4) return null;
  if (!/^[0-9a-f]+$/i.test(prefix)) return null;
  let pattern = prefix.toLowerCase();
  if (prefix.length > 8 && !prefix.includes("-")) {
    const parts: string[] = [];
    parts.push(pattern.slice(0, 8));
    if (pattern.length > 8) parts.push(pattern.slice(8, 12));
    if (pattern.length > 12) parts.push(pattern.slice(12, 16));
    if (pattern.length > 16) parts.push(pattern.slice(16, 20));
    if (pattern.length > 20) parts.push(pattern.slice(20));
    pattern = parts.join("-");
  }
  const rows = db.prepare(`SELECT id FROM facts WHERE id LIKE ? || '%' LIMIT 3`).all(pattern) as Array<{
    id: string;
  }>;
  if (rows.length === 0) return null;
  if (rows.length === 1) return { id: rows[0].id };
  return { ambiguous: true, count: rows.length >= 3 ? 3 : rows.length };
}

export function getSupersededTextsSnapshot(cache: SupersededTextsCache, db: DatabaseSync): Set<string> {
  const now = Date.now();
  return cache.getSnapshot(now, () => fetchSupersededFactTextsLower(db));
}

/**
 * Retrieve candidate fact IDs using only structured (SQL) filters.
 * Used by the constrained-recall mode to narrow the candidate set
 * before semantic/vector ranking (Issue #1026 filter → rank → hydrate pattern).
 *
 * Returns up to `limit` fact IDs matching all provided filters.
 * When no filters are set, returns an empty array (caller should fall back
 * to unconstrained retrieval).
 */
export interface ConstrainedSearchFilters {
  /** Match facts with this exact entity name. */
  entity?: string | null;
  /** Match facts with this tag (SQL LIKE %tag%). */
  tag?: string | null;
  /** Match facts with this category. */
  category?: string | null;
  /** Match facts with this exact source value. */
  source?: string | null;
  /** Match facts with this scope value. */
  scope?: string | null;
  /** Match facts with this scope target. */
  scopeTarget?: string | null;
  /** Include only facts with this verification tier (e.g. 'critical'). */
  verificationTier?: string | null;
  /** Include only facts created/valid from this Unix timestamp onward. `0` is treated as active. */
  validFromSec?: number | null;
  /** Include only facts created/valid before this Unix timestamp. `0` is treated as active. */
  validUntilSec?: number | null;
  /** Include only facts with this tier (hot/warm/cold). */
  tier?: string | null;
  /** Limit to a specific source/session. Wildcards are treated literally. */
  sourceSession?: string | null;
}

/** @deprecated Import from search.ts instead to avoid type divergence. */
export type { ConstrainedSearchFilters as ConstrainedSearchFiltersFromSearch };

/**
 * Check if any constrained filter is active.
 * Extracted helper to avoid duplicating filter-emptiness logic (Issue #1026).
 */
export function hasActiveFilters(filters: ConstrainedSearchFilters): boolean {
  return !!(
    filters.entity ||
    filters.tag ||
    filters.category ||
    filters.source ||
    filters.scope ||
    filters.scopeTarget ||
    filters.verificationTier ||
    filters.validFromSec != null ||
    filters.validUntilSec != null ||
    filters.tier ||
    filters.sourceSession
  );
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function getCandidateIdsByStructuredFilters(
  db: DatabaseSync,
  filters: ConstrainedSearchFilters,
  options: { limit?: number; nowSec?: number } | number = 1000,
): string[] {
  const limit = typeof options === "number" ? options : (options.limit ?? 1000);
  const nowSec =
    typeof options === "number" ? Math.floor(Date.now() / 1000) : (options.nowSec ?? Math.floor(Date.now() / 1000));
  if (!hasActiveFilters(filters)) {
    return [];
  }

  const params: (string | number | null)[] = [];
  const conditions: string[] = ["superseded_at IS NULL"];

  if (filters.entity) {
    conditions.push("lower(entity) = lower(?)");
    params.push(filters.entity);
  }
  if (filters.category) {
    conditions.push("category = ?");
    params.push(filters.category);
  }
  if (filters.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }
  if (filters.scope) {
    conditions.push("scope = ?");
    params.push(filters.scope);
  }
  if (filters.scopeTarget) {
    conditions.push("scope_target = ?");
    params.push(filters.scopeTarget);
  }
  if (filters.tier) {
    conditions.push("tier = ?");
    params.push(filters.tier);
  }
  if (filters.tag) {
    conditions.push("(',' || COALESCE(tags, '') || ',') LIKE ?");
    params.push(`%,${filters.tag.toLowerCase().trim()},%`);
  }
  if (filters.validFromSec != null) {
    conditions.push("valid_from >= ?");
    params.push(filters.validFromSec);
  }
  if (filters.validUntilSec != null) {
    conditions.push("(valid_until IS NULL OR valid_until > ?)");
    params.push(filters.validUntilSec);
  }
  if (filters.sourceSession) {
    conditions.push("source_sessions LIKE ? ESCAPE '\\'");
    params.push(`%${escapeSqlLike(filters.sourceSession)}%`);
  }

  // Handle verified_facts JOIN for verificationTier
  if (filters.verificationTier) {
    conditions.push(
      `id IN (SELECT fact_id FROM verified_facts WHERE tier = ? AND (next_verification IS NULL OR next_verification > ?))`,
    );
    params.push(filters.verificationTier, nowSec);
  }

  const sql = `SELECT id FROM facts WHERE ${conditions.join(" AND ")} ORDER BY confidence DESC, COALESCE(source_date, created_at) DESC LIMIT ?`;
  const finalParams = [...params, limit];

  try {
    const rows = db.prepare(sql).all(...finalParams) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch (err) {
    // Graceful degradation — malformed filter never blocks retrieval
    return [];
  }
}
