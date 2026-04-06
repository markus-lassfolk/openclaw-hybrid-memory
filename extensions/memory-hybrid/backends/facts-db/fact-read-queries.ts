/**
 * Fact reads: classification similarity, getById filters, list, getAll family (Issue #954 split).
 */
import type { SQLInputValue } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

import { isValidCategory } from "../../config.js";
import { capturePluginError } from "../../services/error-reporter.js";
import type { MemoryEntry, ScopeFilter, SearchResult } from "../../types/memory.js";
import { estimateTokensForDisplay } from "../../utils/text.js";
import { buildClassificationFtsOrClause } from "./fact-queries.js";
import { rowToMemoryEntry } from "./row-mapper.js";
import { scopeFilterClausePositional } from "./scope-sql.js";
import { DASHBOARD_TIER_FILTER } from "./stats.js";

export function applyLookupFilters(
  entry: MemoryEntry,
  options?: { asOf?: number; scopeFilter?: ScopeFilter | null },
): MemoryEntry | null {
  const asOf = options?.asOf;
  if (asOf != null) {
    const vf = entry.validFrom ?? entry.createdAt;
    const vu = entry.validUntil ?? null;
    if (vf > asOf || (vu != null && vu <= asOf)) return null;
  }
  const scopeFilter = options?.scopeFilter;
  if (scopeFilter && (scopeFilter.userId || scopeFilter.agentId || scopeFilter.sessionId)) {
    const scope = entry.scope ?? "global";
    if (scope === "global") return entry;
    const target = entry.scopeTarget ?? null;
    const matches =
      (scope === "user" && (scopeFilter.userId ?? null) === target) ||
      (scope === "agent" && (scopeFilter.agentId ?? null) === target) ||
      (scope === "session" && (scopeFilter.sessionId ?? null) === target);
    if (!matches) return null;
  }
  return entry;
}

export function findSimilarForClassification(
  db: DatabaseSync,
  text: string,
  entity: string | null,
  key: string | null,
  limit = 5,
): MemoryEntry[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const results: MemoryEntry[] = [];

  if (entity && key) {
    const rows = db
      .prepare(
        "SELECT * FROM facts WHERE lower(entity) = lower(?) AND lower(key) = lower(?) AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT ?",
      )
      .all(entity, key, nowSec, limit) as Array<Record<string, unknown>>;
    for (const row of rows) {
      results.push(rowToMemoryEntry(row));
    }
  }

  if (entity && results.length < limit) {
    const remaining = limit - results.length;
    const seenIds = new Set(results.map((r) => r.id));
    const rows = db
      .prepare(
        "SELECT * FROM facts WHERE lower(entity) = lower(?) AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT ?",
      )
      .all(entity, nowSec, remaining + results.length) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const entry = rowToMemoryEntry(row);
      if (!seenIds.has(entry.id)) {
        results.push(entry);
        seenIds.add(entry.id);
        if (results.length >= limit) break;
      }
    }
  }

  if (results.length < limit) {
    const remaining = limit - results.length;
    const seenIds = new Set(results.map((r) => r.id));
    const words = buildClassificationFtsOrClause(text);
    if (words) {
      try {
        const ftsStmt = db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?");
        let fetchLimit = Math.max((remaining + results.length) * 3, 50);
        const maxFetch = Math.min(10_000, Math.max(remaining * 200, 500));
        for (;;) {
          const ftsRows = ftsStmt.all(words, fetchLimit) as Array<{ rowid: number }>;
          if (ftsRows.length === 0) break;

          const CHUNK_SIZE = 500;
          const allRows: Array<Record<string, unknown>> = [];
          for (let i = 0; i < ftsRows.length; i += CHUNK_SIZE) {
            const chunk = ftsRows.slice(i, i + CHUNK_SIZE);
            const ph = chunk.map(() => "?").join(",");
            allRows.push(
              ...(db
                .prepare(
                  `SELECT *, rowid AS _rowid FROM facts WHERE rowid IN (${ph}) AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
                )
                .all(...chunk.map((r) => r.rowid), nowSec) as Array<Record<string, unknown>>),
            );
          }
          const factRows = allRows;
          const byRowid = new Map(factRows.map((r) => [r._rowid as number, r]));
          for (const { rowid } of ftsRows) {
            const row = byRowid.get(rowid);
            if (!row) continue;
            const entry = rowToMemoryEntry(row);
            if (!seenIds.has(entry.id)) {
              results.push(entry);
              seenIds.add(entry.id);
              if (results.length >= limit) break;
            }
          }

          if (results.length >= limit) break;
          if (ftsRows.length < fetchLimit) break;
          if (fetchLimit >= maxFetch) break;
          fetchLimit = Math.min(fetchLimit * 2, maxFetch);
        }
      } catch (err) {
        capturePluginError(err as Error, {
          operation: "fts-query",
          severity: "info",
          subsystem: "facts",
        });
      }
    }
  }

  return results.slice(0, limit);
}

export function getFactsForConsolidation(
  db: DatabaseSync,
  limit: number,
): Array<{
  id: string;
  text: string;
  category: string;
  entity: string | null;
  key: string | null;
}> {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT id, text, category, entity, key FROM facts
         WHERE (expires_at IS NULL OR expires_at > ?)
           AND superseded_at IS NULL
           AND lower(COALESCE(source, '')) NOT IN ('consolidation', 'dream-cycle')
           AND lower(COALESCE(key, '')) != 'consolidated'
           AND (',' || lower(COALESCE(tags, '')) || ',') NOT LIKE '%,consolidated,%'
         ORDER BY created_at DESC LIMIT ?`,
    )
    .all(nowSec, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    text: row.text as string,
    category: row.category as string,
    entity: (row.entity as string) || null,
    key: (row.key as string) || null,
  }));
}

export function getById(
  db: DatabaseSync,
  id: string,
  options?: { asOf?: number; scopeFilter?: ScopeFilter | null },
): MemoryEntry | null {
  const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const entry = rowToMemoryEntry(row);
  return applyLookupFilters(entry, options);
}

export function getByIds(
  db: DatabaseSync,
  ids: string[],
  options?: { asOf?: number; scopeFilter?: ScopeFilter | null },
): Map<string, MemoryEntry> {
  const result = new Map<string, MemoryEntry>();
  if (ids.length === 0) return result;
  const uniqueIds = Array.from(new Set(ids));
  const CHUNK_SIZE = 500;
  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM facts WHERE id IN (${placeholders})`).all(...chunk) as Array<
      Record<string, unknown>
    >;
    for (const row of rows) {
      const entry = rowToMemoryEntry(row);
      const filtered = applyLookupFilters(entry, options);
      if (filtered) result.set(filtered.id, filtered);
    }
  }
  return result;
}

export function getRecentFacts(
  db: DatabaseSync,
  days: number,
  options?: { excludeCategories?: string[] },
): MemoryEntry[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartSec = nowSec - Math.max(1, Math.min(90, days)) * 86400;
  const exclude = options?.excludeCategories ?? ["pattern", "rule"];
  const placeholders = exclude.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM facts WHERE (expires_at IS NULL OR expires_at > ?) AND superseded_at IS NULL
         AND (COALESCE(source_date, created_at) >= ?)
         AND category NOT IN (${placeholders})
         ORDER BY COALESCE(source_date, created_at) DESC`,
    )
    .all(nowSec, windowStartSec, ...exclude) as Array<Record<string, unknown>>;
  return rows.map((row) => rowToMemoryEntry(row));
}

export function getAll(
  db: DatabaseSync,
  options?: {
    includeSuperseded?: boolean;
    asOf?: number;
    scopeFilter?: ScopeFilter | null;
  },
): MemoryEntry[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const { includeSuperseded = false, asOf, scopeFilter } = options ?? {};
  const temporalFilter =
    asOf != null
      ? " AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)"
      : includeSuperseded
        ? ""
        : " AND superseded_at IS NULL";
  const { clause: scopeClause, params: scopeParams } = scopeFilterClausePositional(scopeFilter);
  const params = asOf != null ? [...[nowSec, asOf, asOf], ...scopeParams] : [...[nowSec], ...scopeParams];
  const rows = db
    .prepare(
      `SELECT * FROM facts WHERE (expires_at IS NULL OR expires_at > ?)${temporalFilter}${scopeClause} ORDER BY created_at DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => rowToMemoryEntry(row));
}

export function getCount(db: DatabaseSync, options?: { includeSuperseded?: boolean }): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const { includeSuperseded = false } = options ?? {};
  const temporalFilter = includeSuperseded ? "" : " AND superseded_at IS NULL";
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM facts WHERE (expires_at IS NULL OR expires_at > ?)${temporalFilter}`)
    .get(nowSec) as { count: number };
  return row?.count ?? 0;
}

export function getAllIds(db: DatabaseSync): string[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare("SELECT id FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
    .all(nowSec) as Array<{ id: string }>;
  return rows.map((row) => row.id.toLowerCase());
}

export function getBatch(
  db: DatabaseSync,
  offset: number,
  limit: number,
  options?: { includeSuperseded?: boolean },
): MemoryEntry[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const { includeSuperseded = false } = options ?? {};
  const temporalFilter = includeSuperseded ? "" : " AND superseded_at IS NULL";
  const rows = db
    .prepare(
      `SELECT * FROM facts WHERE (expires_at IS NULL OR expires_at > ?)${temporalFilter} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(nowSec, limit, offset) as Array<Record<string, unknown>>;
  return rows.map((row) => rowToMemoryEntry(row));
}

export function listFacts(
  db: DatabaseSync,
  limit: number,
  filters?: {
    category?: string;
    entity?: string;
    key?: string;
    source?: string;
    tier?: string;
  },
): MemoryEntry[] {
  const nowSec = Math.floor(Date.now() / 1000);
  if (
    (filters?.category != null && filters.category !== "" && !isValidCategory(filters.category)) ||
    (filters?.tier != null && filters.tier !== "" && !DASHBOARD_TIER_FILTER.has(filters.tier))
  ) {
    return [];
  }
  const parts: string[] = ["(expires_at IS NULL OR expires_at > ?)", "superseded_at IS NULL"];
  const params: SQLInputValue[] = [nowSec];
  if (filters?.category != null && isValidCategory(filters.category)) {
    parts.push("category = ?");
    params.push(filters.category);
  }
  if (filters?.entity != null) {
    parts.push("lower(entity) = lower(?)");
    params.push(filters.entity);
  }
  if (filters?.key != null) {
    parts.push("lower(key) = lower(?)");
    params.push(filters.key);
  }
  if (filters?.source != null) {
    parts.push("source = ?");
    params.push(filters.source);
  }
  if (filters?.tier != null && DASHBOARD_TIER_FILTER.has(filters.tier)) {
    parts.push("COALESCE(tier, 'warm') = ?");
    params.push(filters.tier);
  }
  const where = parts.join(" AND ");
  params.push(limit);
  const rows = db
    .prepare(`SELECT * FROM facts WHERE ${where} ORDER BY COALESCE(source_date, created_at) DESC LIMIT ?`)
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => rowToMemoryEntry(row));
}

export function getHotFacts(db: DatabaseSync, maxTokens: number, scopeFilter?: ScopeFilter | null): SearchResult[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const { clause: scopeClause, params: scopeParams } = scopeFilterClausePositional(scopeFilter);
  const rows = db
    .prepare(
      `SELECT * FROM facts
         WHERE tier = 'hot' AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         ${scopeClause}
         ORDER BY COALESCE(last_accessed, last_confirmed_at, created_at) DESC`,
    )
    .all(nowSec, ...scopeParams) as Array<Record<string, unknown>>;
  const results: SearchResult[] = [];
  let usedTokens = 0;
  for (const row of rows) {
    if (usedTokens >= maxTokens) break;
    const entry = rowToMemoryEntry(row);
    const tokens = estimateTokensForDisplay(entry.summary || entry.text);
    if (usedTokens + tokens > maxTokens) {
      continue;
    }
    usedTokens += tokens;
    results.push({ entry, score: 1.0, backend: "sqlite" as const });
  }
  return results;
}

export function getByCategory(db: DatabaseSync, category: string): MemoryEntry[] {
  const rows = db.prepare("SELECT * FROM facts WHERE category = ? ORDER BY created_at DESC").all(category) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => rowToMemoryEntry(row));
}

export function listFactsByCategory(db: DatabaseSync, category: string, limit = 100): MemoryEntry[] {
  const rows = db
    .prepare(
      "SELECT * FROM facts WHERE category = ? AND (superseded_at IS NULL) ORDER BY COALESCE(source_date, created_at) DESC LIMIT ?",
    )
    .all(category, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => rowToMemoryEntry(row));
}

export function listDirectives(db: DatabaseSync, limit = 100): MemoryEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM facts WHERE source LIKE 'directive:%' AND (superseded_at IS NULL) ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => rowToMemoryEntry(row));
}

export function updateCategory(db: DatabaseSync, id: string, category: string): boolean {
  const result = db.prepare("UPDATE facts SET category = ? WHERE id = ?").run(category, id);
  return result.changes > 0;
}
