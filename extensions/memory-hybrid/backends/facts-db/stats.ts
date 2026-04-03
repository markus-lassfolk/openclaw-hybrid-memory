/**
 * Stats, dashboard listing, and category rollups for FactsDB (Issue #954).
 */
import type { SQLInputValue } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

import { DECAY_CLASSES } from "../../config.js";
import { isValidCategory } from "../../config.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { searchFts } from "../../services/fts-search.js";
import { parseTags } from "../../utils/tags.js";
import { estimateTokensForDisplay } from "../../utils/text.js";

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

export function countFacts(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM facts").get() as Record<string, number>;
  return row.cnt;
}

export function countExpiredFacts(db: DatabaseSync): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?")
    .get(nowSec) as {
    cnt: number;
  };
  return row.cnt;
}

export function estimateStoredTokens(db: DatabaseSync): number {
  const rows = db.prepare("SELECT summary, text FROM facts WHERE superseded_at IS NULL").all() as Array<{
    summary: string | null;
    text: string;
  }>;
  return rows.reduce((sum, r) => sum + estimateTokensForDisplay(r.summary || r.text), 0);
}

export function estimateStoredTokensByTier(db: DatabaseSync): {
  hot: number;
  warm: number;
  cold: number;
} {
  const rows = db
    .prepare(`SELECT COALESCE(tier, 'warm') as tier, summary, text FROM facts WHERE superseded_at IS NULL`)
    .all() as Array<{ tier: string; summary: string | null; text: string }>;
  const out = { hot: 0, warm: 0, cold: 0 };
  for (const r of rows) {
    const tok = estimateTokensForDisplay(r.summary || r.text);
    const t = r.tier || "warm";
    if (t === "hot") out.hot += tok;
    else if (t === "cold") out.cold += tok;
    else out.warm += tok;
  }
  return out;
}

export function linksCount(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM memory_links").get() as { cnt: number };
    return row?.cnt ?? 0;
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "count-links",
      severity: "info",
      subsystem: "facts",
    });
    return 0;
  }
}

export function directivesCount(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL AND source LIKE 'directive:%'`)
    .get() as { cnt: number };
  return row?.cnt ?? 0;
}

export function metaPatternsCount(db: DatabaseSync): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL AND category = 'pattern' AND (',' || COALESCE(tags,'') || ',') LIKE '%,meta,%'`,
      )
      .get() as { cnt: number };
    return row?.cnt ?? 0;
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "count-meta-patterns",
      severity: "info",
      subsystem: "facts",
    });
    return 0;
  }
}

export function entityCount(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT entity) as cnt FROM facts WHERE superseded_at IS NULL AND entity IS NOT NULL AND entity != ''`,
    )
    .get() as { cnt: number };
  return row?.cnt ?? 0;
}

export function getTokenBudgetStatus(db: DatabaseSync): {
  totalTokens: number;
  budget: number;
  overflow: number;
  byTier: { p0: number; p1: number; p2: number; p3: number };
  factCount: { p0: number; p1: number; p2: number; p3: number };
} {
  const nowSec = Math.floor(Date.now() / 1000);
  const HOUR_SEC = 3600;
  const p1Cutoff = nowSec - HOUR_SEC;
  const tokenEstimate = (text: string): number => Math.ceil(text.length / 3.8);
  const DEFAULT_BUDGET = Math.ceil((32_000 * 0.8) / 3.8);
  const budget = DEFAULT_BUDGET;

  const rows = db
    .prepare(
      `SELECT f.id, f.text, f.importance, f.created_at, f.preserve_until, f.preserve_tags,
                f.confidence, f.tags,
                vf.fact_id IS NOT NULL AS is_verified
         FROM facts f
         LEFT JOIN verified_facts vf ON vf.fact_id = f.id
         WHERE f.superseded_at IS NULL
           AND (f.expires_at IS NULL OR f.expires_at > ?)`,
    )
    .all(nowSec) as Array<{
    id: string;
    text: string;
    importance: number;
    created_at: number;
    preserve_until: number | null;
    preserve_tags: string | null;
    confidence: number;
    tags: string | null;
    is_verified: number;
  }>;

  const parsePreserveTags = (raw: string | null): string[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : [];
    } catch {
      return [];
    }
  };

  const hasTag = (tagsStr: string | null, tag: string): boolean => {
    return parseTags(tagsStr).includes(tag.toLowerCase().trim());
  };

  const byTier = { p0: 0, p1: 0, p2: 0, p3: 0 };
  const factCount = { p0: 0, p1: 0, p2: 0, p3: 0 };

  for (const row of rows) {
    const preserveTags = parsePreserveTags(row.preserve_tags);
    const tagsStr = row.tags;
    const isEdict = hasTag(tagsStr, "edict");
    const isVerified = row.is_verified === 1;
    const hasPreserveUntil = row.preserve_until != null && row.preserve_until > nowSec;
    const hasPreserveTags = preserveTags.length > 0;

    const tokens = tokenEstimate(row.text);

    if (isEdict || isVerified || hasPreserveUntil || hasPreserveTags) {
      byTier.p0 += tokens;
      factCount.p0++;
    } else if (row.importance > 0.8 && row.created_at >= p1Cutoff) {
      byTier.p1 += tokens;
      factCount.p1++;
    } else if (row.importance >= 0.5) {
      byTier.p2 += tokens;
      factCount.p2++;
    } else {
      byTier.p3 += tokens;
      factCount.p3++;
    }
  }

  const totalTokens = byTier.p0 + byTier.p1 + byTier.p2 + byTier.p3;
  return {
    totalTokens,
    budget,
    overflow: Math.max(0, totalTokens - budget),
    byTier,
    factCount,
  };
}
