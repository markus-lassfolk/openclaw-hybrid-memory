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
  const expiryFilter = includeExpired ? "" : "AND (f.expires_at IS NULL OR f.expires_at > @now)";
  const temporalFilter =
    asOf != null
      ? "AND f.valid_from <= @asOf AND (f.valid_until IS NULL OR f.valid_until > @asOf)"
      : includeSuperseded
        ? ""
        : "AND f.superseded_at IS NULL";
  const tagFilter = tag?.trim() ? "AND (',' || COALESCE(f.tags,'') || ',') LIKE @tagPattern" : "";
  const tagPattern = tag?.trim() ? `%,${tag.toLowerCase().trim()},%` : null;
  const tierFilterClause = tierFilter === "warm" ? "AND (f.tier IS NULL OR f.tier = 'warm' OR f.tier = 'hot')" : "";
  const { clause: scopeFilterClauseStr, params: scopeParams } = scopeFilterClauseNamed(scopeFilter);

  const decayWindowSec = 7 * 24 * 3600;
  const paramBag: Record<string, SQLInputValue> = {
    "@query": safeQuery,
    "@now": nowSec,
    ...(asOf != null ? { "@asOf": asOf } : {}),
    "@limit": limit * 2,
    "@decay_window": decayWindowSec,
    ...(tagPattern ? { "@tagPattern": tagPattern } : {}),
    ...scopeParams,
  };

  let rows: Array<Record<string, unknown>>;

  if (interactiveFtsFastPath) {
    const narrowParamBag: Record<string, SQLInputValue> = {
      "@query": safeQuery,
      "@now": nowSec,
      ...(asOf != null ? { "@asOf": asOf } : {}),
      "@limit": limit * 2,
      ...(tagPattern ? { "@tagPattern": tagPattern } : {}),
      ...scopeParams,
    };
    const narrowSql = `SELECT f.id AS id, fts.rank AS fts_score
         FROM facts f
         JOIN facts_fts fts ON f.rowid = fts.rowid
         WHERE facts_fts MATCH @query
           ${expiryFilter}
           ${temporalFilter}
           ${tagFilter}
           ${tierFilterClause}
           ${scopeFilterClauseStr}
         ORDER BY fts.rank
         LIMIT @limit`;
    const narrowRows = db.prepare(narrowSql).all(narrowParamBag) as Array<{
      id: string;
      fts_score: number;
    }>;
    if (narrowRows.length === 0) return [];
    const ids = narrowRows.map((r) => r.id);
    const ftsById = new Map(narrowRows.map((r) => [r.id, r.fts_score]));
    const placeholders = ids.map(() => "?").join(",");
    const fullRows = db.prepare(`SELECT * FROM facts WHERE id IN (${placeholders})`).all(...ids) as Array<
      Record<string, unknown>
    >;
    const byId = new Map(fullRows.map((r) => [r.id as string, r]));
    const decayWindow = decayWindowSec;
    rows = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) continue;
      const expiresAt = row.expires_at as number | null | undefined;
      let freshness: number;
      if (expiresAt == null) freshness = 1.0;
      else if (expiresAt <= nowSec) freshness = 0.0;
      else freshness = Math.min(1.0, (expiresAt - nowSec) / decayWindow);
      rows.push({
        ...row,
        fts_score: ftsById.get(id) as number,
        freshness,
      });
    }
    if (rows.length === 0) return [];
  } else {
    rows = db
      .prepare(
        `SELECT f.*, bm25(facts_fts) as fts_score,
           CASE
             WHEN f.expires_at IS NULL THEN 1.0
             WHEN f.expires_at <= @now THEN 0.0
             ELSE MIN(1.0, CAST(f.expires_at - @now AS REAL) / CAST(@decay_window AS REAL))
           END AS freshness
         FROM facts f
         JOIN facts_fts fts ON f.rowid = fts.rowid
         WHERE facts_fts MATCH @query
           ${expiryFilter}
           ${temporalFilter}
           ${tagFilter}
           ${tierFilterClause}
           ${scopeFilterClauseStr}
         ORDER BY bm25(facts_fts)
         LIMIT @limit`,
      )
      .all(paramBag) as Array<Record<string, unknown>>;
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
