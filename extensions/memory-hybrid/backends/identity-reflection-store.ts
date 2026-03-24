/**
 * Identity Reflection Store
 * Separate SQLite store for identity/persona synthesis outputs.
 *
 * Keeps identity-level reflections distinct from factual/workflow memory while
 * still allowing downstream persona proposal generation to consume them.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";
import { capturePluginError } from "../services/error-reporter.js";

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

export class IdentityReflectionStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private _dbOpen = true;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.applyPragmas();

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
        created_at            INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_identity_reflections_created
        ON identity_reflections(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_identity_reflections_question
        ON identity_reflections(question_key, created_at DESC);
    `);
  }

  private applyPragmas(): void {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  }

  private get liveDb(): DatabaseSync {
    if (!this._dbOpen) {
      this.db.open();
      this._dbOpen = true;
      this.closed = false;
      this.applyPragmas();
    }
    return this.db;
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
  }): IdentityReflectionEntry {
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    const evidence = JSON.stringify(entry.evidence ?? []);
    this.liveDb
      .prepare(
        `INSERT INTO identity_reflections (
           id, run_id, question_key, question_text, insight, durability, confidence, evidence,
           source_pattern_count, source_rule_count, source_meta_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );

    return this.get(id)!;
  }

  get(id: string): IdentityReflectionEntry | null {
    const row = this.liveDb.prepare("SELECT * FROM identity_reflections WHERE id = ?").get(id) as
      | IdentityReflectionRow
      | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  listRecent(limit = 50): IdentityReflectionEntry[] {
    const rows = this.liveDb
      .prepare("SELECT * FROM identity_reflections ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as IdentityReflectionRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  getLatestByQuestion(questionKey: string): IdentityReflectionEntry | null {
    const row = this.liveDb
      .prepare("SELECT * FROM identity_reflections WHERE question_key = ? ORDER BY created_at DESC LIMIT 1")
      .get(questionKey) as IdentityReflectionRow | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this._dbOpen = false;
    try {
      this.db.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "db-close",
        severity: "info",
        subsystem: "identity-reflection-store",
      });
    }
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
