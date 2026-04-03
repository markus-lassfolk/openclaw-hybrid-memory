/**
 * Auto-linking helpers (Issue #154) (Issue #954 split).
 */
import type { SQLInputValue } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

import type { MemoryEntry } from "../../types/memory.js";
import { updateConfidence } from "./contradictions.js";
import { rowToMemoryEntry } from "./row-mapper.js";
import type { MemoryLinkType } from "./types.js";

const KNOWN_ENTITIES_CACHE_TTL_MS = 30_000;
const knownEntitiesCacheByDb = new WeakMap<DatabaseSync, { list: string[]; time: number }>();

export function getKnownEntities(db: DatabaseSync): string[] {
  const now = Date.now();
  const hit = knownEntitiesCacheByDb.get(db);
  if (hit && now - hit.time < KNOWN_ENTITIES_CACHE_TTL_MS) {
    return hit.list;
  }
  const rows = db
    .prepare("SELECT DISTINCT entity FROM facts WHERE entity IS NOT NULL AND superseded_at IS NULL")
    .all() as Array<{ entity: string }>;
  const list = rows.map((r) => r.entity);
  knownEntitiesCacheByDb.set(db, { list, time: now });
  return list;
}

export function extractEntitiesFromText(
  text: string,
  knownEntities: string[],
): Array<{ entity: string; weight: number }> {
  const seen = new Map<string, number>();
  const lowerText = text.toLowerCase();

  for (const entity of knownEntities) {
    if (!entity) continue;
    const lowerEntity = entity.toLowerCase();

    if (!lowerText.includes(lowerEntity)) continue;

    const escapedForRegex = lowerEntity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordBoundaryRe = new RegExp(`\\b${escapedForRegex}\\b`);
    if (wordBoundaryRe.test(lowerText)) {
      const current = seen.get(entity) ?? 0;
      if (current < 1.0) seen.set(entity, 1.0);
      continue;
    }

    const current = seen.get(entity) ?? 0;
    if (current < 0.7) seen.set(entity, 0.7);
  }

  const ipRe = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
  let m: RegExpExecArray | null;
  while ((m = ipRe.exec(text)) !== null) {
    const ip = m[0];
    if (!seen.has(ip)) seen.set(ip, 0.5);
  }

  return Array.from(seen.entries())
    .map(([entity, weight]) => ({ entity, weight }))
    .sort((a, b) => b.weight - a.weight);
}

export function findEntityAnchor(db: DatabaseSync, entity: string, excludeId?: string): MemoryEntry | null {
  const nowSec = Math.floor(Date.now() / 1000);
  const excludeClause = excludeId ? "AND id != ?" : "";
  const params = excludeId ? [entity, nowSec, excludeId] : [entity, nowSec];
  const row = db
    .prepare(
      `SELECT * FROM facts
         WHERE lower(entity) = lower(?)
           AND superseded_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           ${excludeClause}
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
    )
    .get(...params) as Record<string, unknown> | undefined;
  return row ? rowToMemoryEntry(row) : null;
}

export function autoDetectInstanceOf(
  db: DatabaseSync,
  newFactId: string,
  text: string,
  knownEntitiesList: string[] | undefined,
  createLink: (a: string, b: string, t: MemoryLinkType, s?: number) => string,
  getKnown: (d: DatabaseSync) => string[],
): number {
  const patterns = [
    /\bis\s+an?\s+([a-zA-Z][a-zA-Z0-9 _-]{1,40}?)(?:\s*[,;.!?]|$)/gi,
    /\btype\s+of\s+([a-zA-Z][a-zA-Z0-9 _-]{1,40}?)(?:\s*[,;.!?]|$)/gi,
    /\bkind\s+of\s+([a-zA-Z][a-zA-Z0-9 _-]{1,40}?)(?:\s*[,;.!?]|$)/gi,
  ];

  const candidates = new Set<string>();
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const typeName = match[1].trim().toLowerCase();
      if (typeName.length >= 2) candidates.add(typeName);
    }
  }

  if (candidates.size === 0) return 0;

  const entities = knownEntitiesList ?? getKnown(db);
  const knownEntitiesSet = new Set(entities.map((e) => e.toLowerCase()));
  let linked = 0;

  for (const typeName of candidates) {
    if (!knownEntitiesSet.has(typeName)) continue;
    const anchor = findEntityAnchor(db, typeName, newFactId);
    if (!anchor) continue;
    const existing = db
      .prepare(
        `SELECT id FROM memory_links
           WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'INSTANCE_OF'`,
      )
      .get(newFactId, anchor.id);
    if (!existing) {
      createLink(newFactId, anchor.id, "INSTANCE_OF", 1.0);
      linked++;
    }
  }

  return linked;
}

export function autoLinkEntities(
  db: DatabaseSync,
  newFactId: string,
  text: string,
  entity: string | null,
  key: string | null,
  sessionId: string | null,
  cfg: { coOccurrenceWeight: number; autoSupersede: boolean },
  scope: string | null | undefined,
  scopeTarget: string | null | undefined,
  createLink: (a: string, b: string, t: MemoryLinkType, s?: number) => string,
  supersede: (oldId: string, newId: string | null) => boolean,
): { linkedCount: number; supersededIds: string[] } {
  let linkedCount = 0;
  const supersededIds: string[] = [];

  const knownEntities = getKnownEntities(db);
  const mentions = extractEntitiesFromText(text, knownEntities);

  for (const { entity: mentionedEntity, weight } of mentions) {
    const anchor = findEntityAnchor(db, mentionedEntity, newFactId);
    if (!anchor) continue;
    const existing = db
      .prepare(
        `SELECT id FROM memory_links
           WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'RELATED_TO'`,
      )
      .get(newFactId, anchor.id);
    if (!existing) {
      createLink(newFactId, anchor.id, "RELATED_TO", weight);
      linkedCount++;
    }
  }

  if (sessionId) {
    const nowSec = Math.floor(Date.now() / 1000);
    const escapedSessionId = sessionId.replace(/[\\%_]/g, "\\$&");
    const recentRows = db
      .prepare(
        `SELECT * FROM facts
           WHERE id != ?
             AND superseded_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
             AND source_sessions IS NOT NULL
             AND ((',' || source_sessions || ',' LIKE ? ESCAPE '\\') OR source_sessions LIKE ? ESCAPE '\\')
           ORDER BY created_at DESC
           LIMIT 20`,
      )
      .all(newFactId, nowSec, `%,${escapedSessionId},%`, `%"${escapedSessionId}"%`) as Array<Record<string, unknown>>;

    for (const row of recentRows) {
      const coEntry = rowToMemoryEntry(row);
      const existing = db
        .prepare(
          `SELECT id FROM memory_links
             WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'RELATED_TO'`,
        )
        .get(newFactId, coEntry.id);
      if (!existing) {
        createLink(newFactId, coEntry.id, "RELATED_TO", cfg.coOccurrenceWeight);
        linkedCount++;
      }
    }
  }

  if (entity?.trim() && key?.trim()) {
    const nowSec = Math.floor(Date.now() / 1000);
    const scopeClause = scope
      ? scopeTarget != null
        ? "AND scope = ? AND scope_target = ?"
        : "AND scope = ? AND scope_target IS NULL"
      : "";
    const baseParams: SQLInputValue[] = [entity.trim(), key.trim(), newFactId, nowSec];
    const scopeParams: SQLInputValue[] = scope ? (scopeTarget != null ? [scope, scopeTarget] : [scope]) : [];
    const conflicting = db
      .prepare(
        `SELECT * FROM facts
           WHERE lower(entity) = lower(?)
             AND lower(key) = lower(?)
             AND id != ?
             AND superseded_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
             ${scopeClause}
           ORDER BY created_at DESC`,
      )
      .all(...baseParams, ...scopeParams) as Array<Record<string, unknown>>;

    const newVal =
      ((db.prepare("SELECT value FROM facts WHERE id = ?").get(newFactId) as { value: string | null } | undefined)
        ?.value as string) ?? null;

    if (newVal !== null) {
      for (const row of conflicting) {
        const oldFact = rowToMemoryEntry(row);
        if (oldFact.value !== null && newVal.toLowerCase() === oldFact.value.toLowerCase()) continue;

        const alreadyLinked = db
          .prepare(
            `SELECT id FROM memory_links
               WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'SUPERSEDES'`,
          )
          .get(newFactId, oldFact.id);
        if (!alreadyLinked) {
          createLink(newFactId, oldFact.id, "SUPERSEDES", 1.0);

          if (cfg.autoSupersede) {
            supersede(oldFact.id, newFactId);

            const existingContradiction = db
              .prepare(
                `SELECT id FROM contradictions
                   WHERE fact_id_new = ? AND fact_id_old = ?`,
              )
              .get(newFactId, oldFact.id);
            if (!existingContradiction) {
              updateConfidence(db, oldFact.id, -0.2);
            }
            supersededIds.push(oldFact.id);
          }
        }
      }
    }
  }

  linkedCount += autoDetectInstanceOf(db, newFactId, text, knownEntities, createLink, getKnownEntities);

  return { linkedCount, supersededIds };
}
