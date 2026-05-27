/**
 * Persona State Store
 *
 * Durable persona state lives here after repeated identity reflections earn promotion.
 * It stays separate from factual memory, operational rules, and human-reviewed file proposals.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IdentityFileType } from "../config/types/agents.js";
import type { ScopeFilter } from "../types/memory.js";
import { uniqueStrings } from "../utils/text.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";
import { buildExactScopeWhereClause, normalizeScopeValue } from "./scope-filter-sql.js";

interface PersonaStateRow {
  id: string;
  state_key: string;
  question_key: string;
  target_file: IdentityFileType;
  insight: string;
  normalized_insight: string;
  confidence: number;
  durable_count: number;
  evidence: string;
  source_reflection_ids: string;
  first_seen_at: number;
  last_seen_at: number;
  promoted_at: number;
  updated_at: number;
  scope_user_id: string | null;
  scope_agent_id: string | null;
  scope_session_id: string | null;
}

export interface PersonaStateEntry {
  id: string;
  stateKey: string;
  questionKey: string;
  targetFile: IdentityFileType;
  insight: string;
  normalizedInsight: string;
  confidence: number;
  durableCount: number;
  evidence: string[];
  sourceReflectionIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  promotedAt: number;
  updatedAt: number;
}

interface UpsertPersonaStateInput {
  stateKey: string;
  questionKey: string;
  targetFile: IdentityFileType;
  insight: string;
  normalizedInsight: string;
  confidence: number;
  durableCount: number;
  evidence?: string[];
  sourceReflectionIds?: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  scopeFilter?: ScopeFilter;
}

type UpsertPersonaStateResult = {
  action: "created" | "updated" | "unchanged";
  entry: PersonaStateEntry;
};

export class PersonaStateStore extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);

    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS persona_state (
        id                   TEXT PRIMARY KEY,
        state_key            TEXT NOT NULL UNIQUE,
        question_key         TEXT NOT NULL,
        target_file          TEXT NOT NULL CHECK (target_file IN ('SOUL.md', 'IDENTITY.md', 'USER.md')),
        insight              TEXT NOT NULL,
        normalized_insight   TEXT NOT NULL,
        confidence           REAL NOT NULL,
        durable_count        INTEGER NOT NULL DEFAULT 0,
        evidence             TEXT NOT NULL DEFAULT '[]',
        source_reflection_ids TEXT NOT NULL DEFAULT '[]',
        first_seen_at        INTEGER NOT NULL,
        last_seen_at         INTEGER NOT NULL,
        promoted_at          INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        scope_user_id        TEXT,
        scope_agent_id       TEXT,
        scope_session_id     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_persona_state_updated
        ON persona_state(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_persona_state_question
        ON persona_state(question_key, updated_at DESC);
    `);

    const tableInfo = this.liveDb.prepare("PRAGMA table_info(persona_state)").all() as Array<{ name: string }>;
    const columns = new Set(tableInfo.map((column) => column.name));
    if (!columns.has("scope_user_id")) {
      this.liveDb.exec("ALTER TABLE persona_state ADD COLUMN scope_user_id TEXT");
    }
    if (!columns.has("scope_agent_id")) {
      this.liveDb.exec("ALTER TABLE persona_state ADD COLUMN scope_agent_id TEXT");
    }
    if (!columns.has("scope_session_id")) {
      this.liveDb.exec("ALTER TABLE persona_state ADD COLUMN scope_session_id TEXT");
    }
    this.liveDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_persona_state_scope
      ON persona_state(scope_user_id, scope_agent_id, scope_session_id, updated_at DESC)
    `);
  }

  protected getSubsystemName(): string {
    return "persona-state-store";
  }

  getByStateKey(stateKey: string, opts?: { scopeFilter?: ScopeFilter }): PersonaStateEntry | null {
    const scopeWhere = buildExactScopeWhereClause(opts?.scopeFilter);
    const row = this.liveDb
      .prepare(`SELECT * FROM persona_state WHERE state_key = ?${scopeWhere.andClause}`)
      .get(stateKey, ...scopeWhere.params) as PersonaStateRow | undefined;
    return row ? this.rowToEntry(row) : null;
  }

  listRecent(limit = 50, opts?: { scopeFilter?: ScopeFilter }): PersonaStateEntry[] {
    const scopeWhere = buildExactScopeWhereClause(opts?.scopeFilter);
    const rows = this.liveDb
      .prepare(`SELECT * FROM persona_state${scopeWhere.whereClause} ORDER BY updated_at DESC LIMIT ?`)
      .all(...scopeWhere.params, limit) as unknown as PersonaStateRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  count(opts?: { scopeFilter?: ScopeFilter }): number {
    const scopeWhere = buildExactScopeWhereClause(opts?.scopeFilter);
    const row = this.liveDb.prepare(`SELECT COUNT(*) AS count FROM persona_state${scopeWhere.whereClause}`).get(
      ...scopeWhere.params,
    ) as
      | { count?: number }
      | undefined;
    return row?.count ?? 0;
  }

  upsert(entry: UpsertPersonaStateInput): UpsertPersonaStateResult {
    const now = Math.floor(Date.now() / 1000);
    const scopeUserId = normalizeScopeValue(entry.scopeFilter?.userId);
    const scopeAgentId = normalizeScopeValue(entry.scopeFilter?.agentId);
    const scopeSessionId = normalizeScopeValue(entry.scopeFilter?.sessionId);
    const existing = this.getByStateKey(entry.stateKey, { scopeFilter: entry.scopeFilter });
    const evidence = uniqueStrings(entry.evidence ?? []);
    const sourceReflectionIds = uniqueStrings(entry.sourceReflectionIds ?? []);

    if (!existing) {
      const id = randomUUID();
      this.liveDb
        .prepare(
          `INSERT INTO persona_state (
             id, state_key, question_key, target_file, insight, normalized_insight,
             confidence, durable_count, evidence, source_reflection_ids,
             first_seen_at, last_seen_at, promoted_at, updated_at,
             scope_user_id, scope_agent_id, scope_session_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          entry.stateKey,
          entry.questionKey,
          entry.targetFile,
          entry.insight,
          entry.normalizedInsight,
          entry.confidence,
          entry.durableCount,
          JSON.stringify(evidence),
          JSON.stringify(sourceReflectionIds),
          entry.firstSeenAt,
          entry.lastSeenAt,
          now,
          now,
          scopeUserId,
          scopeAgentId,
          scopeSessionId,
        );
      const created: PersonaStateEntry = {
        id,
        stateKey: entry.stateKey,
        questionKey: entry.questionKey,
        targetFile: entry.targetFile,
        insight: entry.insight,
        normalizedInsight: entry.normalizedInsight,
        confidence: entry.confidence,
        durableCount: entry.durableCount,
        evidence,
        sourceReflectionIds,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        promotedAt: now,
        updatedAt: now,
      };
      return { action: "created", entry: created };
    }

    const mergedEvidence = uniqueStrings([...existing.evidence, ...evidence]);
    const mergedSourceReflectionIds = uniqueStrings([...existing.sourceReflectionIds, ...sourceReflectionIds]);
    const nextConfidence = Math.max(existing.confidence, entry.confidence);
    const nextDurableCount = Math.max(existing.durableCount, entry.durableCount);
    const nextFirstSeenAt = Math.min(existing.firstSeenAt, entry.firstSeenAt);
    const nextLastSeenAt = Math.max(existing.lastSeenAt, entry.lastSeenAt);
    const changed =
      existing.insight !== entry.insight ||
      existing.targetFile !== entry.targetFile ||
      existing.confidence !== nextConfidence ||
      existing.durableCount !== nextDurableCount ||
      existing.firstSeenAt !== nextFirstSeenAt ||
      existing.lastSeenAt !== nextLastSeenAt ||
      JSON.stringify(existing.evidence) !== JSON.stringify(mergedEvidence) ||
      JSON.stringify(existing.sourceReflectionIds) !== JSON.stringify(mergedSourceReflectionIds);

    if (!changed) {
      return { action: "unchanged", entry: existing };
    }

    this.liveDb
      .prepare(
        `UPDATE persona_state
         SET target_file = ?,
             insight = ?,
             normalized_insight = ?,
             confidence = ?,
             durable_count = ?,
             evidence = ?,
             source_reflection_ids = ?,
             first_seen_at = ?,
             last_seen_at = ?,
             updated_at = ?
         WHERE state_key = ?`,
      )
      .run(
        entry.targetFile,
        entry.insight,
        entry.normalizedInsight,
        nextConfidence,
        nextDurableCount,
        JSON.stringify(mergedEvidence),
        JSON.stringify(mergedSourceReflectionIds),
        nextFirstSeenAt,
        nextLastSeenAt,
        now,
        entry.stateKey,
      );

    const updated: PersonaStateEntry = {
      id: existing.id,
      stateKey: entry.stateKey,
      questionKey: entry.questionKey,
      targetFile: entry.targetFile,
      insight: entry.insight,
      normalizedInsight: entry.normalizedInsight,
      confidence: nextConfidence,
      durableCount: nextDurableCount,
      evidence: mergedEvidence,
      sourceReflectionIds: mergedSourceReflectionIds,
      firstSeenAt: nextFirstSeenAt,
      lastSeenAt: nextLastSeenAt,
      promotedAt: existing.promotedAt,
      updatedAt: now,
    };
    return { action: "updated", entry: updated };
  }

  private rowToEntry(row: PersonaStateRow): PersonaStateEntry {
    return {
      id: row.id,
      stateKey: row.state_key,
      questionKey: row.question_key,
      targetFile: row.target_file,
      insight: row.insight,
      normalizedInsight: row.normalized_insight,
      confidence: row.confidence,
      durableCount: row.durable_count,
      evidence: this.parseJsonArray(row.evidence),
      sourceReflectionIds: this.parseJsonArray(row.source_reflection_ids),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      promotedAt: row.promoted_at,
      updatedAt: row.updated_at,
    };
  }

  private parseJsonArray(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return [];
    }
  }
}
