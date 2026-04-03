/**
 * Stats, dashboard listing, and category rollups for FactsDB (Issue #954).
 */
import type { SQLInputValue } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

import { DECAY_CLASSES } from "../../config.js";
import { isValidCategory } from "../../config.js";
import { searchFts } from "../../services/fts-search.js";

/** Allowlisted tier values for dynamic SQL fragments in list()/dashboard filters (#842). */
export const DASHBOARD_TIER_FILTER = new Set<string>(["warm", "hot", "cold"]);
export const DECAY_CLASS_FILTER = new Set<string>(DECAY_CLASSES);

export function statsBreakdown(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare("SELECT decay_class, COUNT(*) as cnt FROM facts GROUP BY decay_class").all() as Array<{
    decay_class: string;
    cnt: number;
  }>;

  const stats: Record<string, number> = {};
  for (const row of rows) {
    stats[row.decay_class || "unknown"] = row.cnt;
  }
  return stats;
}

export function statsBreakdownByTier(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(tier, 'warm') as tier, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY tier`,
    )
    .all() as Array<{ tier: string; cnt: number }>;
  const stats: Record<string, number> = { hot: 0, warm: 0, cold: 0 };
  for (const row of rows) {
    stats[row.tier || "warm"] = row.cnt;
  }
  return stats;
}

export function statsBreakdownBySource(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare("SELECT source, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY source")
    .all() as Array<{ source: string; cnt: number }>;
  const stats: Record<string, number> = {};
  for (const row of rows) {
    stats[row.source || "unknown"] = row.cnt;
  }
  return stats;
}

export function statsBreakdownByCategory(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare("SELECT category, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY category")
    .all() as Array<{ category: string; cnt: number }>;
  const stats: Record<string, number> = {};
  for (const row of rows) {
    stats[row.category || "other"] = row.cnt;
  }
  return stats;
}

export function statsBreakdownByDecayClass(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(decay_class, 'stable') as decay_class, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY decay_class`,
    )
    .all() as Array<{ decay_class: string; cnt: number }>;
  const stats: Record<string, number> = {};
  for (const row of rows) {
    stats[row.decay_class || "stable"] = row.cnt;
  }
  return stats;
}

export function listForDashboard(
  db: DatabaseSync,
  opts: {
    limit: number;
    offset: number;
    category?: string;
    tier?: string;
    decayClass?: string;
    entity?: string;
    search?: string;
  },
): { facts: Array<Record<string, unknown>>; total: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  if (
    (opts.category != null && opts.category !== "" && !isValidCategory(opts.category)) ||
    (opts.tier != null && opts.tier !== "" && !DASHBOARD_TIER_FILTER.has(opts.tier)) ||
    (opts.decayClass != null && opts.decayClass !== "" && !DECAY_CLASS_FILTER.has(opts.decayClass))
  ) {
    return { facts: [], total: 0 };
  }

  let where = "superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
  const params: SQLInputValue[] = [nowSec];

  if (opts.category && isValidCategory(opts.category)) {
    where += " AND category = ?";
    params.push(opts.category);
  }
  if (opts.tier && DASHBOARD_TIER_FILTER.has(opts.tier)) {
    where += " AND COALESCE(tier, 'warm') = ?";
    params.push(opts.tier);
  }
  if (opts.decayClass && DECAY_CLASS_FILTER.has(opts.decayClass)) {
    where += " AND COALESCE(decay_class, 'stable') = ?";
    params.push(opts.decayClass);
  }
  if (opts.entity) {
    where += " AND entity = ?";
    params.push(opts.entity);
  }

  const toDashboardRow = (row: Record<string, unknown>) => ({
    id: row.id,
    text: row.text,
    category: row.category,
    importance: row.importance,
    entity: row.entity ?? null,
    key: row.key ?? null,
    value: row.value ?? null,
    tags:
      typeof row.tags === "string"
        ? (row.tags || "")
            .split(",")
            .map((t: string) => t.trim())
            .filter(Boolean)
            .join(",")
        : "",
    tier: (row.tier as string) || "warm",
    decay_class: (row.decay_class as string) || "stable",
    scope: (row.scope as string) || "global",
    confidence: row.confidence ?? 1,
    created_at: row.created_at,
    recall_count: row.recall_count ?? 0,
  });

  if (opts.search?.trim()) {
    const ftsResults = searchFts(db, opts.search.trim(), { limit: 2000 });
    const allFtsIds = ftsResults.map((r) => r.factId);
    if (allFtsIds.length === 0) return { facts: [], total: 0 };
    const CHUNK_SIZE = 500;
    const filteredIdRows: Array<{ id: string }> = [];
    for (let i = 0; i < allFtsIds.length; i += CHUNK_SIZE) {
      const chunk = allFtsIds.slice(i, i + CHUNK_SIZE);
      const idPlaceholders = chunk.map(() => "?").join(",");
      const chunkRows = db
        .prepare(`SELECT id FROM facts WHERE id IN (${idPlaceholders}) AND ${where}`)
        .all(...chunk, ...params) as Array<{ id: string }>;
      filteredIdRows.push(...chunkRows);
    }
    const filteredSet = new Set(filteredIdRows.map((r) => r.id));
    const filteredIds = allFtsIds.filter((id) => filteredSet.has(id));
    const searchTotal = filteredIds.length;
    const pageIds = filteredIds.slice(opts.offset, opts.offset + opts.limit);
    if (pageIds.length === 0) return { facts: [], total: searchTotal };
    const placeholders = pageIds.map(() => "?").join(",");
    const pageRows = db
      .prepare(
        `SELECT id, text, category, importance, entity, key, value, tags, COALESCE(tier, 'warm') as tier,
         COALESCE(decay_class, 'stable') as decay_class, COALESCE(scope, 'global') as scope, confidence,
         created_at, recall_count FROM facts WHERE id IN (${placeholders})`,
      )
      .all(...pageIds) as Array<Record<string, unknown>>;
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of pageRows) byId.set(r.id as string, r);
    const facts = pageIds.flatMap((id) => {
      const r = byId.get(id);
      return r ? [toDashboardRow(r)] : [];
    });
    return { facts, total: searchTotal };
  }

  const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM facts WHERE ${where}`).get(...params) as {
    cnt: number;
  };
  const total = countRow?.cnt ?? 0;

  const rows = db
    .prepare(
      `SELECT id, text, category, importance, entity, key, value, tags, COALESCE(tier, 'warm') as tier,
       COALESCE(decay_class, 'stable') as decay_class, COALESCE(scope, 'global') as scope, confidence,
       created_at, recall_count FROM facts WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit, opts.offset) as Array<Record<string, unknown>>;

  const facts = rows.map((r) => toDashboardRow(r));
  return { facts, total };
}

export function uniqueMemoryCategories(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT DISTINCT category FROM facts WHERE superseded_at IS NULL ORDER BY category")
    .all() as Array<{ category: string }>;
  return rows.map((r) => r.category || "other");
}
