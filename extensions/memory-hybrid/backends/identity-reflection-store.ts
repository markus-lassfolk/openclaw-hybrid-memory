/**
 * Identity Reflection Store
 * Separate SQLite store for identity/persona synthesis outputs.
 *
 * Keeps identity-level reflections distinct from factual/workflow memory while
 * still allowing downstream persona proposal generation to consume them.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ScopeFilter } from "../types/memory.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";

type Durability = "durable" | "temporary";

interface IdentityReflectionRow {
  id: string;
  run_id: string;
  question_key: string;
  question_text: string;
  insight: string;
  durability: Durability;
  confidence: number;
  evidence: string;
  source_pattern_count: number;
  source_rule_count: number;
  source_meta_count: number;
  created_at: number;
  scope_user_id: string | null;
  scope_agent_id: string | null;
  scope_session_id: string | null;
}

export interface IdentityReflectionEntry {
  id: string;
  runId: string;
  questionKey: string;
  questionText: string;
  insight: string;
  durability: Durability;
  confidence: number;
  evidence: string[];
  sourcePatternCount: number;
  sourceRuleCount: number;
  sourceMetaCount: number;
  createdAt: number;
}

export class IdentityReflectionStore extends BaseSqliteStore {
  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);

    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS identity_reflections (
        id                    TEXT PRIMARY KEY,
        run_id                TEXT NOT NULL,
        question_key          TEXT NOT NULL,
        question_text         TEXT NOT NULL,
        insight               TEXT NOT NULL,
        durability            TEXT NOT NULL CHECK (durability IN ('durable', 'temporary')),
        confidence            REAL NOT NULL,
        evidence              TEXT NOT NULL DEFAULT '[]',
        source_pattern_count  INTEGER NOT NULL DEFAULT 0,
        source_rule_count     INTEGER NOT NULL DEFAULT 0,
        source_meta_count     INTEGER NOT NULL DEFAULT 0,
        created_at            INTEGER NOT NULL,
        scope_user_id         TEXT,
        scope_agent_id        TEXT,
        scope_session_id      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_identity_reflections_created
        ON identity_reflections(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_identity_reflections_question
        ON identity_reflections(question_key, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_identity_reflections_scope
        ON identity_reflections(scope_user_id, scope_agent_id, scope_session_id, created_at DESC);
    `);

    const tableInfo = this.liveDb.prepare("PRAGMA table_info(identity_reflections)").all() as Array<{ name: string }>;
    const hasColumn = (name: string) => tableInfo.some((column) => column.name === name);
    if (!hasColumn("scope_user_id")) {
      this.liveDb.exec("ALTER TABLE identity_reflections ADD COLUMN scope_user_id TEXT");
    }
    if (!hasColumn("scope_agent_id")) {
      this.liveDb.exec("ALTER TABLE identity_reflections ADD COLUMN scope_agent_id TEXT");
    }
    if (!hasColumn("scope_session_id")) {
      this.liveDb.exec("ALTER TABLE identity_reflections ADD COLUMN scope_session_id TEXT");
    }
    this.liveDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_identity_reflections_scope
      ON identity_reflections(scope_user_id, scope_agent_id, scope_session_id, created_at DESC)
    `);
  }

  protected getSubsystemName(): string {
    return "identity-reflection-store";
  }

  create(entry: {
    runId: string;
    questionKey: string;
    questionText: string;
    insight: string;
    durability: Durability;
    confidence: number;
    evidence?: string[];
    sourcePatternCount?: number;
    sourceRuleCount?: number;
    sourceMetaCount?: number;
    scopeFilter?: ScopeFilter;
  }): IdentityReflectionEntry {
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    const evidence = JSON.stringify(entry.evidence ?? []);
    const scopeUserId = normalizeScopeValue(entry.scopeFilter?.userId);
    const scopeAgentId = normalizeScopeValue(entry.scopeFilter?.agentId);
    const scopeSessionId = normalizeScopeValue(entry.scopeFilter?.sessionId);
    this.liveDb
      .prepare(
        `INSERT INTO identity_reflections (
           id, run_id, question_key, question_text, insight, durability, confidence, evidence,
           source_pattern_count, source_rule_count, source_meta_count, created_at,
           scope_user_id, scope_agent_id, scope_session_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.runId,
        entry.questionKey,
        entry.questionText,
        entry.insight,
        entry.durability,
        entry.confidence,
        evidence,
        entry.sourcePatternCount ?? 0,
        entry.sourceRuleCount ?? 0,
        entry.sourceMetaCount ?? 0,
        createdAt,
        scopeUserId,
        scopeAgentId,
        scopeSessionId,
      );

    const created = this.get(id);
    if (!created) throw new Error(`Failed to create identity reflection: ${id}`);
    return created;
  }

  get(id: string): IdentityReflectionEntry | null {
    const row = this.liveDb.prepare("SELECT * FROM identity_reflections WHERE id = ?").get(id) as
      | IdentityReflectionRow
      | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  listRecent(limit = 50, opts?: { scopeFilter?: ScopeFilter }): IdentityReflectionEntry[] {
    const scopeWhere = buildScopeWhereClause(opts?.scopeFilter);
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM identity_reflections${scopeWhere.clause} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...scopeWhere.params, limit) as unknown as IdentityReflectionRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  getLatestByQuestion(questionKey: string, opts?: { scopeFilter?: ScopeFilter }): IdentityReflectionEntry | null {
    const scopeWhere = buildScopeWhereClause(opts?.scopeFilter);
    const scopeCondition = scopeWhere.clause ? ` AND ${scopeWhere.clause.replace(/^ WHERE /, "")}` : "";
    const row = this.liveDb
      .prepare(
        `SELECT * FROM identity_reflections WHERE question_key = ?${scopeCondition} ORDER BY created_at DESC LIMIT 1`,
      )
      .get(questionKey, ...scopeWhere.params) as IdentityReflectionRow | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  private rowToEntry(row: IdentityReflectionRow): IdentityReflectionEntry {
    let evidence: string[] = [];
    try {
      const parsed = JSON.parse(row.evidence);
      if (Array.isArray(parsed)) {
        evidence = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // Keep malformed JSON non-fatal; callers can still use the insight.
      evidence = [];
    }
    return {
      id: row.id,
      runId: row.run_id,
      questionKey: row.question_key,
      questionText: row.question_text,
      insight: row.insight,
      durability: row.durability,
      confidence: row.confidence,
      evidence,
      sourcePatternCount: row.source_pattern_count,
      sourceRuleCount: row.source_rule_count,
      sourceMetaCount: row.source_meta_count,
      createdAt: row.created_at,
    };
  }
}

function normalizeScopeValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildScopeWhereClause(scopeFilter?: ScopeFilter): { clause: string; params: string[] } {
  const userId = normalizeScopeValue(scopeFilter?.userId);
  const agentId = normalizeScopeValue(scopeFilter?.agentId);
  const sessionId = normalizeScopeValue(scopeFilter?.sessionId);
  if (!userId && !agentId && !sessionId) {
    return { clause: "", params: [] };
  }
  const clauses: string[] = [];
  const params: string[] = [];
  if (userId) {
    clauses.push("scope_user_id = ?");
    params.push(userId);
  } else {
    clauses.push("scope_user_id IS NULL");
  }
  if (agentId) {
    clauses.push("scope_agent_id = ?");
    params.push(agentId);
  } else {
    clauses.push("scope_agent_id IS NULL");
  }
  if (sessionId) {
    clauses.push("scope_session_id = ?");
    params.push(sessionId);
  } else {
    clauses.push("scope_session_id IS NULL");
  }
  return {
    clause: ` WHERE ${clauses.join(" AND ")}`,
    params,
  };
}
