/**
 * Compaction, pruning, tiering, checkpoints, recall log (Issue #954).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { DecayClass, MemoryCategory } from "../../config.js";
import { capturePluginError } from "../../services/error-reporter.js";
import type { MemoryEntry, MemoryTier } from "../../types/memory.js";
import { calculateExpiry } from "../../utils/decay.js";
import { parseTags } from "../../utils/tags.js";
import type { StoreFactInput } from "./crud.js";

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

export function runCompaction(
  db: DatabaseSync,
  opts: {
    inactivePreferenceDays: number;
    hotMaxTokens: number;
    hotMaxFacts: number;
  },
): {
  hot: number;
  warm: number;
  cold: number;
} {
  const nowSec = Math.floor(Date.now() / 1000);
  const inactiveCutoff = nowSec - opts.inactivePreferenceDays * 86400;
  const counts = { hot: 0, warm: 0, cold: 0 };

  const taskRows = db
    .prepare(
      `SELECT id FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND (category = 'decision' OR (',' || COALESCE(tags,'') || ',') LIKE '%,task,%')
         AND (tier IS NULL OR tier != 'cold')`,
    )
    .all(nowSec) as Array<{ id: string }>;
  for (const { id } of taskRows) {
    if (setFactTier(db, id, "cold")) counts.cold++;
  }

  const prefRows = db
    .prepare(
      `SELECT id FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND category = 'preference' AND COALESCE(last_accessed, last_confirmed_at, created_at) < ?
         AND tier = 'hot'`,
    )
    .all(nowSec, inactiveCutoff) as Array<{ id: string }>;
  for (const { id } of prefRows) {
    if (setFactTier(db, id, "warm")) counts.warm++;
  }

  const existingHotBlockerRows = db
    .prepare(
      `SELECT id FROM facts WHERE tier = 'hot' AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND (',' || COALESCE(tags,'') || ',') LIKE '%,blocker,%'`,
    )
    .all(nowSec) as Array<{ id: string }>;
  const allBlockerIdSet = new Set(existingHotBlockerRows.map((r) => r.id));

  const blockerRows = db
    .prepare(
      `SELECT id, text, summary FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND (',' || COALESCE(tags,'') || ',') LIKE '%,blocker,%'
         AND (tier IS NULL OR tier != 'hot')`,
    )
    .all(nowSec) as Array<{
    id: string;
    text: string;
    summary: string | null;
  }>;
  let hotTokens = 0;
  const hotIds: string[] = [];
  for (const row of blockerRows) {
    if (hotIds.length >= opts.hotMaxFacts) break;
    const len = (row.summary || row.text).length;
    const tokens = Math.ceil(len / 4);
    if (hotTokens + tokens > opts.hotMaxTokens) continue;
    hotTokens += tokens;
    hotIds.push(row.id);
  }
  for (const id of hotIds) {
    allBlockerIdSet.add(id);
    if (setFactTier(db, id, "hot")) counts.hot++;
  }

  const hotRows = db
    .prepare(
      `SELECT id FROM facts WHERE tier = 'hot' AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(nowSec) as Array<{ id: string }>;
  for (const { id } of hotRows) {
    if (allBlockerIdSet.has(id)) continue;
    if (setFactTier(db, id, "warm")) counts.warm++;
  }

  return counts;
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

  const p0: Array<{ id: string; text: string }> = [];
  const preserved: Array<{ id: string; reason: string }> = [];

  for (const row of rows) {
    const preserveTags = parsePreserveTags(row.preserve_tags);
    const tagsStr = row.tags;
    const isEdict = hasTag(tagsStr, "edict");
    const isVerified = row.is_verified === 1;
    const hasPreserveUntil = row.preserve_until != null && row.preserve_until > nowSec;
    const hasPreserveTags = preserveTags.length > 0;

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
