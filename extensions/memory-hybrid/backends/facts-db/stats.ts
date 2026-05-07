/**
 * Stats, dashboard listing, and category rollups for FactsDB (Issue #954).
 */
import type { SQLInputValue } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

import { DECAY_CLASSES } from "../../config.js";
import { isValidCategory } from "../../config.js";
import { filterEntityStopWords, isEntityStopWord } from "../../utils/entity-stopwords.js";
import { capturePluginError } from "../../services/error-reporter.js";
import { searchFts } from "../../services/fts-search.js";
import { parseTags } from "../../utils/tags.js";
import { estimateTokensForDisplay } from "../../utils/text.js";
import { preserveTagsColumnExcludesFromTrimSql } from "./fact-queries.js";

/** Allowlisted tier values for dynamic SQL fragments in list()/dashboard filters (#842). */
export const DASHBOARD_TIER_FILTER = new Set<string>(["warm", "hot", "cold", "structural"]);
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
  const stats: Record<string, number> = { hot: 0, warm: 0, cold: 0, structural: 0 };
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

export type CategoryAuditRow = {
  category: string;
  count: number;
  examples: string[];
};

export type CategoryAuditReport = {
  configured: string[];
  inMemory: CategoryAuditRow[];
  unknown: CategoryAuditRow[];
  configuredOnly: string[];
  hasDrift: boolean;
};

export type RemapCategoryReport = {
  from: string;
  to: string;
  apply: boolean;
  matched: number;
  activeMatched: number;
  changed: number;
};

export type TopEntityRow = {
  entity: string;
  count: number;
};

export type CleanEntityStopwordsReport = {
  apply: boolean;
  stopWords: string[];
  matched: number;
  activeMatched: number;
  changed: number;
  examples: Array<{ id: string; entity: string }>;
};

export type VectorlessFactRow = {
  id: string;
  text: string;
  source: string;
  category: string;
  createdAt: number;
};

export type VectorlessBySourceRow = {
  source: string;
  count: number;
};

function vectorlessWhereClause(): string {
  return `f.superseded_at IS NULL
     AND (f.expires_at IS NULL OR f.expires_at > ?)
     AND COALESCE(f.key, '') = ''
     AND COALESCE(f.value, '') = ''
     AND NOT EXISTS (
       SELECT 1 FROM fact_embeddings e
       WHERE e.fact_id = f.id AND e.variant = 'canonical'
     )`;
}

export function countVectorlessActiveFacts(db: DatabaseSync, source?: string): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const params: SQLInputValue[] = [nowSec];
  let where = vectorlessWhereClause();
  if (source != null && source !== "") {
    where += " AND f.source = ?";
    params.push(source);
  }
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM facts f WHERE ${where}`).get(...params) as
    | { cnt: number }
    | undefined;
  return Number(row?.cnt ?? 0);
}

export function vectorlessActiveFactsBySource(db: DatabaseSync, limit = 20): VectorlessBySourceRow[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(f.source, ''), 'unknown') AS source, COUNT(*) AS cnt
       FROM facts f
       WHERE ${vectorlessWhereClause()}
       GROUP BY COALESCE(NULLIF(f.source, ''), 'unknown')
       ORDER BY cnt DESC, source COLLATE NOCASE ASC
       LIMIT ?`,
    )
    .all(nowSec, Math.max(1, Math.min(100, Math.floor(limit)))) as Array<{ source: string; cnt: number }>;
  return rows.map((row) => ({ source: row.source, count: Number(row.cnt ?? 0) }));
}

export function listVectorlessActiveFacts(
  db: DatabaseSync,
  options: { limit?: number; source?: string } = {},
): VectorlessFactRow[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const params: SQLInputValue[] = [nowSec];
  let where = vectorlessWhereClause();
  if (options.source != null && options.source !== "") {
    where += " AND f.source = ?";
    params.push(options.source);
  }
  params.push(Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 100))));
  const rows = db
    .prepare(
      `SELECT f.id, f.text, COALESCE(NULLIF(f.source, ''), 'unknown') AS source,
              COALESCE(f.category, 'other') AS category, f.created_at
       FROM facts f
       WHERE ${where}
       ORDER BY f.created_at ASC, f.rowid ASC
       LIMIT ?`,
    )
    .all(...params) as Array<{ id: string; text: string; source: string; category: string; created_at: number }>;
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    source: row.source,
    category: row.category,
    createdAt: Number(row.created_at ?? 0),
  }));
}

export function auditCategories(
  db: DatabaseSync,
  configuredCategories: readonly string[],
  exampleLimit = 5,
): CategoryAuditReport {
  const configured = [...new Set(configuredCategories)].sort();
  const configuredSet = new Set(configured);
  const rows = db
    .prepare(
      "SELECT COALESCE(category, 'other') as category, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY category ORDER BY category",
    )
    .all() as Array<{ category: string; cnt: number }>;

  const inMemory: CategoryAuditRow[] = rows.map((row) => {
    const examples = db
      .prepare(
        "SELECT id FROM facts WHERE COALESCE(category, 'other') = ? AND superseded_at IS NULL ORDER BY created_at DESC LIMIT ?",
      )
      .all(row.category || "other", Math.max(0, exampleLimit)) as Array<{ id: string }>;
    return {
      category: row.category || "other",
      count: row.cnt,
      examples: examples.map((e) => e.id),
    };
  });

  const inMemorySet = new Set(inMemory.map((r) => r.category));
  const unknown = inMemory.filter((row) => !configuredSet.has(row.category));
  const configuredOnly = configured.filter((category) => !inMemorySet.has(category));
  return {
    configured,
    inMemory,
    unknown,
    configuredOnly,
    hasDrift: unknown.length > 0,
  };
}

export function remapCategory(db: DatabaseSync, from: string, to: string, apply = false): RemapCategoryReport {
  const normalizedFrom = from.trim();
  const normalizedTo = to.trim();
  const matchedRow = db.prepare("SELECT COUNT(*) as cnt FROM facts WHERE category = ?").get(normalizedFrom) as {
    cnt: number;
  };
  const activeMatchedRow = db
    .prepare("SELECT COUNT(*) as cnt FROM facts WHERE category = ? AND superseded_at IS NULL")
    .get(normalizedFrom) as { cnt: number };
  const matched = matchedRow?.cnt ?? 0;
  const activeMatched = activeMatchedRow?.cnt ?? 0;
  let changed = 0;
  if (apply && matched > 0) {
    const result = db.prepare("UPDATE facts SET category = ? WHERE category = ?").run(normalizedTo, normalizedFrom);
    changed = Number(result.changes);
  }
  return {
    from: normalizedFrom,
    to: normalizedTo,
    apply,
    matched,
    activeMatched,
    changed,
  };
}

export function topEntities(db: DatabaseSync, limit = 10): TopEntityRow[] {
  const rows = db
    .prepare(
      `SELECT entity, COUNT(*) as cnt FROM facts
       WHERE entity IS NOT NULL AND entity != '' AND superseded_at IS NULL
       GROUP BY entity ORDER BY cnt DESC, entity COLLATE NOCASE ASC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, Math.floor(limit)))) as Array<{ entity: string; cnt: number }>;
  return rows.map((row) => ({ entity: row.entity, count: row.cnt }));
}

export function topEntitiesFiltered(
  db: DatabaseSync,
  limit = 10,
  extraStopWords: readonly string[] = [],
): TopEntityRow[] {
  const scanLimit = Math.max(50, Math.max(1, Math.min(100, Math.floor(limit))) * 10);
  const rows = db
    .prepare(
      `SELECT entity, COUNT(*) as cnt FROM facts
       WHERE entity IS NOT NULL AND entity != '' AND superseded_at IS NULL
       GROUP BY entity ORDER BY cnt DESC, entity COLLATE NOCASE ASC LIMIT ?`,
    )
    .all(scanLimit) as Array<{ entity: string; cnt: number }>;
  return rows
    .filter((row) => !isEntityStopWord(row.entity, extraStopWords))
    .slice(0, Math.max(1, Math.min(100, Math.floor(limit))))
    .map((row) => ({ entity: row.entity, count: row.cnt }));
}

export function cleanEntityStopwords(
  db: DatabaseSync,
  options: { apply?: boolean; stopWords?: readonly string[]; exampleLimit?: number } = {},
): CleanEntityStopwordsReport {
  const apply = options.apply === true;
  const stopWords = [...(options.stopWords ?? [])];
  const rows = db
    .prepare(
      `SELECT id, entity, superseded_at FROM facts
       WHERE entity IS NOT NULL AND entity != ''
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all() as Array<{ id: string; entity: string; superseded_at: number | null }>;
  const matchedRows = rows.filter((row) => isEntityStopWord(row.entity, stopWords));
  const activeMatchedRows = matchedRows.filter((row) => row.superseded_at == null);
  let changed = 0;
  if (apply && matchedRows.length > 0) {
    const ids = matchedRows.map((row) => row.id);
    const CHUNK_SIZE = 500;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      const result = db.prepare(`UPDATE facts SET entity = NULL WHERE id IN (${placeholders})`).run(...chunk);
      changed += Number(result.changes);
    }
  }
  const exampleLimit = Math.max(0, Math.min(50, Math.floor(options.exampleLimit ?? 10)));
  return {
    apply,
    stopWords,
    matched: matchedRows.length,
    activeMatched: activeMatchedRows.length,
    changed,
    examples: activeMatchedRows.slice(0, exampleLimit).map((row) => ({ id: row.id, entity: row.entity })),
  };
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
  structural: number;
} {
  const rows = db
    .prepare(`SELECT COALESCE(tier, 'warm') as tier, summary, text FROM facts WHERE superseded_at IS NULL`)
    .all() as Array<{ tier: string; summary: string | null; text: string }>;
  const out = { hot: 0, warm: 0, cold: 0, structural: 0 };
  for (const r of rows) {
    const tok = estimateTokensForDisplay(r.summary || r.text);
    const t = r.tier || "warm";
    if (t === "hot") out.hot += tok;
    else if (t === "cold") out.cold += tok;
    else if (t === "structural") out.structural += tok;
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
    const hasPreserveTags = preserveTags.length > 0 || preserveTagsColumnExcludesFromTrimSql(row.preserve_tags);

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
