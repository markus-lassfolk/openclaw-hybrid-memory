/**
 * Contradiction detection and resolution (Issue #157) (Issue #954 split).
 * Project-state latest-wins (LWW) policy added in Issue #1636.
 */
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

import { capturePluginError } from "../../services/error-reporter.js";
import type { MemoryEntry } from "../../types/memory.js";
import { createTransaction } from "../../utils/sqlite-transaction.js";
import { nowIso } from "../../utils/dates.js";
import { parseTags, serializeTags } from "../../utils/tags.js";
import { rowToMemoryEntry } from "./row-mapper.js";
import type { MemoryLinkType } from "./types.js";

export interface ContradictionDetectionResult {
  contradictionId: string;
  oldFactId: string;
  oldFactOriginalConfidence: number;
  score: number;
  heuristicSignals: string[];
  preview: string;
}

const NEGATION_PATTERN = /\b(not|no|never|without|disable|stop|don't|dont)\b/gi;
const NUMERIC_PATTERN = /(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|min|minutes|h|hours|days|%)?/gi;

function truncatePreview(text: string, maxLen = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= maxLen ? t : `${t.slice(0, maxLen - 1)}…`;
}

/** Heuristic contradiction scoring when entity+key match (Issue #1902). */
export function scoreFactContradiction(
  newText: string,
  newValue: string,
  oldText: string,
  oldValue: string,
): { score: number; heuristicSignals: string[] } {
  const signals: string[] = [];
  let score = 0;

  const newNeg = (newText.match(NEGATION_PATTERN) ?? []).length + (newValue.match(NEGATION_PATTERN) ?? []).length;
  const oldNeg = (oldText.match(NEGATION_PATTERN) ?? []).length + (oldValue.match(NEGATION_PATTERN) ?? []).length;
  if (newNeg !== oldNeg && (newNeg > 0 || oldNeg > 0)) {
    signals.push("negation_token_mismatch");
    score += 0.35;
  }

  const newNums = [...`${newText} ${newValue}`.matchAll(NUMERIC_PATTERN)].map((m) => m[0]);
  const oldNums = [...`${oldText} ${oldValue}`.matchAll(NUMERIC_PATTERN)].map((m) => m[0]);
  if (newNums.length > 0 && oldNums.length > 0) {
    const overlap = newNums.some((n) => oldNums.includes(n));
    if (!overlap && newNums.join() !== oldNums.join()) {
      signals.push("numeric_conflict");
      score += 0.3;
    }
  }

  const newBool = /\b(true|false|enabled|disabled|yes|no)\b/i.test(newValue);
  const oldBool = /\b(true|false|enabled|disabled|yes|no)\b/i.test(oldValue);
  if (newBool && oldBool && newValue.toLowerCase() !== oldValue.toLowerCase()) {
    signals.push("polarity_mismatch");
    score += 0.25;
  }

  if (oldValue.trim().toLowerCase() !== newValue.trim().toLowerCase()) {
    score += 0.2;
    signals.push("value_mismatch");
  }

  return { score: Math.min(1, score), heuristicSignals: signals };
}

export interface ContradictionRecord {
  id: string;
  factIdNew: string;
  factIdOld: string;
  detectedAt: string;
  resolved: boolean;
  resolution: "superseded" | "kept" | "merged" | null;
  oldFactOriginalConfidence?: number;
}

export function updateConfidence(db: DatabaseSync, id: string, delta: number): number | null {
  const row = db.prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as { confidence: number } | undefined;
  if (!row) return null;
  const current = row.confidence ?? 1.0;
  const updated = Math.max(0.1, Math.min(1.0, current + delta));
  db.prepare("UPDATE facts SET confidence = ? WHERE id = ?").run(updated, id);
  return updated;
}

export function setConfidenceTo(db: DatabaseSync, id: string, value: number): number | null {
  const row = db.prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as { confidence: number } | undefined;
  if (!row) return null;
  const updated = Math.max(0.1, Math.min(1, value));
  db.prepare("UPDATE facts SET confidence = ? WHERE id = ?").run(updated, id);
  return updated;
}

export function addTag(db: DatabaseSync, id: string, tag: string): void {
  const trimmed = tag.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized || normalized.includes(",")) return;
  const row = db.prepare("SELECT tags FROM facts WHERE id = ?").get(id) as { tags: string | null } | undefined;
  if (!row) return;
  const tags = parseTags(row.tags);
  if (tags.some((t) => t.toLowerCase() === normalized)) return;
  tags.push(normalized);
  db.prepare("UPDATE facts SET tags = ? WHERE id = ?").run(serializeTags(tags), id);
}

export function findConflictingFacts(
  db: DatabaseSync,
  entity: string,
  key: string,
  value: string,
  excludeFactId: string,
  scope?: string | null,
  scopeTarget?: string | null,
): MemoryEntry[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const scopeClause = scope
    ? scopeTarget != null
      ? "AND scope = ? AND scope_target = ?"
      : "AND scope = ? AND scope_target IS NULL"
    : "";
  const baseParams: SQLInputValue[] = [entity, key, value, excludeFactId, nowSec];
  const scopeParams: SQLInputValue[] = scope ? (scopeTarget != null ? [scope, scopeTarget] : [scope]) : [];
  const rows = db
    .prepare(
      `SELECT * FROM facts
         WHERE lower(entity) = lower(?)
           AND lower(key) = lower(?)
           AND lower(value) != lower(?)
           AND id != ?
           AND superseded_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           ${scopeClause}
         ORDER BY created_at DESC`,
    )
    .all(...baseParams, ...scopeParams) as Array<Record<string, unknown>>;
  return rows.map((r) => rowToMemoryEntry(r));
}

export function contradictionPairExists(db: DatabaseSync, factIdA: string, factIdB: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM contradictions
       WHERE resolved = 0
         AND (
           (fact_id_new = ? AND fact_id_old = ?)
           OR (fact_id_new = ? AND fact_id_old = ?)
         )
       LIMIT 1`,
    )
    .get(factIdA, factIdB, factIdB, factIdA);
  return row != null;
}

export function recordContradiction(
  db: DatabaseSync,
  factIdNew: string,
  factIdOld: string,
  createLink: (a: string, b: string, t: MemoryLinkType, s?: number) => string,
  meta?: { score?: number; heuristicSignals?: string[] },
): { id: string; oldFactOriginalConfidence: number } {
  if (contradictionPairExists(db, factIdNew, factIdOld)) {
    const row = db
      .prepare(
        `SELECT id, old_fact_original_confidence FROM contradictions
         WHERE resolved = 0
           AND (
             (fact_id_new = ? AND fact_id_old = ?)
             OR (fact_id_new = ? AND fact_id_old = ?)
           )
         LIMIT 1`,
      )
      .get(factIdNew, factIdOld, factIdOld, factIdNew) as
      | { id: string; old_fact_original_confidence: number | null }
      | undefined;
    return {
      id: row?.id ?? factIdNew,
      oldFactOriginalConfidence: row?.old_fact_original_confidence ?? 1.0,
    };
  }

  const id = randomUUID();
  const detectedAt = nowIso();
  let oldFactOriginalConfidence = 1.0;

  const tx = createTransaction(db, () => {
    const oldFactRow = db.prepare("SELECT confidence FROM facts WHERE id = ?").get(factIdOld) as
      | { confidence: number }
      | undefined;
    oldFactOriginalConfidence = oldFactRow?.confidence ?? 1.0;

    db.prepare(
      `INSERT INTO contradictions (id, fact_id_new, fact_id_old, detected_at, resolved, resolution, old_fact_original_confidence, heuristic_score, heuristic_signals)
           VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
    ).run(
      id,
      factIdNew,
      factIdOld,
      detectedAt,
      oldFactOriginalConfidence,
      meta?.score ?? null,
      meta?.heuristicSignals?.length ? JSON.stringify(meta.heuristicSignals) : null,
    );

    createLink(factIdNew, factIdOld, "CONTRADICTS", 1.0);

    updateConfidence(db, factIdOld, -0.2);
  });
  tx();
  return { id, oldFactOriginalConfidence };
}

export function detectContradictions(
  db: DatabaseSync,
  newFactId: string,
  entity: string | null | undefined,
  key: string | null | undefined,
  value: string | null | undefined,
  scope: string | null | undefined,
  scopeTarget: string | null | undefined,
  createLink: (a: string, b: string, t: MemoryLinkType, s?: number) => string,
  newText?: string | null,
): ContradictionDetectionResult[] {
  if (!entity?.trim() || !key?.trim() || !value?.trim()) return [];

  // BEGIN IMMEDIATE serializes cross-process writers so post-insert reads see committed peers.
  db.exec("BEGIN IMMEDIATE");
  try {
    const conflicting = findConflictingFacts(
      db,
      entity.trim(),
      key.trim(),
      value.trim(),
      newFactId,
      scope,
      scopeTarget,
    );
    const results: ContradictionDetectionResult[] = [];

    for (const old of conflicting) {
      if (old.value?.toLowerCase() === value.trim().toLowerCase()) continue;
      const { score, heuristicSignals } = scoreFactContradiction(
        newText ?? value.trim(),
        value.trim(),
        old.text ?? "",
        old.value ?? "",
      );
      const contradiction = recordContradiction(db, newFactId, old.id, createLink, { score, heuristicSignals });
      results.push({
        contradictionId: contradiction.id,
        oldFactId: old.id,
        oldFactOriginalConfidence: contradiction.oldFactOriginalConfidence,
        score,
        heuristicSignals,
        preview: truncatePreview(old.text ?? old.value ?? ""),
      });
    }

    db.exec("COMMIT");
    return results;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Nightly repair: ensure active same entity+key groups with differing values have contradiction rows. */
export type ContradictionRepairResult = {
  groupsScanned: number;
  pairsRepaired: number;
  /** Pairs fixed via store-time detectContradictions after direct insert failed. */
  pairsFallback: number;
  /** Pairs still missing after primary + fallback; retried next dream cycle. */
  pairsFailed: number;
};

export function repairUndetectedContradictions(
  db: DatabaseSync,
  createLink: (a: string, b: string, t: MemoryLinkType, s?: number) => string,
  limitGroups = 200,
): ContradictionRepairResult {
  const groups = db
    .prepare(
      `SELECT lower(entity) AS entity_l, lower(key) AS key_l, scope, scope_target, COUNT(*) AS cnt
       FROM facts
       WHERE superseded_at IS NULL
         AND entity IS NOT NULL AND trim(entity) != ''
         AND key IS NOT NULL AND trim(key) != ''
       GROUP BY entity_l, key_l, scope, scope_target
       HAVING cnt > 1
       ORDER BY cnt DESC
       LIMIT ?`,
    )
    .all(limitGroups) as Array<{
    entity_l: string;
    key_l: string;
    scope: string;
    scope_target: string | null;
    cnt: number;
  }>;

  let pairsRepaired = 0;
  let pairsFallback = 0;
  let pairsFailed = 0;
  for (const group of groups) {
    const facts = db
      .prepare(
        `SELECT id, text, value, scope, scope_target FROM facts
         WHERE superseded_at IS NULL
           AND lower(entity) = ?
           AND lower(key) = ?
           AND scope = ?
           AND ((scope_target IS NULL AND ? IS NULL) OR scope_target = ?)
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .all(group.entity_l, group.key_l, group.scope, group.scope_target, group.scope_target) as Array<{
      id: string;
      text: string;
      value: string | null;
      scope: string;
      scope_target: string | null;
    }>;

    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const newer = facts[i]!;
        const older = facts[j]!;
        if ((newer.value ?? "").trim().toLowerCase() === (older.value ?? "").trim().toLowerCase()) continue;
        if (contradictionPairExists(db, newer.id, older.id)) continue;
        const { score, heuristicSignals } = scoreFactContradiction(
          newer.text ?? newer.value ?? "",
          newer.value ?? "",
          older.text ?? "",
          older.value ?? "",
        );
        try {
          recordContradiction(db, newer.id, older.id, createLink, { score, heuristicSignals });
          pairsRepaired++;
        } catch {
          try {
            const hits = detectContradictions(
              db,
              newer.id,
              group.entity_l,
              group.key_l,
              newer.value ?? "",
              newer.scope,
              newer.scope_target,
              createLink,
              newer.text,
            );
            if (hits.some((h) => h.oldFactId === older.id)) {
              pairsRepaired++;
              pairsFallback++;
            } else if (hits.length > 0) {
              pairsRepaired++;
              pairsFallback++;
            } else {
              pairsFailed++;
            }
          } catch {
            pairsFailed++;
          }
        }
      }
    }
  }

  return { groupsScanned: groups.length, pairsRepaired, pairsFallback, pairsFailed };
}

export function getContradictions(db: DatabaseSync, factId?: string): ContradictionRecord[] {
  const rows = factId
    ? (db
        .prepare("SELECT * FROM contradictions WHERE fact_id_new = ? OR fact_id_old = ? ORDER BY detected_at DESC")
        .all(factId, factId) as Array<Record<string, unknown>>)
    : (db.prepare("SELECT * FROM contradictions WHERE resolved = 0 ORDER BY detected_at DESC").all() as Array<
        Record<string, unknown>
      >);
  return rows.map((r) => ({
    id: r.id as string,
    factIdNew: r.fact_id_new as string,
    factIdOld: r.fact_id_old as string,
    detectedAt: r.detected_at as string,
    resolved: (r.resolved as number) === 1,
    resolution: (r.resolution as "superseded" | "kept" | "merged" | null) ?? null,
    oldFactOriginalConfidence:
      r.old_fact_original_confidence == null ? undefined : (r.old_fact_original_confidence as number),
  }));
}

export function resolveContradiction(
  db: DatabaseSync,
  contradictionId: string,
  resolution: "superseded" | "kept" | "merged",
): boolean {
  const result = db
    .prepare("UPDATE contradictions SET resolved = 1, resolution = ?, resolved_at = ? WHERE id = ? AND resolved = 0")
    .run(resolution, nowIso(), contradictionId);
  return result.changes > 0;
}

export function isContradicted(db: DatabaseSync, factId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM contradictions WHERE (fact_id_old = ? OR fact_id_new = ?) AND resolved = 0 LIMIT 1")
    .get(factId, factId);
  return row != null;
}

export function getContradictedIds(db: DatabaseSync, factIds: string[]): Set<string> {
  if (factIds.length === 0) return new Set();
  const result = new Set<string>();
  const CHUNK = 499;
  for (let i = 0; i < factIds.length; i += CHUNK) {
    const chunk = factIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT fact_id_old AS id FROM contradictions WHERE fact_id_old IN (${placeholders}) AND resolved = 0
           UNION
           SELECT fact_id_new AS id FROM contradictions WHERE fact_id_new IN (${placeholders}) AND resolved = 0`,
      )
      .all(...chunk, ...chunk) as Array<{ id: string }>;
    for (const r of rows) result.add(r.id);
  }
  return result;
}

export function isFactVerified(db: DatabaseSync, factId: string): boolean {
  const row = db.prepare("SELECT 1 FROM verified_facts WHERE fact_id = ? LIMIT 1").get(factId);
  return row != null;
}

function isAutoResolvableContradiction(
  db: DatabaseSync,
  contradiction: ContradictionRecord,
  newFact: MemoryEntry,
  oldFact: MemoryEntry,
): boolean {
  const newConf = newFact.confidence ?? 1.0;
  const oldConf = contradiction.oldFactOriginalConfidence ?? oldFact.confidence ?? 1.0;
  const newIsNewer = newFact.createdAt >= oldFact.createdAt;
  const newIsHigherConf = newConf > oldConf;
  const newIsFromUser = newFact.source === "conversation" || newFact.source === "cli";

  if (!(newIsNewer && newIsHigherConf && newIsFromUser)) return false;
  if (oldFact.supersededAt != null) return true;
  return !isFactVerified(db, contradiction.factIdOld);
}

type AutoResolutionDecision =
  | { autoResolvable: false }
  | {
      autoResolvable: true;
      resolution: "superseded" | "kept";
      requiresSupersede: boolean;
    };

function getAutoResolutionDecision(
  db: DatabaseSync,
  contradiction: ContradictionRecord,
  newFact: MemoryEntry | null,
  oldFact: MemoryEntry | null,
): AutoResolutionDecision {
  if (!newFact && !oldFact) {
    return { autoResolvable: true, resolution: "superseded", requiresSupersede: false };
  }
  if (!newFact && oldFact) {
    return { autoResolvable: true, resolution: "kept", requiresSupersede: false };
  }
  if (newFact && !oldFact) {
    return { autoResolvable: true, resolution: "superseded", requiresSupersede: false };
  }
  if (!newFact || !oldFact) return { autoResolvable: false };
  if (!isAutoResolvableContradiction(db, contradiction, newFact, oldFact)) {
    return { autoResolvable: false };
  }
  return {
    autoResolvable: true,
    resolution: "superseded",
    requiresSupersede: oldFact.supersededAt == null,
  };
}

export function previewResolveContradictionsAuto(
  db: DatabaseSync,
  getById: (id: string) => MemoryEntry | null,
): {
  autoResolvable: Array<{
    contradictionId: string;
    factIdNew: string;
    factIdOld: string;
  }>;
  ambiguous: Array<{
    contradictionId: string;
    factIdNew: string;
    factIdOld: string;
  }>;
} {
  const unresolved = getContradictions(db);
  const autoResolvable: Array<{
    contradictionId: string;
    factIdNew: string;
    factIdOld: string;
  }> = [];
  const ambiguous: Array<{
    contradictionId: string;
    factIdNew: string;
    factIdOld: string;
  }> = [];

  for (const c of unresolved) {
    const newFact = getById(c.factIdNew);
    const oldFact = getById(c.factIdOld);
    const decision = getAutoResolutionDecision(db, c, newFact, oldFact);
    if (decision.autoResolvable) {
      autoResolvable.push({
        contradictionId: c.id,
        factIdNew: c.factIdNew,
        factIdOld: c.factIdOld,
      });
    } else {
      ambiguous.push({
        contradictionId: c.id,
        factIdNew: c.factIdNew,
        factIdOld: c.factIdOld,
      });
    }
  }

  return { autoResolvable, ambiguous };
}

export function resolveContradictionsAuto(
  db: DatabaseSync,
  getById: (id: string) => MemoryEntry | null,
  supersede: (oldId: string, newId: string | null) => boolean,
): {
  autoResolved: Array<{
    contradictionId: string;
    factIdNew: string;
    factIdOld: string;
  }>;
  ambiguous: Array<{
    contradictionId: string;
    factIdNew: string;
    factIdOld: string;
  }>;
} {
  const unresolved = getContradictions(db);
  const autoResolved: Array<{
    contradictionId: string;
    factIdNew: string;
    factIdOld: string;
  }> = [];
  const ambiguous: Array<{
    contradictionId: string;
    factIdNew: string;
    factIdOld: string;
  }> = [];

  for (const c of unresolved) {
    const newFact = getById(c.factIdNew);
    const oldFact = getById(c.factIdOld);
    const decision = getAutoResolutionDecision(db, c, newFact, oldFact);
    if (!decision.autoResolvable) {
      ambiguous.push({
        contradictionId: c.id,
        factIdNew: c.factIdNew,
        factIdOld: c.factIdOld,
      });
      continue;
    }

    if (decision.requiresSupersede) {
      const superseded = supersede(c.factIdOld, c.factIdNew);
      if (!superseded) {
        ambiguous.push({
          contradictionId: c.id,
          factIdNew: c.factIdNew,
          factIdOld: c.factIdOld,
        });
        continue;
      }
    }

    resolveContradiction(db, c.id, decision.resolution);
    if (decision.resolution === "kept" && c.oldFactOriginalConfidence != null) {
      db.prepare("UPDATE facts SET confidence = ? WHERE id = ?").run(c.oldFactOriginalConfidence, c.factIdOld);
    }
    autoResolved.push({
      contradictionId: c.id,
      factIdNew: c.factIdNew,
      factIdOld: c.factIdOld,
    });
  }

  return { autoResolved, ambiguous };
}

// ---------------------------------------------------------------------------
// Project-state latest-wins (LWW) policy (Issue #1636)
// ---------------------------------------------------------------------------

/**
 * Mutable project/task state keys eligible for the latest-wins policy.
 *
 * Each key represents a "current-state snapshot" — a single mutable fact whose
 * value is completely replaced when new information arrives (e.g. `status` moves
 * from `in_progress` to `done`; `next` is replaced with a new action item).
 * These differ from append-style project facts (e.g. decisions, milestones) where
 * both old and new values may independently hold — those must go through manual
 * contradiction review instead.
 */
export const PROJECT_STATE_LWW_KEYS: ReadonlySet<string> = new Set([
  "status",
  "next",
  "task_updated",
  "related_session",
  "coverage",
  "last_live_verified_at",
  "live_state_hash",
  "last_actionable_blocker",
  "owner",
]);

/**
 * Sources trusted for project-state LWW resolution.
 * `distillation` is excluded by default to keep automated distilled facts conservative.
 */
export const PROJECT_STATE_LWW_TRUSTED_SOURCES: ReadonlySet<string> = new Set([
  "conversation",
  "cli",
  "active-task",
  "tool",
]);

/** A single candidate contradiction eligible for project-state LWW resolution. */
export interface ProjectStateLwwCandidate {
  contradictionId: string;
  factIdNew: string;
  factIdOld: string;
  entity: string;
  key: string;
  scope: string | null;
  scopeTarget: string | null;
  /** epoch seconds */
  newFactDate: number;
  /** epoch seconds */
  oldFactDate: number;
  newSource: string;
  oldSource: string;
  newConf: number;
  oldConf: number;
  newValueExcerpt: string;
  oldValueExcerpt: string;
  /** `supersede`: LWW policy applies — newer trusted fact wins. `manual-review`: skipped by LWW. */
  action: "supersede" | "manual-review";
  /** True when the entity/key pair appears to have been reused for follow-up work. */
  possibleOverloadedEntity: boolean;
}

/** Grouped result of a project-state LWW resolution pass. */
export interface ProjectStateLwwResult {
  groups: Array<{
    entity: string;
    key: string;
    scope: string | null;
    scopeTarget: string | null;
    candidates: ProjectStateLwwCandidate[];
  }>;
  totalCandidates: number;
  wouldSupersede: number;
  wouldManualReview: number;
  /** Number of contradictions actually resolved (0 in dry-run). */
  applied: number;
}

/**
 * Distinct PR/issue reference count threshold above which an entity is considered
 * "possibly overloaded" (i.e. the same entity key was reused across follow-up work).
 * Pairs above this threshold are still reported but flagged for human review.
 */
const MAX_EXPECTED_REFS_PER_ENTITY = 2;

/** Extract distinct PR/issue ref numbers like `#1234` from text. */
function extractRefNumbers(text: string): Set<string> {
  const matches = text.match(/#\d+/g);
  return new Set(matches ?? []);
}

/** Heuristic: flag if multiple distinct PR/issue numbers appear across the two facts. */
function isPossiblyOverloadedEntity(newFact: MemoryEntry, oldFact: MemoryEntry): boolean {
  const combined = `${newFact.value ?? ""} ${newFact.text ?? ""} ${oldFact.value ?? ""} ${oldFact.text ?? ""}`;
  const refs = extractRefNumbers(combined);
  return refs.size > MAX_EXPECTED_REFS_PER_ENTITY;
}

function truncateExcerpt(s: string, maxLen: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= maxLen ? t : `${t.slice(0, maxLen - 1)}…`;
}

/**
 * Resolve stale project-state contradictions using a latest-wins policy.
 *
 * Eligible pairs must satisfy all of:
 * - Both facts are category `project`
 * - The key (case-insensitive) is in {@link PROJECT_STATE_LWW_KEYS}
 * - The newer fact's source is in {@link PROJECT_STATE_LWW_TRUSTED_SOURCES}
 * - The newer fact is strictly newer (`createdAt >` older)
 * - The newer fact's confidence ≥ the older fact's original confidence
 *
 * In dry-run mode no mutations are made; results describe what would happen.
 * In apply mode, qualifying contradictions are resolved as `superseded` and
 * the older fact is marked superseded with provenance preserved.
 */

export type LwwEligibilityResult =
  | { eligible: false }
  | { eligible: true; qualifies: boolean; newConf: number; oldConf: number };

/**
 * Evaluate whether a (newFact, oldFact) pair is eligible for project-state LWW
 * and, if so, whether the newer fact qualifies to supersede the older.
 *
 * Shared between the write-time path in `FactsDB.detectContradictions` and the
 * batch `resolveProjectStateLww` pass to keep eligibility logic in one place.
 *
 * @param oldFactOriginalConfidence The confidence captured at contradiction-detection
 *   time (before the -0.2 penalty). Missing values are treated as non-qualifying:
 *   LWW will require manual review instead of guessing from a possibly penalized score.
 */
export function evaluateLwwEligibility(
  newFact: MemoryEntry,
  oldFact: MemoryEntry,
  oldFactOriginalConfidence?: number,
): LwwEligibilityResult {
  if (newFact.category !== "project" || oldFact.category !== "project") return { eligible: false };
  const keyLower = (newFact.key ?? oldFact.key ?? "").trim().toLowerCase();
  if (!PROJECT_STATE_LWW_KEYS.has(keyLower)) return { eligible: false };
  if (!PROJECT_STATE_LWW_TRUSTED_SOURCES.has(newFact.source ?? "")) return { eligible: false };
  const newConf = newFact.confidence ?? 1.0;
  const oldConf = oldFactOriginalConfidence ?? oldFact.confidence ?? 1.0;
  if (oldFactOriginalConfidence == null) {
    return { eligible: true, qualifies: false, newConf, oldConf };
  }
  const qualifies = newFact.createdAt > oldFact.createdAt && newConf >= oldConf;
  return { eligible: true, qualifies, newConf, oldConf };
}

export function resolveProjectStateLww(
  db: DatabaseSync,
  getById: (id: string) => MemoryEntry | null,
  supersede: (oldId: string, newId: string | null) => boolean,
  options: { dryRun?: boolean } = {},
): ProjectStateLwwResult {
  const { dryRun = false } = options;
  const unresolved = getContradictions(db);

  const groupMap = new Map<
    string,
    {
      entity: string;
      key: string;
      scope: string | null;
      scopeTarget: string | null;
      candidates: ProjectStateLwwCandidate[];
    }
  >();
  let applied = 0;

  for (const c of unresolved) {
    const newFact = getById(c.factIdNew);
    const oldFact = getById(c.factIdOld);
    if (!newFact || !oldFact) continue;

    const lww = evaluateLwwEligibility(newFact, oldFact, c.oldFactOriginalConfidence);
    if (!lww.eligible) continue;

    const { qualifies, newConf, oldConf } = lww;
    const overloaded = isPossiblyOverloadedEntity(newFact, oldFact);
    const action: "supersede" | "manual-review" =
      qualifies && !overloaded && !isFactVerified(db, c.factIdOld) ? "supersede" : "manual-review";

    const entity = newFact.entity ?? oldFact.entity ?? "?";
    const key = newFact.key ?? oldFact.key ?? "?";
    const scope = newFact.scope ?? null;
    const scopeTarget = newFact.scopeTarget ?? null;

    const groupKey = `${entity}\0${key}\0${scope ?? ""}\0${scopeTarget ?? ""}`;
    let group = groupMap.get(groupKey);
    if (!group) {
      group = { entity, key, scope, scopeTarget, candidates: [] };
      groupMap.set(groupKey, group);
    }
    group.candidates.push({
      contradictionId: c.id,
      factIdNew: c.factIdNew,
      factIdOld: c.factIdOld,
      entity,
      key,
      scope,
      scopeTarget,
      newFactDate: newFact.createdAt,
      oldFactDate: oldFact.createdAt,
      newSource: newFact.source ?? "unknown",
      oldSource: oldFact.source ?? "unknown",
      newConf,
      oldConf,
      newValueExcerpt: truncateExcerpt(newFact.value ?? newFact.text ?? "", 80),
      oldValueExcerpt: truncateExcerpt(oldFact.value ?? oldFact.text ?? "", 80),
      action,
      possibleOverloadedEntity: overloaded,
    });

    if (!dryRun && action === "supersede") {
      if (oldFact.supersededAt != null) {
        resolveContradiction(db, c.id, "superseded");
        applied++;
      } else {
        const superseded = supersede(c.factIdOld, c.factIdNew);
        if (superseded) {
          resolveContradiction(db, c.id, "superseded");
          applied++;
        }
      }
    }
  }

  const groups = Array.from(groupMap.values());
  let totalCandidates = 0;
  let wouldSupersede = 0;
  let wouldManualReview = 0;
  for (const g of groups) {
    for (const cand of g.candidates) {
      totalCandidates++;
      if (cand.action === "supersede") wouldSupersede++;
      else wouldManualReview++;
    }
  }

  return { groups, totalCandidates, wouldSupersede, wouldManualReview, applied };
}

export interface ContradictionReviewItem {
  contradictionId: string;
  factIdNew: string;
  factIdOld: string;
  entity: string;
  key: string;
  scope: string | null;
  scopeTarget: string | null;
  newFactDate: number;
  oldFactDate: number;
  newSource: string;
  oldSource: string;
  newConf: number;
  oldConf: number;
  newValueExcerpt: string;
  oldValueExcerpt: string;
  newTextExcerpt: string;
  oldTextExcerpt: string;
  possibleOverloadedEntity: boolean;
  suggestedDecision: "keep_new" | "keep_old" | "manual_review";
  suggestedStrategy: string;
  suggestedConfidence: number;
  suggestedReason: string;
}

export interface LlmContradictionDecision {
  decision: "keep_new" | "keep_old" | "merge" | "manual_review";
  confidence: number;
  reason: string;
  mergedFactText?: string | null;
}

export interface ResolveContradictionsAutoOptions {
  dryRun?: boolean;
  targetRate?: number;
  llm?: boolean;
  llmConfidenceThreshold?: number;
  adjudicate?: (item: ContradictionReviewItem) => Promise<LlmContradictionDecision>;
  actor?: string;
  toolVersion?: string;
  model?: string | null;
}

export interface ResolveContradictionsAutoResult {
  total: number;
  deterministic: number;
  llm: number;
  merged: number;
  manualReview: number;
  applied: boolean;
  decisionsApplied: number;
  targetRate: number;
  achievedRate: number;
  targetMet: boolean;
  reviewItems: ContradictionReviewItem[];
}

export interface ContradictionReviewDecision {
  contradictionId: string;
  decision: "keep_new" | "keep_old" | "merge" | "manual_review";
  reason?: string;
  confidence?: number;
  mergedFactText?: string | null;
}

export interface ApplyContradictionReviewResult {
  applied: number;
  keptNew: number;
  keptOld: number;
  manualReview: number;
  rejected: number;
  errors: string[];
}

export interface ContradictionResolutionAuditRow {
  id: string;
  contradictionId: string;
  keptFactId: string;
  supersededFactId: string;
  strategy: string;
  confidence: number;
  reason: string;
  decidedAt: number;
  actor: string;
  toolVersion: string | null;
  mode: "auto" | "review";
  model: string | null;
}

const DEFAULT_CONTRADICTION_TARGET_RATE = 0.8;
const DEFAULT_LLM_AUTO_APPLY_CONFIDENCE = 0.9;

function buildContradictionReviewItem(
  contradiction: ContradictionRecord,
  newFact: MemoryEntry,
  oldFact: MemoryEntry,
): ContradictionReviewItem {
  const oldConf = contradiction.oldFactOriginalConfidence ?? oldFact.confidence ?? 1.0;
  const newConf = newFact.confidence ?? 1.0;
  return {
    contradictionId: contradiction.id,
    factIdNew: contradiction.factIdNew,
    factIdOld: contradiction.factIdOld,
    entity: newFact.entity ?? oldFact.entity ?? "?",
    key: newFact.key ?? oldFact.key ?? "?",
    scope: newFact.scope ?? oldFact.scope ?? null,
    scopeTarget: newFact.scopeTarget ?? oldFact.scopeTarget ?? null,
    newFactDate: newFact.createdAt,
    oldFactDate: oldFact.createdAt,
    newSource: newFact.source ?? "unknown",
    oldSource: oldFact.source ?? "unknown",
    newConf,
    oldConf,
    newValueExcerpt: truncateExcerpt(newFact.value ?? newFact.text ?? "", 80),
    oldValueExcerpt: truncateExcerpt(oldFact.value ?? oldFact.text ?? "", 80),
    newTextExcerpt: truncateExcerpt(newFact.text ?? newFact.value ?? "", 120),
    oldTextExcerpt: truncateExcerpt(oldFact.text ?? oldFact.value ?? "", 120),
    possibleOverloadedEntity: isPossiblyOverloadedEntity(newFact, oldFact),
    suggestedDecision: "manual_review",
    suggestedStrategy: "manual-review",
    suggestedConfidence: 0,
    suggestedReason: "No safe deterministic resolution matched.",
  };
}

function compareReviewItems(a: ContradictionReviewItem, b: ContradictionReviewItem): number {
  return (
    a.entity.localeCompare(b.entity) ||
    a.key.localeCompare(b.key) ||
    (a.scope ?? "").localeCompare(b.scope ?? "") ||
    (a.scopeTarget ?? "").localeCompare(b.scopeTarget ?? "") ||
    a.contradictionId.localeCompare(b.contradictionId)
  );
}

function clampConfidence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function insertContradictionResolutionAudit(db: DatabaseSync, row: Omit<ContradictionResolutionAuditRow, "id">): void {
  db.prepare(
    `INSERT INTO contradiction_resolution_audit
       (id, contradiction_id, kept_fact_id, superseded_fact_id, strategy, confidence, reason, decided_at, actor, tool_version, mode, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    row.contradictionId,
    row.keptFactId,
    row.supersededFactId,
    row.strategy,
    row.confidence,
    row.reason,
    row.decidedAt,
    row.actor,
    row.toolVersion,
    row.mode,
    row.model,
  );
}

export function getContradictionResolutionAudit(
  db: DatabaseSync,
  contradictionId?: string,
): ContradictionResolutionAuditRow[] {
  const query = contradictionId
    ? "SELECT * FROM contradiction_resolution_audit WHERE contradiction_id = ? ORDER BY decided_at ASC, id ASC"
    : "SELECT * FROM contradiction_resolution_audit ORDER BY decided_at ASC, id ASC";
  const rows = (contradictionId ? db.prepare(query).all(contradictionId) : db.prepare(query).all()) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => ({
    id: row.id as string,
    contradictionId: row.contradiction_id as string,
    keptFactId: row.kept_fact_id as string,
    supersededFactId: row.superseded_fact_id as string,
    strategy: row.strategy as string,
    confidence: Number(row.confidence ?? 0),
    reason: (row.reason as string) ?? "",
    decidedAt: Number(row.decided_at ?? 0),
    actor: (row.actor as string) ?? "resolve-contradictions",
    toolVersion: (row.tool_version as string | null) ?? null,
    mode: ((row.mode as "auto" | "review" | null) ?? "auto") === "review" ? "review" : "auto",
    model: (row.model as string | null) ?? null,
  }));
}

type PersistedDecision = {
  contradictionId: string;
  keptFactId: string;
  supersededFactId: string;
  resolution: "superseded" | "kept";
  strategy: string;
  confidence: number;
  reason: string;
  actor: string;
  toolVersion?: string | null;
  mode: "auto" | "review";
  model?: string | null;
};

function persistContradictionDecision(
  db: DatabaseSync,
  getById: (id: string) => MemoryEntry | null,
  supersede: (oldId: string, newId: string | null) => boolean,
  decision: PersistedDecision,
): boolean {
  const contradiction = db.prepare("SELECT resolved FROM contradictions WHERE id = ?").get(decision.contradictionId) as
    | { resolved: number }
    | undefined;
  if (!contradiction || contradiction.resolved === 1) return false;

  let applied = false;
  const tx = createTransaction(db, () => {
    const supersededFact = getById(decision.supersededFactId);
    if (!supersededFact) {
      return;
    }

    if (supersededFact.supersededAt == null) {
      const didSupersede = supersede(decision.supersededFactId, decision.keptFactId);
      if (!didSupersede) {
        return;
      }
    }

    const resolved = resolveContradiction(db, decision.contradictionId, decision.resolution);
    if (!resolved) {
      return;
    }

    insertContradictionResolutionAudit(db, {
      contradictionId: decision.contradictionId,
      keptFactId: decision.keptFactId,
      supersededFactId: decision.supersededFactId,
      strategy: decision.strategy,
      confidence: decision.confidence,
      reason: decision.reason,
      decidedAt: Math.floor(Date.now() / 1000),
      actor: decision.actor,
      toolVersion: decision.toolVersion ?? null,
      mode: decision.mode,
      model: decision.model ?? null,
    });
    applied = true;
  });
  tx();
  return applied;
}

export async function resolveContradictionsAutonomously(
  db: DatabaseSync,
  getById: (id: string) => MemoryEntry | null,
  supersede: (oldId: string, newId: string | null) => boolean,
  options: ResolveContradictionsAutoOptions = {},
): Promise<ResolveContradictionsAutoResult> {
  const {
    dryRun = false,
    targetRate = DEFAULT_CONTRADICTION_TARGET_RATE,
    llm = false,
    llmConfidenceThreshold = DEFAULT_LLM_AUTO_APPLY_CONFIDENCE,
    adjudicate,
    actor = "resolve-contradictions",
    toolVersion,
    model,
  } = options;

  const unresolved = getContradictions(db);
  const reviewItems: ContradictionReviewItem[] = [];
  let total = 0;
  let deterministic = 0;
  let llmResolved = 0;
  const merged = 0;
  let decisionsApplied = 0;

  for (const contradiction of unresolved) {
    const newFact = getById(contradiction.factIdNew);
    const oldFact = getById(contradiction.factIdOld);
    if (!newFact || !oldFact) continue;
    total++;

    const reviewItem = buildContradictionReviewItem(contradiction, newFact, oldFact);
    const lww = evaluateLwwEligibility(newFact, oldFact, contradiction.oldFactOriginalConfidence);

    if (reviewItem.possibleOverloadedEntity) {
      reviewItem.suggestedReason = "Possible entity reuse detected; leaving for manual review.";
    } else if (lww.eligible && lww.qualifies && !isFactVerified(db, contradiction.factIdOld)) {
      reviewItem.suggestedDecision = "keep_new";
      reviewItem.suggestedStrategy = "project-state-lww";
      reviewItem.suggestedConfidence = 1;
      reviewItem.suggestedReason = "Trusted newer project-state fact supersedes the stale value.";
      deterministic++;
      if (!dryRun) {
        const applied = persistContradictionDecision(db, getById, supersede, {
          contradictionId: contradiction.id,
          keptFactId: contradiction.factIdNew,
          supersededFactId: contradiction.factIdOld,
          resolution: "superseded",
          strategy: reviewItem.suggestedStrategy,
          confidence: reviewItem.suggestedConfidence,
          reason: reviewItem.suggestedReason,
          actor,
          toolVersion,
          mode: "auto",
          model: null,
        });
        if (applied) decisionsApplied++;
      }
      continue;
    } else if (isFactVerified(db, contradiction.factIdOld)) {
      reviewItem.suggestedReason = "Older fact is verified; leaving for manual review.";
    }

    if (llm && adjudicate) {
      try {
        const llmDecision = await adjudicate(reviewItem);
        const confidence = clampConfidence(llmDecision.confidence);
        if (
          (llmDecision.decision === "keep_new" || llmDecision.decision === "keep_old") &&
          confidence >= llmConfidenceThreshold
        ) {
          reviewItem.suggestedDecision = llmDecision.decision;
          reviewItem.suggestedStrategy = "llm-adjudication";
          reviewItem.suggestedConfidence = confidence;
          reviewItem.suggestedReason = llmDecision.reason?.trim() || "LLM adjudication approved the resolution.";
          llmResolved++;
          if (!dryRun) {
            const keepNew = llmDecision.decision === "keep_new";
            const applied = persistContradictionDecision(db, getById, supersede, {
              contradictionId: contradiction.id,
              keptFactId: keepNew ? contradiction.factIdNew : contradiction.factIdOld,
              supersededFactId: keepNew ? contradiction.factIdOld : contradiction.factIdNew,
              resolution: keepNew ? "superseded" : "kept",
              strategy: reviewItem.suggestedStrategy,
              confidence,
              reason: reviewItem.suggestedReason,
              actor,
              toolVersion,
              mode: "auto",
              model: model ?? null,
            });
            if (applied) decisionsApplied++;
          }
          continue;
        }

        if (llmDecision.decision === "merge") {
          reviewItem.suggestedReason =
            llmDecision.reason?.trim() || "LLM requested merge; keep manual review for safety.";
        } else if (confidence > 0) {
          reviewItem.suggestedReason =
            llmDecision.reason?.trim() || `LLM confidence ${confidence.toFixed(2)} below auto-apply threshold.`;
        }
      } catch (err) {
        reviewItem.suggestedReason = `LLM adjudication failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    reviewItems.push(reviewItem);
  }

  reviewItems.sort(compareReviewItems);
  const autoResolved = deterministic + llmResolved + merged;
  const achievedRate = total === 0 ? 1 : autoResolved / total;
  return {
    total,
    deterministic,
    llm: llmResolved,
    merged,
    manualReview: reviewItems.length,
    applied: !dryRun,
    decisionsApplied,
    targetRate,
    achievedRate,
    targetMet: achievedRate >= targetRate,
    reviewItems,
  };
}

export function applyContradictionReviewDecisions(
  db: DatabaseSync,
  getById: (id: string) => MemoryEntry | null,
  supersede: (oldId: string, newId: string | null) => boolean,
  decisions: ContradictionReviewDecision[],
  options: { actor?: string; toolVersion?: string | null } = {},
): ApplyContradictionReviewResult {
  const actor = options.actor ?? "resolve-contradictions-review";
  const toolVersion = options.toolVersion ?? null;
  let applied = 0;
  let keptNew = 0;
  let keptOld = 0;
  let manualReview = 0;
  let rejected = 0;
  const errors: string[] = [];

  for (const decision of decisions) {
    if (!decision.contradictionId?.trim()) {
      rejected++;
      errors.push("Decision is missing contradictionId.");
      continue;
    }
    if (decision.decision === "manual_review") {
      manualReview++;
      continue;
    }
    if (decision.decision === "merge") {
      rejected++;
      errors.push(`Contradiction ${decision.contradictionId}: merge decisions must be handled manually.`);
      continue;
    }

    const contradiction = db
      .prepare("SELECT fact_id_new, fact_id_old, resolved FROM contradictions WHERE id = ?")
      .get(decision.contradictionId) as { fact_id_new: string; fact_id_old: string; resolved: number } | undefined;
    if (!contradiction) {
      rejected++;
      errors.push(`Contradiction ${decision.contradictionId}: row not found.`);
      continue;
    }
    if (contradiction.resolved === 1) {
      rejected++;
      errors.push(`Contradiction ${decision.contradictionId}: already resolved.`);
      continue;
    }

    const keepNew = decision.decision === "keep_new";
    const didApply = persistContradictionDecision(db, getById, supersede, {
      contradictionId: decision.contradictionId,
      keptFactId: keepNew ? contradiction.fact_id_new : contradiction.fact_id_old,
      supersededFactId: keepNew ? contradiction.fact_id_old : contradiction.fact_id_new,
      resolution: keepNew ? "superseded" : "kept",
      strategy: "manual-review-file",
      confidence: clampConfidence(decision.confidence) || 1,
      reason: decision.reason?.trim() || "Applied from contradiction review file.",
      actor,
      toolVersion,
      mode: "review",
      model: null,
    });
    if (!didApply) {
      rejected++;
      errors.push(`Contradiction ${decision.contradictionId}: could not persist decision.`);
      continue;
    }
    applied++;
    if (keepNew) keptNew++;
    else keptOld++;
  }

  return { applied, keptNew, keptOld, manualReview, rejected, errors };
}

export function detectEpisodeFailureContradictions(
  db: DatabaseSync,
  eventText: string,
  procedureId?: string | null,
): Array<{
  factId: string;
  score: number;
  heuristicSignals: string[];
  preview: string;
}> {
  const conditions = ["superseded_at IS NULL", "category IN ('procedure', 'workflow')"];
  const params: SQLInputValue[] = [];
  if (procedureId?.trim()) {
    conditions.push("(id = ? OR entity = ? OR key = ?)");
    params.push(procedureId.trim(), procedureId.trim(), procedureId.trim());
  }
  const rows = db
    .prepare(
      `SELECT id, text, value FROM facts WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 20`,
    )
    .all(...params) as Array<{ id: string; text: string; value: string | null }>;

  const out: Array<{ factId: string; score: number; heuristicSignals: string[]; preview: string }> = [];
  for (const row of rows) {
    const { score, heuristicSignals } = scoreFactContradiction(
      eventText,
      eventText,
      row.text ?? "",
      row.value ?? "",
    );
    if (score >= 0.3) {
      out.push({
        factId: row.id,
        score,
        heuristicSignals,
        preview: truncatePreview(row.text ?? row.value ?? ""),
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export function queryContradictionSurface(
  db: DatabaseSync,
  options: {
    since?: string;
    entity?: string;
    limit?: number;
    resolved?: boolean;
  } = {},
): Array<{
  factId: string;
  contradictingFactId: string;
  contradictionId: string;
  score: number;
  heuristicSignals: string[];
  createdAt: string;
  preview: string;
  resolved: boolean;
}> {
  const limit = Math.min(options.limit ?? 50, 200);
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];

  if (options.since?.trim()) {
    conditions.push("c.detected_at >= ?");
    params.push(options.since.trim());
  }
  if (options.resolved === true) {
    conditions.push("c.resolved = 1");
  } else if (options.resolved === false) {
    conditions.push("c.resolved = 0");
  }
  if (options.entity?.trim()) {
    conditions.push("(LOWER(f_new.entity) = LOWER(?) OR LOWER(f_old.entity) = LOWER(?))");
    params.push(options.entity.trim(), options.entity.trim());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT c.id, c.fact_id_new, c.fact_id_old, c.detected_at, c.resolved,
              c.heuristic_score, c.heuristic_signals,
              f_old.text AS old_text, f_old.value AS old_value
       FROM contradictions c
       JOIN facts f_old ON f_old.id = c.fact_id_old
       JOIN facts f_new ON f_new.id = c.fact_id_new
       ${where}
       ORDER BY c.detected_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    factId: r.fact_id_new as string,
    contradictingFactId: r.fact_id_old as string,
    contradictionId: r.id as string,
    score: typeof r.heuristic_score === "number" ? (r.heuristic_score as number) : 0,
    heuristicSignals: r.heuristic_signals ? (JSON.parse(String(r.heuristic_signals)) as string[]) : [],
    createdAt: r.detected_at as string,
    preview: truncatePreview(String(r.old_text ?? r.old_value ?? "")),
    resolved: (r.resolved as number) === 1,
  }));
}

export function contradictionsCount(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM contradictions WHERE resolved = 0").get() as {
      cnt: number;
    };
    return row?.cnt ?? 0;
  } catch (err) {
    capturePluginError(err as Error, {
      operation: "count-contradictions",
      severity: "info",
      subsystem: "facts",
    });
    return 0;
  }
}
