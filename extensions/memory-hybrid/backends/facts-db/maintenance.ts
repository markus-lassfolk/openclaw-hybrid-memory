/**
 * Compaction, pruning, tiering, checkpoints, recall log (Issue #954).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { DecayClass, MemoryCategory } from "../../config.js";
import { capturePluginError } from "../../services/error-reporter.js";
import type { MemoryEntry, MemoryTier } from "../../types/memory.js";
import { calculateExpiry, classifyDecay } from "../../utils/decay.js";
import { createTransaction } from "../../utils/sqlite-transaction.js";
import { parseTags } from "../../utils/tags.js";
import type { StoreFactInput } from "./crud.js";
import { preserveTagsColumnExcludesFromTrimSql } from "./fact-queries.js";

export function logRecall(db: DatabaseSync, hit: boolean, occurredAtSec?: number): void {
  const id = randomUUID();
  const nowSec = occurredAtSec ?? Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO recall_log (id, occurred_at, hit) VALUES (?, ?, ?)").run(id, nowSec, hit ? 1 : 0);
}

export function pruneRecallLog(db: DatabaseSync, olderThanDays = 30): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 24 * 3600;
  return Number(db.prepare("DELETE FROM recall_log WHERE occurred_at < ?").run(cutoff).changes ?? 0);
}

export function setFactTier(db: DatabaseSync, id: string, tier: MemoryTier): boolean {
  const result = db.prepare("UPDATE facts SET tier = ? WHERE id = ?").run(tier, id);
  return result.changes > 0;
}

export type TieringOptions = {
  inactivePreferenceDays: number;
  hotMaxTokens: number;
  hotMaxFacts: number;
  coldAfterInactivityDays?: number;
  hotMinAccessCount?: number;
  hotAccessWindowDays?: number;
  hotPreferenceImportance?: number;
};

export type TieringCounts = {
  hot: number;
  warm: number;
  cold: number;
  structural: number;
};

export type RetierReport = TieringCounts & {
  apply: boolean;
  examined: number;
  changed: number;
};

type TierCandidate = {
  id: string;
  tier: MemoryTier;
  text: string;
  summary: string | null;
  category: MemoryCategory | null;
  importance: number;
  key: string | null;
  value: string | null;
  decay_class: DecayClass | null;
  tags: string | null;
  recall_count: number;
  access_count: number;
  created_at: number;
  last_accessed: number | null;
  last_confirmed_at: number | null;
  preserve_until: number | null;
  preserve_tags: string | null;
};

function normalizeTieringOptions(opts: TieringOptions): Required<TieringOptions> {
  return {
    inactivePreferenceDays: opts.inactivePreferenceDays,
    hotMaxTokens: opts.hotMaxTokens,
    hotMaxFacts: opts.hotMaxFacts,
    coldAfterInactivityDays: opts.coldAfterInactivityDays ?? 30,
    hotMinAccessCount: opts.hotMinAccessCount ?? 3,
    hotAccessWindowDays: opts.hotAccessWindowDays ?? 7,
    hotPreferenceImportance: opts.hotPreferenceImportance ?? 0.7,
  };
}

function hasTag(tagsStr: string | null, tag: string): boolean {
  return parseTags(tagsStr).includes(tag.toLowerCase().trim());
}

/** JSON-array parsing for `facts.preserve_tags` (tiering + trim). */
function parsePreserveTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : [];
  } catch {
    return [];
  }
}

function isStructuralCandidate(row: TierCandidate): boolean {
  if (row.key === "implicit_feedback_signal") return false;
  // Structural tier is only for explicit key/value rows. `decay_class === "permanent"` does not
  // imply structural — permanent edicts/rules/preferences without key+value stay hot/warm/cold.
  return row.key != null && row.key.trim() !== "" && row.value != null && row.value.trim() !== "";
}

function isPinnedTierCandidate(row: TierCandidate, nowSec: number): boolean {
  const preserveTags = parsePreserveTags(row.preserve_tags);
  return (
    (row.preserve_until != null && row.preserve_until > nowSec) ||
    preserveTags.length > 0 ||
    preserveTagsColumnExcludesFromTrimSql(row.preserve_tags) ||
    hasTag(row.tags, "edict") ||
    hasTag(row.tags, "blocker")
  );
}

function isHotCandidate(
  row: TierCandidate,
  nowSec: number,
  opts: Required<TieringOptions>,
  flags?: { ignoreStructuralBlock?: boolean },
): boolean {
  if (!flags?.ignoreStructuralBlock && isStructuralCandidate(row)) return false;
  if (hasTag(row.tags, "blocker")) return true;
  if (["decision", "pattern", "rule"].includes(row.category ?? "")) return false;
  if (row.preserve_until != null && row.preserve_until > nowSec) return true;
  const lastAccess = row.last_accessed ?? row.last_confirmed_at ?? row.created_at;
  const hotWindowCutoff = nowSec - opts.hotAccessWindowDays * 86400;
  const recentlyAccessed = opts.hotAccessWindowDays === 0 || lastAccess >= hotWindowCutoff;
  const accessScore = Math.max(row.recall_count ?? 0, row.access_count ?? 0);
  if (recentlyAccessed && accessScore >= opts.hotMinAccessCount) return true;
  if (row.category === "preference" && row.importance >= opts.hotPreferenceImportance) {
    const preferenceCutoff = nowSec - opts.inactivePreferenceDays * 86400;
    const preferenceRecentlyAccessed = opts.inactivePreferenceDays === 0 || lastAccess >= preferenceCutoff;
    if (preferenceRecentlyAccessed) return true;
  }
  return false;
}

function isColdCandidate(row: TierCandidate, nowSec: number, opts: Required<TieringOptions>): boolean {
  if (isStructuralCandidate(row)) return false;
  if (row.category === "preference") return false;
  if (isHotCandidate(row, nowSec, opts)) return false;
  if (isPinnedTierCandidate(row, nowSec)) return false;
  const lastAccess = row.last_accessed ?? row.last_confirmed_at ?? row.created_at;
  const coldCutoff = nowSec - opts.coldAfterInactivityDays * 86400;
  return lastAccess < coldCutoff && (row.recall_count ?? 0) === 0 && (row.access_count ?? 0) === 0;
}

function chooseTier(row: TierCandidate, nowSec: number, opts: Required<TieringOptions>): MemoryTier {
  if (isPinnedTierCandidate(row, nowSec)) {
    if (isHotCandidate(row, nowSec, opts, { ignoreStructuralBlock: true })) return "hot";
    return "warm";
  }
  if (isHotCandidate(row, nowSec, opts, { ignoreStructuralBlock: true })) return "hot";
  if (isStructuralCandidate(row)) return "structural";
  if (isColdCandidate(row, nowSec, opts)) return "cold";
  return "warm";
}

export function retierFacts(db: DatabaseSync, opts: TieringOptions, apply = true): RetierReport {
  const normalized = normalizeTieringOptions(opts);
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT id, COALESCE(tier, 'warm') as tier, text, summary, category, importance, key, value, decay_class, tags,
              COALESCE(recall_count, 0) as recall_count, COALESCE(access_count, 0) as access_count,
              created_at, last_accessed, last_confirmed_at, preserve_until, preserve_tags
         FROM facts
         WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(nowSec) as TierCandidate[];

  const desired = rows.map((row) => ({ id: row.id, from: row.tier, to: chooseTier(row, nowSec, normalized) }));

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const hotDesired = desired
    .filter((d) => d.to === "hot")
    .map((d) => rowsById.get(d.id) as TierCandidate)
    .sort((a, b) => {
      const bScore = Math.max(b.recall_count ?? 0, b.access_count ?? 0);
      const aScore = Math.max(a.recall_count ?? 0, a.access_count ?? 0);
      if (bScore !== aScore) return bScore - aScore;
      if (b.importance !== a.importance) return b.importance - a.importance;
      const bAccess = b.last_accessed ?? b.last_confirmed_at ?? b.created_at;
      const aAccess = a.last_accessed ?? a.last_confirmed_at ?? a.created_at;
      return bAccess - aAccess;
    });
  const keepHot = new Set<string>();
  let hotTokens = 0;
  for (const row of hotDesired) {
    if (keepHot.size >= normalized.hotMaxFacts) break;
    const tokens = Math.ceil((row.summary || row.text).length / 4);
    if (hotTokens + tokens > normalized.hotMaxTokens) continue;
    hotTokens += tokens;
    keepHot.add(row.id);
  }
  for (const d of desired) {
    if (d.to === "hot" && !keepHot.has(d.id)) d.to = "warm";
  }

  const counts: RetierReport = { apply, examined: rows.length, changed: 0, hot: 0, warm: 0, cold: 0, structural: 0 };
  for (const d of desired) {
    if (d.to === "hot") counts.hot++;
    else if (d.to === "warm") counts.warm++;
    else if (d.to === "cold") counts.cold++;
    else if (d.to === "structural") counts.structural++;
    if (d.from !== d.to) counts.changed++;
  }

  if (!apply || counts.changed === 0) return counts;

  const update = db.prepare("UPDATE facts SET tier = ? WHERE id = ?");
  const tx = createTransaction(db, () => {
    for (const d of desired) {
      if (d.from !== d.to) update.run(d.to, d.id);
    }
  });
  tx();
  return counts;
}

export function runCompaction(db: DatabaseSync, opts: TieringOptions): RetierReport {
  const report = retierFacts(db, opts, true);
  return report;
}

export function trimToBudget(
  db: DatabaseSync,
  tokenBudget: number,
  simulate = false,
): {
  simulate: boolean;
  budget: number;
  beforeTokens: number;
  afterTokens: number;
  trimmed: Array<{
    id: string;
    textPreview: string;
    tier: string;
    importance: number;
    tokenCost: number;
  }>;
  preserved: Array<{ id: string; reason: string }>;
  error?: string;
} {
  const nowSec = Math.floor(Date.now() / 1000);
  const HOUR_SEC = 3600;
  const p1Cutoff = nowSec - HOUR_SEC;
  const tokenEstimate = (text: string): number => Math.ceil(text.length / 3.8);

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

  const p0: Array<{ id: string; text: string }> = [];
  const preserved: Array<{ id: string; reason: string }> = [];

  for (const row of rows) {
    const preserveTags = parsePreserveTags(row.preserve_tags);
    const tagsStr = row.tags;
    const isEdict = hasTag(tagsStr, "edict");
    const isVerified = row.is_verified === 1;
    const hasPreserveUntil = row.preserve_until != null && row.preserve_until > nowSec;
    const hasPreserveTags = preserveTags.length > 0 || preserveTagsColumnExcludesFromTrimSql(row.preserve_tags);

    if (isEdict || isVerified || hasPreserveUntil || hasPreserveTags) {
      p0.push({ id: row.id, text: row.text });
      const reasons: string[] = [];
      if (isEdict) reasons.push("edict");
      if (isVerified) reasons.push("verified");
      if (hasPreserveUntil) reasons.push(`preserveUntil=${row.preserve_until}`);
      if (hasPreserveTags) reasons.push(`preserveTags=${preserveTags.join(",")}`);
      preserved.push({ id: row.id, reason: reasons.join("|") });
    }
  }

  const trimOrderStmt = db.prepare(
    `SELECT f.id, f.text, f.importance,
              CASE
                WHEN f.importance < 0.5 THEN 0
                WHEN f.importance > 0.8 AND f.created_at >= ? THEN 2
                ELSE 1
              END AS trim_tier
       FROM facts f
       LEFT JOIN verified_facts vf ON vf.fact_id = f.id
       WHERE f.superseded_at IS NULL
         AND (f.expires_at IS NULL OR f.expires_at > ?)
         AND NOT (
           (',' || COALESCE(f.tags,'') || ',') LIKE '%,edict,%'
           OR vf.fact_id IS NOT NULL
           OR (f.preserve_until IS NOT NULL AND f.preserve_until > ?)
           OR (f.preserve_tags IS NOT NULL AND TRIM(f.preserve_tags) != '' AND f.preserve_tags != '[]')
         )
       ORDER BY trim_tier ASC, f.importance ASC, COALESCE(f.last_accessed, f.created_at) ASC, f.id ASC`,
  );
  const trimRows = trimOrderStmt.all(p1Cutoff, nowSec, nowSec) as Array<{
    id: string;
    text: string;
    importance: number;
    trim_tier: number;
  }>;

  const p0Tokens = p0.reduce((sum, f) => sum + tokenEstimate(f.text), 0);
  const trimPoolTokens = trimRows.reduce((sum, r) => sum + tokenEstimate(r.text), 0);
  const currentTokens = p0Tokens + trimPoolTokens;

  if (currentTokens <= tokenBudget) {
    const trimmed: Array<{
      id: string;
      textPreview: string;
      tier: string;
      importance: number;
      tokenCost: number;
    }> = [];
    return {
      simulate,
      budget: tokenBudget,
      beforeTokens: currentTokens,
      afterTokens: simulate ? currentTokens : currentTokens,
      trimmed,
      preserved,
    };
  }

  let remainingTokens = currentTokens;
  const toTrim = trimRows.map((r) => ({
    id: r.id,
    text: r.text,
    importance: r.importance,
    tier: r.trim_tier === 0 ? "P3" : r.trim_tier === 1 ? "P2" : "P1",
  }));

  const trimmed: Array<{
    id: string;
    textPreview: string;
    tier: string;
    importance: number;
    tokenCost: number;
  }> = [];
  for (const fact of toTrim) {
    if (remainingTokens <= tokenBudget) break;
    const cost = tokenEstimate(fact.text);
    remainingTokens -= cost;
    const preview = fact.text.length > 80 ? `${fact.text.slice(0, 80)}…` : fact.text;
    trimmed.push({
      id: fact.id,
      textPreview: preview,
      tier: fact.tier,
      importance: fact.importance,
      tokenCost: cost,
    });
    if (!simulate) {
      db.prepare("UPDATE facts SET superseded_at = ? WHERE id = ?").run(nowSec, fact.id);
      db.prepare(
        `INSERT INTO trim_metrics (trimmed_at, fact_id, fact_text_preview, tier, importance, preserve_until, token_cost, budget_before, budget_after)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        nowSec,
        fact.id,
        fact.text.slice(0, 200),
        fact.tier,
        fact.importance,
        null,
        cost,
        currentTokens,
        tokenBudget,
      );
    }
  }

  return {
    simulate,
    budget: tokenBudget,
    beforeTokens: currentTokens,
    afterTokens: remainingTokens,
    trimmed,
    preserved,
  };
}

export function setPreserveUntil(
  db: DatabaseSync,
  getById: (id: string) => MemoryEntry | null,
  id: string,
  untilSec: number | null,
): MemoryEntry | null {
  const nowSec = Math.floor(Date.now() / 1000);
  if (untilSec !== null && untilSec <= nowSec) {
    throw new Error(`preserve_until must be in the future or null. Got: ${untilSec}`);
  }
  db.prepare("UPDATE facts SET preserve_until = ? WHERE id = ?").run(untilSec, id);
  return getById(id);
}

export function setPreserveTags(
  db: DatabaseSync,
  getById: (id: string) => MemoryEntry | null,
  id: string,
  tags: string[],
  mode: "set" | "add" | "remove",
): MemoryEntry | null {
  const fact = getById(id);
  if (!fact) return null;
  const existing = fact.preserveTags ?? [];
  let next: string[];
  if (mode === "set") {
    next = [...new Set(tags.map((t) => t.toLowerCase().trim()))];
  } else if (mode === "add") {
    const s = new Set(existing);
    for (const t of tags) s.add(t.toLowerCase().trim());
    next = [...s];
  } else {
    const s = new Set(existing);
    for (const t of tags) s.delete(t.toLowerCase().trim());
    next = [...s];
  }
  const preserveTagsStr = next.length > 0 ? JSON.stringify(next) : null;
  db.prepare("UPDATE facts SET preserve_tags = ? WHERE id = ?").run(preserveTagsStr, id);
  return getById(id);
}

/** Same row filter as `pruneExpired` DELETE on `facts` (for CLI `--verbose` preview). */
export function listExpiredFactIdsPendingPrune(db: DatabaseSync): string[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT id FROM facts WHERE expires_at IS NOT NULL AND expires_at < @now
         AND (decay_freeze_until IS NULL OR decay_freeze_until <= @now)
         AND id NOT IN (SELECT fact_id FROM verified_facts)`,
    )
    .all({ "@now": nowSec }) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function pruneExpired(db: DatabaseSync): number {
  const nowSec = Math.floor(Date.now() / 1000);
  db.prepare(
    `DELETE FROM memory_links
         WHERE target_fact_id IN (
           SELECT id FROM facts WHERE expires_at IS NOT NULL AND expires_at < @now
             AND (decay_freeze_until IS NULL OR decay_freeze_until <= @now)
             AND id NOT IN (SELECT fact_id FROM verified_facts)
         )
         AND link_type != 'DERIVED_FROM'`,
  ).run({ "@now": nowSec });
  const result = db
    .prepare(
      `DELETE FROM facts WHERE expires_at IS NOT NULL AND expires_at < @now
                AND (decay_freeze_until IS NULL OR decay_freeze_until <= @now)
                AND id NOT IN (SELECT fact_id FROM verified_facts)`,
    )
    .run({ "@now": nowSec });
  return Number(result.changes ?? 0);
}

export function pruneSessionScope(db: DatabaseSync, sessionId: string): number {
  db.prepare(
    `DELETE FROM memory_links
         WHERE target_fact_id IN (
           SELECT id FROM facts WHERE scope = 'session' AND scope_target = ?
             AND id NOT IN (SELECT fact_id FROM verified_facts)
         )
         AND link_type != 'DERIVED_FROM'`,
  ).run(sessionId);
  const result = db
    .prepare(
      `DELETE FROM facts WHERE scope = 'session' AND scope_target = ?
                AND id NOT IN (SELECT fact_id FROM verified_facts)`,
    )
    .run(sessionId);
  return Number(result.changes ?? 0);
}

export function promoteScope(
  db: DatabaseSync,
  factId: string,
  newScope: "global" | "user" | "agent" | "session",
  newScopeTarget: string | null,
): boolean {
  const scopeTarget = newScope === "global" ? null : newScopeTarget;
  const result = db
    .prepare("UPDATE facts SET scope = ?, scope_target = ? WHERE id = ?")
    .run(newScope, scopeTarget, factId);
  return result.changes > 0;
}

export function decayConfidence(db: DatabaseSync): number {
  const nowSec = Math.floor(Date.now() / 1000);

  db.prepare(
    `UPDATE facts
         SET confidence = confidence * 0.5
         WHERE expires_at IS NOT NULL
           AND expires_at > @now
           AND last_confirmed_at IS NOT NULL
           AND (@now - last_confirmed_at) > (expires_at - last_confirmed_at) * 0.75
           AND confidence > 0.1
           AND (decay_freeze_until IS NULL OR decay_freeze_until <= @now)
           AND id NOT IN (SELECT fact_id FROM verified_facts)`,
  ).run({ "@now": nowSec });

  db.prepare(
    `DELETE FROM memory_links
         WHERE target_fact_id IN (
           SELECT id FROM facts WHERE confidence < 0.1
             AND (decay_freeze_until IS NULL OR decay_freeze_until <= @now)
             AND id NOT IN (SELECT fact_id FROM verified_facts)
         )
         AND link_type != 'DERIVED_FROM'`,
  ).run({ "@now": nowSec });
  const result = db
    .prepare(
      `DELETE FROM facts WHERE confidence < 0.1
                AND (decay_freeze_until IS NULL OR decay_freeze_until <= @now)
                AND id NOT IN (SELECT fact_id FROM verified_facts)`,
    )
    .run({ "@now": nowSec });
  return Number(result.changes ?? 0);
}

export function confirmFact(db: DatabaseSync, id: string): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  const row = db.prepare("SELECT decay_class FROM facts WHERE id = ?").get(id) as
    | { decay_class: DecayClass }
    | undefined;
  if (!row) return false;

  const newExpiry = calculateExpiry(row.decay_class, nowSec);
  db.prepare("UPDATE facts SET confidence = 1.0, last_confirmed_at = ?, expires_at = ? WHERE id = ?").run(
    nowSec,
    newExpiry,
    id,
  );
  return true;
}

export function saveCheckpoint(
  store: (entry: StoreFactInput) => MemoryEntry,
  context: {
    intent: string;
    state: string;
    expectedOutcome?: string;
    workingFiles?: string[];
  },
): string {
  const data = JSON.stringify({
    ...context,
    savedAt: new Date().toISOString(),
  });

  return store({
    text: data,
    category: "other" as MemoryCategory,
    importance: 0.9,
    entity: "system",
    key: `checkpoint:${Date.now()}`,
    value: context.intent.slice(0, 100),
    source: "checkpoint",
    decayClass: "checkpoint",
  }).id;
}

export function restoreCheckpoint(db: DatabaseSync): {
  id: string;
  intent: string;
  state: string;
  expectedOutcome?: string;
  workingFiles?: string[];
  savedAt: string;
} | null {
  const nowSec = Math.floor(Date.now() / 1000);
  const row = db
    .prepare(
      `SELECT id, text FROM facts
         WHERE entity = 'system' AND key LIKE 'checkpoint:%'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC LIMIT 1`,
    )
    .get(nowSec) as { id: string; text: string } | undefined;

  if (!row) return null;
  try {
    return { id: row.id, ...JSON.parse(row.text) };
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "json-parse-checkpoint",
      severity: "info",
      subsystem: "facts",
    });
    return null;
  }
}

export type LifecycleEntityReportRow = {
  pattern: "pr" | "issue" | "sprint";
  entity: string;
  count: number;
  activeCount: number;
  decayClass: string;
  expiresAt: number | null;
};

export type LifecycleEntityReport = {
  rows: LifecycleEntityReportRow[];
  totals: Record<string, number>;
};

export type ExpireBySourcePatternReport = {
  pattern: string;
  apply: boolean;
  matched: number;
  changed: number;
  decayClass: DecayClass;
  ttlDays: number;
  expiresAt: number;
};

function lifecycleEntityPattern(entity: string | null): "pr" | "issue" | "sprint" | null {
  if (!entity) return null;
  if (/^(?:pr|pull request)\s*#?\d+$/i.test(entity)) return "pr";
  if (/^issue\s*#?\d+$/i.test(entity)) return "issue";
  if (/^sprint\b/i.test(entity)) return "sprint";
  return null;
}

export function lifecycleEntityReport(db: DatabaseSync, limit = 100): LifecycleEntityReport {
  const rows = db
    .prepare(
      `SELECT entity, COALESCE(decay_class, 'normal') AS decay_class, expires_at,
              COUNT(*) AS cnt,
              SUM(CASE WHEN superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?) THEN 1 ELSE 0 END) AS active_cnt
         FROM facts
        WHERE entity IS NOT NULL
          AND TRIM(entity) != ''
          AND (
            entity GLOB 'PR #*' OR
            entity GLOB 'pr #*' OR
            entity GLOB 'Issue #*' OR
            entity GLOB 'issue #*' OR
            entity GLOB 'Sprint *' OR
            entity GLOB 'sprint *' OR
            entity GLOB 'Pull Request #*' OR
            entity GLOB 'pull request #*'
          )
        GROUP BY entity, COALESCE(decay_class, 'normal'), expires_at
        ORDER BY cnt DESC, entity COLLATE NOCASE ASC
        LIMIT ?`,
    )
    .all(Math.floor(Date.now() / 1000), Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{
    entity: string;
    decay_class: string;
    expires_at: number | null;
    cnt: number;
    active_cnt: number;
  }>;
  const filtered = rows
    .map((row) => {
      const pattern = lifecycleEntityPattern(row.entity);
      if (pattern === null) return null;
      return {
        pattern,
        entity: row.entity,
        count: Number(row.cnt ?? 0),
        activeCount: Number(row.active_cnt ?? 0),
        decayClass: row.decay_class,
        expiresAt: row.expires_at == null ? null : Number(row.expires_at),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const totals = filtered.reduce(
    (acc, row) => {
      acc[row.pattern] = (acc[row.pattern] ?? 0) + row.count;
      return acc;
    },
    {} as Record<string, number>,
  );
  return { rows: filtered, totals };
}

function globToSqlLike(pattern: string): string {
  return pattern
    .replace(/[~%_]/g, (m) => `~${m}`)
    .replace(/\*/g, "%")
    .replace(/\?/g, "_");
}

export function expireBySourcePattern(
  db: DatabaseSync,
  options: {
    pattern: string;
    ttlDays: number;
    decayClass?: DecayClass;
    apply?: boolean;
    nowSec?: number;
  },
): ExpireBySourcePatternReport {
  const pattern = options.pattern.trim();
  const ttlDays = Math.max(1, Math.floor(options.ttlDays));
  const decayClass = options.decayClass ?? "short";
  const apply = options.apply === true;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + ttlDays * 24 * 3600;
  const like = globToSqlLike(pattern);
  const matched = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM facts
            WHERE entity LIKE ? ESCAPE '~'
              AND superseded_at IS NULL`,
        )
        .get(like) as { cnt: number } | undefined
    )?.cnt ?? 0,
  );
  const changed = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM facts
            WHERE entity LIKE ? ESCAPE '~'
              AND superseded_at IS NULL
              AND (COALESCE(decay_class, 'normal') != ? OR COALESCE(expires_at, 0) != ?)`,
        )
        .get(like, decayClass, expiresAt) as { cnt: number } | undefined
    )?.cnt ?? 0,
  );
  if (apply && changed > 0) {
    db.prepare(
      `UPDATE facts
          SET decay_class = ?, expires_at = ?
        WHERE entity LIKE ? ESCAPE '~'
          AND superseded_at IS NULL
          AND (COALESCE(decay_class, 'normal') != ? OR COALESCE(expires_at, 0) != ?)`,
    ).run(decayClass, expiresAt, like, decayClass, expiresAt);
  }
  return { pattern, apply, matched, changed, decayClass, ttlDays, expiresAt };
}

export type DecayReclassifyOptions = {
  apply?: boolean;
  stableOnly?: boolean;
  limit?: number;
  nowSec?: number;
  inactiveDays?: number;
  promoteRecallCount?: number;
};

export type DecayReclassifyReport = {
  apply: boolean;
  scanned: number;
  changed: number;
  before: Record<string, number>;
  after: Record<string, number>;
  changes: Record<string, number>;
  stablePermanentBefore: number;
  stablePermanentAfter: number;
  stablePermanentRatioBefore: number;
  stablePermanentRatioAfter: number;
};

function incrementCount(counts: Record<string, number>, key: string, delta = 1): void {
  counts[key] = (counts[key] ?? 0) + delta;
  if (counts[key] === 0) delete counts[key];
}

function decayDistribution(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT COALESCE(decay_class, 'normal') as decay_class, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY COALESCE(decay_class, 'normal')",
    )
    .all() as Array<{ decay_class: string; cnt: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.decay_class] = row.cnt;
  return out;
}

function stablePermanentStats(counts: Record<string, number>): { count: number; ratio: number } {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const count = (counts.stable ?? 0) + (counts.permanent ?? 0);
  return { count, ratio: total > 0 ? count / total : 0 };
}

function reinforcedDecayClass(
  base: DecayClass,
  row: {
    category: string | null;
    source: string | null;
    created_at: number;
    last_accessed: number | null;
    recall_count: number | null;
    access_count: number | null;
  },
  opts: Required<Pick<DecayReclassifyOptions, "nowSec" | "inactiveDays" | "promoteRecallCount">>,
): DecayClass {
  const recallCount = row.recall_count ?? 0;
  const accessCount = row.access_count ?? 0;
  const lastAccessed = row.last_accessed ?? 0;
  const lastUse = Math.max(lastAccessed, row.created_at);
  const ageSeconds = Math.max(0, opts.nowSec - row.created_at);
  const inactiveSeconds = Math.max(0, opts.nowSec - lastUse);
  const protectedCategory = ["rule", "edict"].includes((row.category ?? "").toLowerCase());
  const seedSource = (row.source ?? "").toLowerCase().startsWith("seed:");

  if (recallCount >= opts.promoteRecallCount || accessCount >= opts.promoteRecallCount) {
    if (["short", "normal", "active"].includes(base)) return "durable";
    if (["session", "checkpoint", "ephemeral"].includes(base)) return "normal";
  }

  if (!protectedCategory && !seedSource && base !== "permanent" && recallCount === 0 && accessCount === 0) {
    if (ageSeconds >= opts.inactiveDays * 86_400 && inactiveSeconds >= opts.inactiveDays * 86_400) return "short";
  }

  return base;
}

export function reclassifyDecayClasses(db: DatabaseSync, options: DecayReclassifyOptions = {}): DecayReclassifyReport {
  const apply = options.apply === true;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const inactiveDays = options.inactiveDays ?? 90;
  const promoteRecallCount = options.promoteRecallCount ?? 3;
  const stableOnly = options.stableOnly === true;
  const limit = options.limit != null && options.limit > 0 ? Math.floor(options.limit) : null;
  const where = stableOnly ? "WHERE superseded_at IS NULL AND decay_class = 'stable'" : "WHERE superseded_at IS NULL";
  const sql = `SELECT rowid, entity, key, value, text, source, category, importance, decay_class, created_at, last_accessed, recall_count, access_count FROM facts ${where} ORDER BY created_at ASC${limit ? ` LIMIT ${limit}` : ""}`;
  const rows = db.prepare(sql).all() as Array<{
    rowid: number;
    entity: string | null;
    key: string | null;
    value: string | null;
    text: string;
    source: string | null;
    category: string | null;
    importance: number | null;
    decay_class: DecayClass;
    created_at: number;
    last_accessed: number | null;
    recall_count: number | null;
    access_count: number | null;
  }>;

  const before = decayDistribution(db);
  const after = { ...before };
  const changes: Record<string, number> = {};
  let changed = 0;
  const update = db.prepare("UPDATE facts SET decay_class = ?, expires_at = ? WHERE rowid = ?");

  const run = () => {
    for (const row of rows) {
      const base = classifyDecay(row.entity, row.key, row.value, row.text, {
        source: row.source,
        category: row.category,
        importance: row.importance,
      });
      const next = reinforcedDecayClass(base, row, { nowSec, inactiveDays, promoteRecallCount });
      const current = row.decay_class ?? "normal";
      if (next === current) continue;
      changed++;
      incrementCount(after, current, -1);
      incrementCount(after, next, 1);
      incrementCount(changes, `${current}->${next}`);
      if (apply) update.run(next, calculateExpiry(next, nowSec), row.rowid);
    }
  };

  if (apply) createTransaction(db, run)();
  else run();

  const beforeStats = stablePermanentStats(before);
  const afterStats = stablePermanentStats(after);
  return {
    apply,
    scanned: rows.length,
    changed,
    before,
    after,
    changes,
    stablePermanentBefore: beforeStats.count,
    stablePermanentAfter: afterStats.count,
    stablePermanentRatioBefore: beforeStats.ratio,
    stablePermanentRatioAfter: afterStats.ratio,
  };
}

export function backfillDecayClasses(db: DatabaseSync): Record<string, number> {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      "SELECT rowid, entity, key, value, text, source, category, importance, decay_class FROM facts WHERE superseded_at IS NULL AND decay_class = 'stable' ORDER BY created_at ASC",
    )
    .all() as Array<{
    rowid: number;
    entity: string | null;
    key: string | null;
    value: string | null;
    text: string;
    source: string | null;
    category: string | null;
    importance: number | null;
    decay_class: DecayClass;
  }>;

  const counts: Record<string, number> = {};
  const update = db.prepare("UPDATE facts SET decay_class = ?, expires_at = ? WHERE rowid = ?");

  const run = () => {
    for (const row of rows) {
      const next = classifyDecay(row.entity, row.key, row.value, row.text, {
        source: row.source,
        category: row.category,
        importance: row.importance,
      });
      const current = row.decay_class ?? "normal";
      if (next === current) continue;
      counts[next] = (counts[next] ?? 0) + 1;
      update.run(next, calculateExpiry(next, nowSec), row.rowid);
    }
  };

  createTransaction(db, run)();
  return counts;
}
