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
import { parseTags, serializeTags } from "../../utils/tags.js";
import { rowToMemoryEntry } from "./row-mapper.js";
import type { MemoryLinkType } from "./types.js";

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

export function recordContradiction(
  db: DatabaseSync,
  factIdNew: string,
  factIdOld: string,
  createLink: (a: string, b: string, t: MemoryLinkType, s?: number) => string,
): { id: string; oldFactOriginalConfidence: number } {
  const id = randomUUID();
  const detectedAt = new Date().toISOString();
  let oldFactOriginalConfidence = 1.0;

  const tx = createTransaction(db, () => {
    const oldFactRow = db.prepare("SELECT confidence FROM facts WHERE id = ?").get(factIdOld) as
      | { confidence: number }
      | undefined;
    oldFactOriginalConfidence = oldFactRow?.confidence ?? 1.0;

    db.prepare(
      `INSERT INTO contradictions (id, fact_id_new, fact_id_old, detected_at, resolved, resolution, old_fact_original_confidence)
           VALUES (?, ?, ?, ?, 0, NULL, ?)`,
    ).run(id, factIdNew, factIdOld, detectedAt, oldFactOriginalConfidence);

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
): Array<{ contradictionId: string; oldFactId: string; oldFactOriginalConfidence: number }> {
  if (!entity?.trim() || !key?.trim() || !value?.trim()) return [];

  const conflicting = findConflictingFacts(db, entity.trim(), key.trim(), value.trim(), newFactId, scope, scopeTarget);
  const results: Array<{ contradictionId: string; oldFactId: string; oldFactOriginalConfidence: number }> = [];

  for (const old of conflicting) {
    if (old.value?.toLowerCase() === value.trim().toLowerCase()) continue;
    const contradiction = recordContradiction(db, newFactId, old.id, createLink);
    results.push({
      contradictionId: contradiction.id,
      oldFactId: old.id,
      oldFactOriginalConfidence: contradiction.oldFactOriginalConfidence,
    });
  }

  return results;
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
    .prepare("UPDATE contradictions SET resolved = 1, resolution = ? WHERE id = ? AND resolved = 0")
    .run(resolution, contradictionId);
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
export const PROJECT_STATE_LWW_TRUSTED_SOURCES: ReadonlySet<string> = new Set(["conversation", "cli", "active-task"]);

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
      qualifies && !isFactVerified(db, c.factIdOld) ? "supersede" : "manual-review";

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
