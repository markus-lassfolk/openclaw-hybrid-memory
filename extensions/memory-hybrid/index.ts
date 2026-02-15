/**
 * OpenClaw Memory Hybrid Plugin
 *
 * Two-tier memory system:
 *   1. SQLite + FTS5 — structured facts, instant full-text search, zero API cost
 *   2. LanceDB — semantic vector search for fuzzy/contextual recall
 *
 * Retrieval merges results from both backends, deduplicates, and prioritizes
 * high-confidence FTS5 matches over approximate vector matches.
 */

import { Type } from "@sinclair/typebox";
import * as lancedb from "@lancedb/lancedb";
import Database from "better-sqlite3";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";

import {
  DEFAULT_MEMORY_CATEGORIES,
  getMemoryCategories,
  isValidCategory,
  type MemoryCategory,
  DECAY_CLASSES,
  type DecayClass,
  TTL_DEFAULTS,
  type HybridMemoryConfig,
  hybridConfigSchema,
  vectorDimsForModel,
} from "./config.js";
import { versionInfo } from "./versionInfo.js";

// ============================================================================
// Types
// ============================================================================

type MemoryEntry = {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  entity: string | null;
  key: string | null;
  value: string | null;
  source: string;
  createdAt: number;
  decayClass: DecayClass;
  expiresAt: number | null;
  lastConfirmedAt: number;
  confidence: number;
};

type SearchResult = {
  entry: MemoryEntry;
  score: number;
  backend: "sqlite" | "lancedb";
};

// ============================================================================
// SQLite + FTS5 Backend
// ============================================================================

class FactsDB {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.applyPragmas();

    // Create main table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        importance REAL NOT NULL DEFAULT 0.7,
        entity TEXT,
        key TEXT,
        value TEXT,
        source TEXT NOT NULL DEFAULT 'conversation',
        created_at INTEGER NOT NULL
      )
    `);

    // Create FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        text,
        category,
        entity,
        key,
        value,
        content=facts,
        content_rowid=rowid,
        tokenize='porter unicode61'
      )
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, text, category, entity, key, value)
        VALUES (new.rowid, new.text, new.category, new.entity, new.key, new.value);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, key, value)
        VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.key, old.value);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, key, value)
        VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.key, old.value);
        INSERT INTO facts_fts(rowid, text, category, entity, key, value)
        VALUES (new.rowid, new.text, new.category, new.entity, new.key, new.value);
      END
    `);

    // Index for common queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
      CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
      CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at);
    `);

    // ---- TTL/Decay migration ----
    this.migrateDecayColumns();

    // ---- Fix ms/s unit mismatch from earlier versions ----
    this.migrateTimestampUnits();
  }

  /** Re-apply connection pragmas (used on initial open and auto-reopen). */
  private applyPragmas(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("wal_autocheckpoint = 1000");
  }

  private migrateDecayColumns(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));

    if (colNames.has("decay_class")) return;

    this.db.exec(`
      ALTER TABLE facts ADD COLUMN decay_class TEXT NOT NULL DEFAULT 'stable';
      ALTER TABLE facts ADD COLUMN expires_at INTEGER;
      ALTER TABLE facts ADD COLUMN last_confirmed_at INTEGER;
      ALTER TABLE facts ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facts_expires ON facts(expires_at)
        WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class);
    `);

    this.db.exec(`
      UPDATE facts SET last_confirmed_at = created_at WHERE last_confirmed_at IS NULL;
    `);
  }

  /**
   * Fix timestamp unit mismatch from earlier versions that stored created_at
   * (and potentially last_confirmed_at via the decay migration) in milliseconds
   * while expires_at used seconds.  Any value > 10 000 000 000 is certainly
   * milliseconds — that threshold in seconds is the year 2286.
   */
  private migrateTimestampUnits(): void {
    const MS_THRESHOLD = 10_000_000_000;

    const { cnt } = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM facts WHERE created_at > ?`)
      .get(MS_THRESHOLD) as { cnt: number };

    if (cnt === 0) return;

    this.db.exec(`
      UPDATE facts
      SET created_at = created_at / 1000
      WHERE created_at > ${MS_THRESHOLD}
    `);

    // last_confirmed_at may have been seeded from ms-based created_at
    // by the migrateDecayColumns migration (created_at → last_confirmed_at).
    this.db.exec(`
      UPDATE facts
      SET last_confirmed_at = last_confirmed_at / 1000
      WHERE last_confirmed_at IS NOT NULL
        AND last_confirmed_at > ${MS_THRESHOLD}
    `);
  }

  store(
    entry: Omit<MemoryEntry, "id" | "createdAt" | "decayClass" | "expiresAt" | "lastConfirmedAt" | "confidence"> & {
      decayClass?: DecayClass;
      expiresAt?: number | null;
      confidence?: number;
    },
  ): MemoryEntry {
    const id = randomUUID();
    const nowSec = Math.floor(Date.now() / 1000);

    const decayClass =
      entry.decayClass ||
      classifyDecay(entry.entity, entry.key, entry.value, entry.text);
    const expiresAt =
      entry.expiresAt !== undefined
        ? entry.expiresAt
        : calculateExpiry(decayClass, nowSec);
    const confidence = entry.confidence ?? 1.0;

    this.db
      .prepare(
        `INSERT INTO facts (id, text, category, importance, entity, key, value, source, created_at, decay_class, expires_at, last_confirmed_at, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.text,
        entry.category,
        entry.importance,
        entry.entity,
        entry.key,
        entry.value,
        entry.source,
        nowSec,
        decayClass,
        expiresAt,
        nowSec,
        confidence,
      );

    return {
      ...entry,
      id,
      createdAt: nowSec,
      decayClass,
      expiresAt,
      lastConfirmedAt: nowSec,
      confidence,
    };
  }

  private refreshAccessedFacts(ids: string[]): void {
    if (ids.length === 0) return;
    const nowSec = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      UPDATE facts
      SET last_confirmed_at = @now,
          expires_at = CASE decay_class
            WHEN 'stable' THEN @now + @stableTtl
            WHEN 'active' THEN @now + @activeTtl
            ELSE expires_at
          END
      WHERE id = @id
        AND decay_class IN ('stable', 'active')
    `);

    const tx = this.db.transaction(() => {
      for (const id of ids) {
        stmt.run({
          now: nowSec,
          stableTtl: TTL_DEFAULTS.stable,
          activeTtl: TTL_DEFAULTS.active,
          id,
        });
      }
    });
    tx();
  }

  search(
    query: string,
    limit = 5,
    options: { includeExpired?: boolean } = {},
  ): SearchResult[] {
    const { includeExpired = false } = options;

    const safeQuery = query
      .replace(/['"]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `"${w}"`)
      .join(" OR ");

    if (!safeQuery) return [];

    const nowSec = Math.floor(Date.now() / 1000);
    const expiryFilter = includeExpired
      ? ""
      : "AND (f.expires_at IS NULL OR f.expires_at > @now)";

    const rows = this.db
      .prepare(
        `SELECT f.*, rank,
           CASE
             WHEN f.expires_at IS NULL THEN 1.0
             WHEN f.expires_at <= @now THEN 0.0
             ELSE MIN(1.0, CAST(f.expires_at - @now AS REAL) / CAST(@decay_window AS REAL))
           END AS freshness
         FROM facts f
         JOIN facts_fts fts ON f.rowid = fts.rowid
         WHERE facts_fts MATCH @query
           ${expiryFilter}
         ORDER BY rank
         LIMIT @limit`,
      )
      .all({
        query: safeQuery,
        now: nowSec,
        limit: limit * 2,
        decay_window: 7 * 24 * 3600,
      }) as Array<Record<string, unknown>>;

    if (rows.length === 0) return [];

    const minRank = Math.min(...rows.map((r) => r.rank as number));
    const maxRank = Math.max(...rows.map((r) => r.rank as number));
    const range = maxRank - minRank || 1;

    const results = rows.map((row) => {
      const bm25Score = 1 - ((row.rank as number) - minRank) / range || 0.8;
      const freshness = (row.freshness as number) || 1.0;
      const confidence = (row.confidence as number) || 1.0;
      const composite = bm25Score * 0.6 + freshness * 0.25 + confidence * 0.15;

      return {
        entry: {
          id: row.id as string,
          text: row.text as string,
          category: row.category as MemoryCategory,
          importance: row.importance as number,
          entity: (row.entity as string) || null,
          key: (row.key as string) || null,
          value: (row.value as string) || null,
          source: row.source as string,
          createdAt: row.created_at as number,
          decayClass: (row.decay_class as DecayClass) || "stable",
          expiresAt: (row.expires_at as number) || null,
          lastConfirmedAt: (row.last_confirmed_at as number) || 0,
          confidence,
        },
        score: composite,
        backend: "sqlite" as const,
      };
    });

    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, limit);

    this.refreshAccessedFacts(topResults.map((r) => r.entry.id));

    return topResults;
  }

  lookup(entity: string, key?: string): SearchResult[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const base = key
      ? `SELECT * FROM facts WHERE lower(entity) = lower(?) AND lower(key) = lower(?) AND (expires_at IS NULL OR expires_at > ?) ORDER BY confidence DESC, created_at DESC`
      : `SELECT * FROM facts WHERE lower(entity) = lower(?) AND (expires_at IS NULL OR expires_at > ?) ORDER BY confidence DESC, created_at DESC`;

    const params = key ? [entity, key, nowSec] : [entity, nowSec];
    const rows = this.db.prepare(base).all(...params) as Array<
      Record<string, unknown>
    >;

    const results = rows.map((row) => ({
      entry: {
        id: row.id as string,
        text: row.text as string,
        category: row.category as MemoryCategory,
        importance: row.importance as number,
        entity: (row.entity as string) || null,
        key: (row.key as string) || null,
        value: (row.value as string) || null,
        source: row.source as string,
        createdAt: row.created_at as number,
        decayClass: (row.decay_class as DecayClass) || "stable",
        expiresAt: (row.expires_at as number) || null,
        lastConfirmedAt: (row.last_confirmed_at as number) || 0,
        confidence: (row.confidence as number) || 1.0,
      },
      score: (row.confidence as number) || 1.0,
      backend: "sqlite" as const,
    }));

    this.refreshAccessedFacts(results.map((r) => r.entry.id));

    return results;
  }

  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM facts WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  hasDuplicate(text: string): boolean {
    const row = this.db
      .prepare(`SELECT id FROM facts WHERE text = ? LIMIT 1`)
      .get(text);
    return !!row;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM facts`)
      .get() as Record<string, number>;
    return row.cnt;
  }

  pruneExpired(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare(`DELETE FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .run(nowSec);
    return result.changes;
  }

  decayConfidence(): number {
    const nowSec = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `UPDATE facts
         SET confidence = confidence * 0.5
         WHERE expires_at IS NOT NULL
           AND expires_at > @now
           AND last_confirmed_at IS NOT NULL
           AND (@now - last_confirmed_at) > (expires_at - last_confirmed_at) * 0.75
           AND confidence > 0.1`,
      )
      .run({ now: nowSec });

    const result = this.db
      .prepare(`DELETE FROM facts WHERE confidence < 0.1`)
      .run();
    return result.changes;
  }

  confirmFact(id: string): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare(`SELECT decay_class FROM facts WHERE id = ?`)
      .get(id) as { decay_class: DecayClass } | undefined;
    if (!row) return false;

    const newExpiry = calculateExpiry(row.decay_class, nowSec);
    this.db
      .prepare(
        `UPDATE facts SET confidence = 1.0, last_confirmed_at = ?, expires_at = ? WHERE id = ?`,
      )
      .run(nowSec, newExpiry, id);
    return true;
  }

  saveCheckpoint(context: {
    intent: string;
    state: string;
    expectedOutcome?: string;
    workingFiles?: string[];
  }): string {
    const data = JSON.stringify({
      ...context,
      savedAt: new Date().toISOString(),
    });

    return this.store({
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

  restoreCheckpoint(): {
    id: string;
    intent: string;
    state: string;
    expectedOutcome?: string;
    workingFiles?: string[];
    savedAt: string;
  } | null {
    const nowSec = Math.floor(Date.now() / 1000);
    const row = this.db
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
    } catch {
      return null;
    }
  }

  statsBreakdown(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT decay_class, COUNT(*) as cnt FROM facts GROUP BY decay_class`,
      )
      .all() as Array<{ decay_class: string; cnt: number }>;

    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row.decay_class || "unknown"] = row.cnt;
    }
    return stats;
  }

  countExpired(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?`,
      )
      .get(nowSec) as { cnt: number };
    return row.cnt;
  }

  backfillDecayClasses(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT rowid, entity, key, value, text FROM facts WHERE decay_class = 'stable'`)
      .all() as Array<{ rowid: number; entity: string; key: string; value: string; text: string }>;

    const nowSec = Math.floor(Date.now() / 1000);
    const update = this.db.prepare(
      `UPDATE facts SET decay_class = ?, expires_at = ? WHERE rowid = ?`,
    );

    const counts: Record<string, number> = {};
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const dc = classifyDecay(row.entity, row.key, row.value, row.text);
        if (dc === "stable") continue;
        const exp = calculateExpiry(dc, nowSec);
        update.run(dc, exp, row.rowid);
        counts[dc] = (counts[dc] || 0) + 1;
      }
    });
    tx();
    return counts;
  }

  getByCategory(category: string): MemoryEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM facts WHERE category = ? ORDER BY created_at DESC")
      .all(category);
    return rows.map((row: any) => ({
      id: row.id,
      text: row.text,
      category: row.category,
      importance: row.importance,
      entity: row.entity,
      key: row.key,
      value: row.value,
      source: row.source,
      createdAt: row.created_at,
      decayClass: row.decay_class,
      expiresAt: row.expires_at,
      lastConfirmedAt: row.last_confirmed_at,
      confidence: row.confidence,
    }));
  }

  updateCategory(id: string, category: string): boolean {
    const result = this.db
      .prepare("UPDATE facts SET category = ? WHERE id = ?")
      .run(category, id);
    return result.changes > 0;
  }

  /** Get the live DB handle, reopening if closed after a SIGUSR1 restart. */
  private get liveDb(): Database.Database {
    if (!this.db.open) {
      this.db = new Database(this.dbPath);
      this.applyPragmas();
    }
    return this.db;
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

// ============================================================================
// LanceDB Backend
// ============================================================================

const LANCE_TABLE = "memories";

class VectorDB {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(LANCE_TABLE)) {
      this.table = await this.db.openTable(LANCE_TABLE);
    } else {
      this.table = await this.db.createTable(LANCE_TABLE, [
        {
          id: "__schema__",
          text: "",
          vector: new Array(this.vectorDim).fill(0),
          importance: 0,
          category: "other",
          createdAt: 0,
        },
      ]);
      await this.table.delete('id = "__schema__"');
    }
  }

  async store(entry: {
    text: string;
    vector: number[];
    importance: number;
    category: string;
  }): Promise<string> {
    await this.ensureInitialized();
    const id = randomUUID();
    await this.table!.add([{ ...entry, id, createdAt: Math.floor(Date.now() / 1000) }]);
    return id;
  }

  async search(
    vector: number[],
    limit = 5,
    minScore = 0.3,
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();

    const results = await this.table!.vectorSearch(vector).limit(limit).toArray();

    return results
      .map((row) => {
        const distance = row._distance ?? 0;
        const score = 1 / (1 + distance);
        return {
          entry: {
            id: row.id as string,
            text: row.text as string,
            category: row.category as MemoryCategory,
            importance: row.importance as number,
            entity: null,
            key: null,
            value: null,
            source: "conversation",
            createdAt: (row.createdAt as number) > 10_000_000_000
              ? Math.floor((row.createdAt as number) / 1000)
              : (row.createdAt as number),
            decayClass: "stable" as DecayClass,
            expiresAt: null,
            lastConfirmedAt: 0,
            confidence: 1.0,
          },
          score,
          backend: "lancedb" as const,
        };
      })
      .filter((r) => r.score >= minScore);
  }

  async hasDuplicate(vector: number[], threshold = 0.95): Promise<boolean> {
    await this.ensureInitialized();
    const results = await this.table!.vectorSearch(vector).limit(1).toArray();
    if (results.length === 0) return false;
    const score = 1 / (1 + (results[0]._distance ?? 0));
    return score >= threshold;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) throw new Error(`Invalid ID: ${id}`);
    await this.table!.delete(`id = '${id}'`);
    return true;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.table!.countRows();
  }
}

// ============================================================================
// Embeddings
// ============================================================================

class Embeddings {
  private client: OpenAI;
  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const resp = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return resp.data[0].embedding;
  }
}

// ============================================================================
// Merge & Deduplicate
// ============================================================================

function mergeResults(
  sqliteResults: SearchResult[],
  lanceResults: SearchResult[],
  limit: number,
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const r of sqliteResults) {
    if (!seen.has(r.entry.id)) {
      seen.add(r.entry.id);
      merged.push(r);
    }
  }

  for (const r of lanceResults) {
    const isDupe = merged.some(
      (m) =>
        m.entry.id === r.entry.id ||
        m.entry.text.toLowerCase() === r.entry.text.toLowerCase(),
    );
    if (!isDupe) {
      merged.push(r);
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}

// ============================================================================
// Decay Classification & TTL
// ============================================================================

function calculateExpiry(
  decayClass: DecayClass,
  fromTimestamp = Math.floor(Date.now() / 1000),
): number | null {
  const ttl = TTL_DEFAULTS[decayClass];
  return ttl ? fromTimestamp + ttl : null;
}

function classifyDecay(
  entity: string | null,
  key: string | null,
  value: string | null,
  text: string,
): DecayClass {
  const keyLower = (key || "").toLowerCase();
  const textLower = text.toLowerCase();

  const permanentKeys = [
    "name", "email", "api_key", "api_endpoint", "architecture",
    "decision", "birthday", "born", "phone", "language", "location",
  ];
  if (permanentKeys.some((k) => keyLower.includes(k))) return "permanent";
  if (/\b(decided|architecture|always use|never use)\b/i.test(textLower))
    return "permanent";

  if (entity === "decision" || entity === "convention") return "permanent";

  const sessionKeys = ["current_file", "temp", "debug", "working_on_right_now"];
  if (sessionKeys.some((k) => keyLower.includes(k))) return "session";
  if (/\b(currently debugging|right now|this session)\b/i.test(textLower))
    return "session";

  const activeKeys = ["task", "todo", "wip", "branch", "sprint", "blocker"];
  if (activeKeys.some((k) => keyLower.includes(k))) return "active";
  if (/\b(working on|need to|todo|blocker|sprint)\b/i.test(textLower))
    return "active";

  if (keyLower.includes("checkpoint") || keyLower.includes("preflight"))
    return "checkpoint";

  return "stable";
}

// ============================================================================
// Structured Fact Extraction
// ============================================================================

function extractStructuredFields(
  text: string,
  category: MemoryCategory,
): { entity: string | null; key: string | null; value: string | null } {
  const lower = text.toLowerCase();

  const decisionMatch = text.match(
    /(?:decided|chose|picked|went with|selected|choosing)\s+(?:to\s+)?(?:use\s+)?(.+?)(?:\s+(?:because|since|for|due to|over)\s+(.+?))?\.?$/i,
  );
  if (decisionMatch) {
    return {
      entity: "decision",
      key: decisionMatch[1].trim().slice(0, 100),
      value: decisionMatch[2]?.trim() || "no rationale recorded",
    };
  }

  const choiceMatch = text.match(
    /(?:use|using|chose|prefer|picked)\s+(.+?)\s+(?:over|instead of|rather than)\s+(.+?)(?:\s+(?:because|since|for|due to)\s+(.+?))?\.?$/i,
  );
  if (choiceMatch) {
    return {
      entity: "decision",
      key: `${choiceMatch[1].trim()} over ${choiceMatch[2].trim()}`,
      value: choiceMatch[3]?.trim() || "preference",
    };
  }

  const ruleMatch = text.match(
    /(?:always|never|must|should always|should never)\s+(.+?)\.?$/i,
  );
  if (ruleMatch) {
    return {
      entity: "convention",
      key: ruleMatch[1].trim().slice(0, 100),
      value: lower.includes("never") ? "never" : "always",
    };
  }

  const possessiveMatch = text.match(
    /(?:(\w+(?:\s+\w+)?)'s|[Mm]y)\s+(.+?)\s+(?:is|are|was)\s+(.+?)\.?$/,
  );
  if (possessiveMatch) {
    return {
      entity: possessiveMatch[1] || "user",
      key: possessiveMatch[2].trim(),
      value: possessiveMatch[3].trim(),
    };
  }

  const preferMatch = text.match(
    /[Ii]\s+(prefer|like|love|hate|want|need|use)\s+(.+?)\.?$/,
  );
  if (preferMatch) {
    return {
      entity: "user",
      key: preferMatch[1],
      value: preferMatch[2].trim(),
    };
  }

  const emailMatch = text.match(/([\w.-]+@[\w.-]+\.\w+)/);
  if (emailMatch) {
    return { entity: null, key: "email", value: emailMatch[1] };
  }

  const phoneMatch = text.match(/(\+?\d{10,})/);
  if (phoneMatch) {
    return { entity: null, key: "phone", value: phoneMatch[1] };
  }

  if (category === "entity") {
    const words = text.split(/\s+/);
    const properNouns = words.filter((w) => /^[A-Z][a-z]+/.test(w));
    if (properNouns.length > 0) {
      return { entity: properNouns[0], key: null, value: null };
    }
  }

  return { entity: null, key: null, value: null };
}

// ============================================================================
// Auto-capture Filters
// ============================================================================

const MEMORY_TRIGGERS = [
  /remember|zapamatuj si|pamatuj/i,
  /prefer|radši|nechci/i,
  /decided|rozhodli jsme|budeme používat/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important/i,
  /born on|birthday|lives in|works at/i,
  /password is|api key|token is/i,
  /chose|selected|went with|picked/i,
  /over.*because|instead of.*since/i,
  /\balways\b.*\buse\b|\bnever\b.*\buse\b/i,
  /architecture|stack|approach/i,
];

const SENSITIVE_PATTERNS = [
  /password/i,
  /api.?key/i,
  /secret/i,
  /token\s+is/i,
  /\bssn\b/i,
  /credit.?card/i,
];

function shouldCapture(text: string): boolean {
  if (text.length < 10 || text.length > 500) return false;
  if (text.includes("<relevant-memories>")) return false;
  if (text.startsWith("<") && text.includes("</")) return false;
  if (text.includes("**") && text.includes("\n-")) return false;
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  if (SENSITIVE_PATTERNS.some((r) => r.test(text))) return false;
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}

function detectCategory(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  if (/decided|chose|went with|selected|always use|never use|over.*because|instead of.*since|rozhodli|will use|budeme/i.test(lower))
    return "decision";
  if (/prefer|radši|like|love|hate|want/i.test(lower)) return "preference";
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se/i.test(lower))
    return "entity";
  if (/born|birthday|lives|works|is\s|are\s|has\s|have\s/i.test(lower))
    return "fact";
  return "other";
}

// ============================================================================
// LLM-based Auto-Classifier
// ============================================================================

/**
 * Classify a batch of "other" facts into proper categories using a cheap LLM.
 * Returns a map of factId → newCategory.
 */
async function classifyBatch(
  openai: OpenAI,
  model: string,
  facts: { id: string; text: string }[],
  categories: readonly string[],
): Promise<Map<string, string>> {
  const catList = categories.filter((c) => c !== "other").join(", ");
  const factLines = facts
    .map((f, i) => `${i + 1}. ${f.text.slice(0, 300)}`)
    .join("\n");

  const prompt = `You are a memory classifier. Categorize each fact into exactly one category.

Available categories: ${catList}
Use "other" ONLY if no category fits at all.

Facts to classify:
${factLines}

Respond with ONLY a JSON array of category strings, one per fact, in order. Example: ["fact","entity","preference"]`;

  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: facts.length * 20,
    });

    const content = resp.choices[0]?.message?.content?.trim() || "[]";
    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return new Map();

    const results: string[] = JSON.parse(jsonMatch[0]);
    const map = new Map<string, string>();

    for (let i = 0; i < Math.min(results.length, facts.length); i++) {
      const cat = results[i]?.toLowerCase()?.trim();
      if (cat && cat !== "other" && isValidCategory(cat)) {
        map.set(facts[i].id, cat);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Run auto-classification on all "other" facts. Called on schedule or manually.
 * Also suggests new categories if clusters are found.
 */
async function runAutoClassify(
  db: FactsDB,
  openai: OpenAI,
  config: { model: string; batchSize: number },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ reclassified: number; suggested: string[] }> {
  const categories = getMemoryCategories();

  // Get all "other" facts
  const others = db.getByCategory("other");
  if (others.length === 0) {
    return { reclassified: 0, suggested: [] };
  }

  logger.info(`memory-hybrid: auto-classify starting on ${others.length} "other" facts`);

  let totalReclassified = 0;

  // Process in batches
  for (let i = 0; i < others.length; i += config.batchSize) {
    const batch = others.slice(i, i + config.batchSize).map((e) => ({
      id: e.id,
      text: e.text,
    }));

    const results = await classifyBatch(openai, config.model, batch, categories);

    for (const [id, newCat] of results) {
      db.updateCategory(id, newCat);
      totalReclassified++;
    }

    // Small delay between batches to avoid rate limits
    if (i + config.batchSize < others.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  logger.info(`memory-hybrid: auto-classify done — reclassified ${totalReclassified}/${others.length} facts`);
  return { reclassified: totalReclassified, suggested: [] };
}

// ============================================================================
// Plugin Definition
// ============================================================================

// Mutable module-level state so that ALL closures (tools, event handlers,
// timers) always see the *current* instances — even after a SIGUSR1 reload
// where stop() closes the old DB and register() creates a new one.
// Without this, old closures captured const locals from the first register()
// call and kept using a closed database after restart.
let cfg: HybridMemoryConfig;
let resolvedLancePath: string;
let resolvedSqlitePath: string;
let factsDb: FactsDB;
let vectorDb: VectorDB;
let embeddings: Embeddings;
let openaiClient: OpenAI;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let classifyTimer: ReturnType<typeof setInterval> | null = null;
let classifyStartupTimeout: ReturnType<typeof setTimeout> | null = null;

const memoryHybridPlugin = {
  id: "memory-hybrid",
  name: "Memory (Hybrid: SQLite + LanceDB)",
  description:
    "Two-tier memory: SQLite+FTS5 for structured facts, LanceDB for semantic search",
  kind: "memory" as const,
  configSchema: hybridConfigSchema,
  versionInfo,

  register(api: ClawdbotPluginApi) {
    cfg = hybridConfigSchema.parse(api.pluginConfig);
    resolvedLancePath = api.resolvePath(cfg.lanceDbPath);
    resolvedSqlitePath = api.resolvePath(cfg.sqlitePath);
    const vectorDim = vectorDimsForModel(cfg.embedding.model);

    factsDb = new FactsDB(resolvedSqlitePath);
    vectorDb = new VectorDB(resolvedLancePath, vectorDim);
    embeddings = new Embeddings(cfg.embedding.apiKey, cfg.embedding.model);
    openaiClient = new OpenAI({ apiKey: cfg.embedding.apiKey });

    api.logger.info(
      `memory-hybrid: registered (v${versionInfo.pluginVersion}, memory-manager ${versionInfo.memoryManagerVersion}) sqlite: ${resolvedSqlitePath}, lance: ${resolvedLancePath}`,
    );

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall",
        description:
          "Search through long-term memories using both structured (exact) and semantic (fuzzy) search.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default: 5)" }),
          ),
          entity: Type.Optional(
            Type.String({
              description: "Optional: filter by entity name for exact lookup",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            limit = 5,
            entity,
          } = params as { query: string; limit?: number; entity?: string };

          let sqliteResults: SearchResult[] = [];
          if (entity) {
            sqliteResults = factsDb.lookup(entity);
          }

          const ftsResults = factsDb.search(query, limit);
          sqliteResults = [...sqliteResults, ...ftsResults];

          let lanceResults: SearchResult[] = [];
          try {
            const vector = await embeddings.embed(query);
            lanceResults = await vectorDb.search(vector, limit, 0.3);
          } catch (err) {
            api.logger.warn(`memory-hybrid: vector search failed: ${err}`);
          }

          const results = mergeResults(sqliteResults, lanceResults, limit);

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant memories found." }],
              details: { count: 0 },
            };
          }

          const text = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.backend}/${r.entry.category}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%)`,
            )
            .join("\n");

          const sanitized = results.map((r) => ({
            id: r.entry.id,
            text: r.entry.text,
            category: r.entry.category,
            entity: r.entry.entity,
            importance: r.entry.importance,
            score: r.score,
            backend: r.backend,
          }));

          return {
            content: [
              {
                type: "text",
                text: `Found ${results.length} memories:\n\n${text}`,
              },
            ],
            details: { count: results.length, memories: sanitized },
          };
        },
      },
      { name: "memory_recall" },
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save important information in long-term memory. Stores to both structured (SQLite) and semantic (LanceDB) backends.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          importance: Type.Optional(
            Type.Number({ description: "Importance 0-1 (default: 0.7)" }),
          ),
          category: Type.Optional(
            stringEnum(getMemoryCategories() as unknown as readonly string[]),
          ),
          entity: Type.Optional(
            Type.String({
              description: "Entity name (person, project, tool, etc.)",
            }),
          ),
          key: Type.Optional(
            Type.String({
              description: "Structured key (e.g. 'birthday', 'email')",
            }),
          ),
          value: Type.Optional(
            Type.String({
              description: "Structured value (e.g. 'Nov 13', 'john@example.com')",
            }),
          ),
          decayClass: Type.Optional(
            stringEnum(DECAY_CLASSES as unknown as readonly string[]),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            text,
            importance = 0.7,
            category = "other",
            entity: paramEntity,
            key: paramKey,
            value: paramValue,
            decayClass: paramDecayClass,
          } = params as {
            text: string;
            importance?: number;
            category?: MemoryCategory;
            entity?: string;
            key?: string;
            value?: string;
            decayClass?: DecayClass;
          };

          if (factsDb.hasDuplicate(text)) {
            return {
              content: [
                { type: "text", text: `Similar memory already exists.` },
              ],
              details: { action: "duplicate" },
            };
          }

          const extracted = extractStructuredFields(text, category as MemoryCategory);
          const entity = paramEntity || extracted.entity;
          const key = paramKey || extracted.key;
          const value = paramValue || extracted.value;

          const entry = factsDb.store({
            text,
            category: category as MemoryCategory,
            importance,
            entity,
            key,
            value,
            source: "conversation",
            decayClass: paramDecayClass,
          });

          try {
            const vector = await embeddings.embed(text);
            if (!(await vectorDb.hasDuplicate(vector))) {
              await vectorDb.store({
                text,
                vector,
                importance,
                category,
              });
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
          }

          return {
            content: [
              {
                type: "text",
                text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"${entity ? ` [entity: ${entity}]` : ""} [decay: ${entry.decayClass}]`,
              },
            ],
            details: { action: "created", id: entry.id, backend: "both", decayClass: entry.decayClass },
          };
        },
      },
      { name: "memory_store" },
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description: "Delete specific memories from both backends.",
        parameters: Type.Object({
          query: Type.Optional(
            Type.String({ description: "Search to find memory" }),
          ),
          memoryId: Type.Optional(
            Type.String({ description: "Specific memory ID" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, memoryId } = params as {
            query?: string;
            memoryId?: string;
          };

          if (memoryId) {
            const sqlDeleted = factsDb.delete(memoryId);
            let lanceDeleted = false;
            try {
              lanceDeleted = await vectorDb.delete(memoryId);
            } catch {}

            return {
              content: [
                {
                  type: "text",
                  text: `Memory ${memoryId} forgotten (sqlite: ${sqlDeleted}, lance: ${lanceDeleted}).`,
                },
              ],
              details: { action: "deleted", id: memoryId },
            };
          }

          if (query) {
            const sqlResults = factsDb.search(query, 5);
            let lanceResults: SearchResult[] = [];
            try {
              const vector = await embeddings.embed(query);
              lanceResults = await vectorDb.search(vector, 5, 0.7);
            } catch {}

            const results = mergeResults(sqlResults, lanceResults, 5);

            if (results.length === 0) {
              return {
                content: [
                  { type: "text", text: "No matching memories found." },
                ],
                details: { found: 0 },
              };
            }

            if (results.length === 1 && results[0].score > 0.9) {
              const id = results[0].entry.id;
              factsDb.delete(id);
              try {
                await vectorDb.delete(id);
              } catch {}
              return {
                content: [
                  {
                    type: "text",
                    text: `Forgotten: "${results[0].entry.text}"`,
                  },
                ],
                details: { action: "deleted", id },
              };
            }

            const list = results
              .map(
                (r) =>
                  `- [${r.entry.id.slice(0, 8)}] (${r.backend}) ${r.entry.text.slice(0, 60)}...`,
              )
              .join("\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                },
              ],
              details: {
                action: "candidates",
                candidates: results.map((r) => ({
                  id: r.entry.id,
                  text: r.entry.text,
                  backend: r.backend,
                  score: r.score,
                })),
              },
            };
          }

          return {
            content: [{ type: "text", text: "Provide query or memoryId." }],
            details: { error: "missing_param" },
          };
        },
      },
      { name: "memory_forget" },
    );

    api.registerTool(
      {
        name: "memory_checkpoint",
        label: "Memory Checkpoint",
        description:
          "Save or restore pre-flight checkpoints before risky/long operations. Auto-expires after 4 hours.",
        parameters: Type.Object({
          action: stringEnum(["save", "restore"] as const),
          intent: Type.Optional(
            Type.String({ description: "What you're about to do (for save)" }),
          ),
          state: Type.Optional(
            Type.String({ description: "Current state/context (for save)" }),
          ),
          expectedOutcome: Type.Optional(
            Type.String({ description: "What should happen if successful" }),
          ),
          workingFiles: Type.Optional(
            Type.Array(Type.String(), {
              description: "Files being modified",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { action, intent, state, expectedOutcome, workingFiles } =
            params as {
              action: "save" | "restore";
              intent?: string;
              state?: string;
              expectedOutcome?: string;
              workingFiles?: string[];
            };

          if (action === "save") {
            if (!intent || !state) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Checkpoint save requires 'intent' and 'state'.",
                  },
                ],
                details: { error: "missing_param" },
              };
            }
            const id = factsDb.saveCheckpoint({
              intent,
              state,
              expectedOutcome,
              workingFiles,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Checkpoint saved (id: ${id.slice(0, 8)}..., TTL: 4h). Intent: ${intent.slice(0, 80)}`,
                },
              ],
              details: { action: "saved", id },
            };
          }

          const checkpoint = factsDb.restoreCheckpoint();
          if (!checkpoint) {
            return {
              content: [
                {
                  type: "text",
                  text: "No active checkpoint found (may have expired).",
                },
              ],
              details: { action: "not_found" },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Restored checkpoint (saved: ${checkpoint.savedAt}):\n- Intent: ${checkpoint.intent}\n- State: ${checkpoint.state}${checkpoint.expectedOutcome ? `\n- Expected: ${checkpoint.expectedOutcome}` : ""}${checkpoint.workingFiles?.length ? `\n- Files: ${checkpoint.workingFiles.join(", ")}` : ""}`,
              },
            ],
            details: { action: "restored", checkpoint },
          };
        },
      },
      { name: "memory_checkpoint" },
    );

    api.registerTool(
      {
        name: "memory_prune",
        label: "Memory Prune",
        description:
          "Prune expired memories and decay confidence of aging facts.",
        parameters: Type.Object({
          mode: Type.Optional(
            stringEnum(["hard", "soft", "both"] as const),
          ),
        }),
        async execute(_toolCallId, params) {
          const { mode = "both" } = params as { mode?: "hard" | "soft" | "both" };

          let hardPruned = 0;
          let softPruned = 0;

          if (mode === "hard" || mode === "both") {
            hardPruned = factsDb.pruneExpired();
          }
          if (mode === "soft" || mode === "both") {
            softPruned = factsDb.decayConfidence();
          }

          const breakdown = factsDb.statsBreakdown();
          const expired = factsDb.countExpired();

          return {
            content: [
              {
                type: "text",
                text: `Pruned: ${hardPruned} expired + ${softPruned} low-confidence.\nRemaining by class: ${JSON.stringify(breakdown)}\nPending expired: ${expired}`,
              },
            ],
            details: { hardPruned, softPruned, breakdown, pendingExpired: expired },
          };
        },
      },
      { name: "memory_prune" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const mem = program
          .command("hybrid-mem")
          .description("Hybrid memory plugin commands");

        mem
          .command("stats")
          .description("Show memory statistics with decay breakdown")
          .action(async () => {
            const sqlCount = factsDb.count();
            const lanceCount = await vectorDb.count();
            const breakdown = factsDb.statsBreakdown();
            const expired = factsDb.countExpired();

            console.log(`memory-hybrid ${versionInfo.pluginVersion} (memory-manager ${versionInfo.memoryManagerVersion}, schema ${versionInfo.schemaVersion})`);
            console.log(`SQLite facts:    ${sqlCount}`);
            console.log(`LanceDB vectors: ${lanceCount}`);
            console.log(`Total: ${sqlCount + lanceCount} (with overlap)`);
            console.log(`\nBy decay class:`);
            for (const [cls, cnt] of Object.entries(breakdown)) {
              console.log(`  ${cls.padEnd(12)} ${cnt}`);
            }
            if (expired > 0) {
              console.log(`\nExpired (pending prune): ${expired}`);
            }
          });

        mem
          .command("prune")
          .description("Remove expired facts and decay aging confidence")
          .option("--hard", "Only hard-delete expired facts")
          .option("--soft", "Only soft-decay confidence")
          .option("--dry-run", "Show what would be pruned without deleting")
          .action(async (opts) => {
            if (opts.dryRun) {
              const expired = factsDb.countExpired();
              console.log(`Would prune: ${expired} expired facts`);
              return;
            }
            let hardPruned = 0;
            let softPruned = 0;
            if (opts.hard) {
              hardPruned = factsDb.pruneExpired();
            } else if (opts.soft) {
              softPruned = factsDb.decayConfidence();
            } else {
              hardPruned = factsDb.pruneExpired();
              softPruned = factsDb.decayConfidence();
            }
            console.log(`Hard-pruned: ${hardPruned} expired`);
            console.log(`Soft-pruned: ${softPruned} low-confidence`);
          });

        mem
          .command("checkpoint")
          .description("Save or restore a pre-flight checkpoint")
          .argument("<action>", "save or restore")
          .option("--intent <text>", "Intent for save")
          .option("--state <text>", "State for save")
          .action(async (action, opts) => {
            if (action === "save") {
              if (!opts.intent || !opts.state) {
                console.error("--intent and --state required for save");
                return;
              }
              const id = factsDb.saveCheckpoint({
                intent: opts.intent,
                state: opts.state,
              });
              console.log(`Checkpoint saved: ${id}`);
            } else if (action === "restore") {
              const cp = factsDb.restoreCheckpoint();
              if (!cp) {
                console.log("No active checkpoint.");
                return;
              }
              console.log(JSON.stringify(cp, null, 2));
            } else {
              console.error('Usage: checkpoint <save|restore>');
            }
          });

        mem
          .command("backfill-decay")
          .description("Re-classify existing facts with auto-detected decay classes")
          .action(async () => {
            const counts = factsDb.backfillDecayClasses();
            if (Object.keys(counts).length === 0) {
              console.log("All facts already properly classified.");
            } else {
              console.log("Reclassified:");
              for (const [cls, cnt] of Object.entries(counts)) {
                console.log(`  ${cls}: ${cnt}`);
              }
            }
          });

        mem
          .command("extract-daily")
          .description("Extract structured facts from daily memory files")
          .option("--days <n>", "How many days back to scan", "7")
          .option("--dry-run", "Show extractions without storing")
          .action(async (opts: { days: string; dryRun?: boolean }) => {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const { homedir: getHomedir } = await import("node:os");
            const memoryDir = path.join(getHomedir(), ".openclaw", "memory");
            const daysBack = parseInt(opts.days);

            let totalExtracted = 0;
            let totalStored = 0;

            for (let d = 0; d < daysBack; d++) {
              const date = new Date();
              date.setDate(date.getDate() - d);
              const dateStr = date.toISOString().split("T")[0];
              const filePath = path.join(memoryDir, `${dateStr}.md`);

              if (!fs.existsSync(filePath)) continue;

              const content = fs.readFileSync(filePath, "utf-8");
              const lines = content.split("\n").filter((l: string) => l.trim().length > 10);

              console.log(`\nScanning ${dateStr} (${lines.length} lines)...`);

              for (const line of lines) {
                const trimmed = line.replace(/^[-*#>\s]+/, "").trim();
                if (trimmed.length < 15 || trimmed.length > 500) continue;
                if (SENSITIVE_PATTERNS.some((r) => r.test(trimmed))) continue;

                const category = detectCategory(trimmed);
                const extracted = extractStructuredFields(trimmed, category);

                if (!extracted.entity && !extracted.key && category !== "decision") continue;

                totalExtracted++;

                if (opts.dryRun) {
                  console.log(
                    `  [${category}] ${extracted.entity || "?"} / ${extracted.key || "?"} = ${
                      extracted.value || trimmed.slice(0, 60)
                    }`,
                  );
                  continue;
                }

                if (factsDb.hasDuplicate(trimmed)) continue;

                factsDb.store({
                  text: trimmed,
                  category,
                  importance: 0.8,
                  entity: extracted.entity,
                  key: extracted.key,
                  value: extracted.value,
                  source: `daily-scan:${dateStr}`,
                });
                totalStored++;
              }
            }

            if (opts.dryRun) {
              console.log(
                `\nWould extract: ${totalExtracted} facts from last ${daysBack} days`,
              );
            } else {
              console.log(
                `\nExtracted ${totalStored} new facts (${totalExtracted} candidates, ${
                  totalExtracted - totalStored
                } duplicates skipped)`,
              );
            }
          });

        mem
          .command("search")
          .description("Search memories across both backends")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query, opts) => {
            const limit = parseInt(opts.limit);
            const sqlResults = factsDb.search(query, limit);
            const vector = await embeddings.embed(query);
            const lanceResults = await vectorDb.search(vector, limit, 0.3);
            const merged = mergeResults(sqlResults, lanceResults, limit);

            const output = merged.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              entity: r.entry.entity,
              score: r.score,
              backend: r.backend,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        mem
          .command("lookup")
          .description("Exact entity lookup in SQLite")
          .argument("<entity>", "Entity name")
          .option("--key <key>", "Optional key filter")
          .action(async (entity, opts) => {
            const results = factsDb.lookup(entity, opts.key);
            const output = results.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              entity: r.entry.entity,
              key: r.entry.key,
              value: r.entry.value,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        mem
          .command("classify")
          .description("Auto-classify 'other' facts using LLM (uses autoClassify config)")
          .option("--dry-run", "Show classifications without applying")
          .option("--limit <n>", "Max facts to classify", "500")
          .option("--model <model>", "Override LLM model")
          .action(async (opts: { dryRun?: boolean; limit?: string; model?: string }) => {
            const classifyModel = opts.model || cfg.autoClassify.model;
            const limit = parseInt(opts.limit || "500");

            console.log(`Auto-classify config:`);
            console.log(`  Model: ${classifyModel}`);
            console.log(`  Batch size: ${cfg.autoClassify.batchSize}`);
            console.log(`  Categories: ${getMemoryCategories().join(", ")}`);
            console.log(`  Limit: ${limit}`);
            console.log(`  Dry run: ${!!opts.dryRun}\n`);

            const others = factsDb.getByCategory("other").slice(0, limit);
            console.log(`Found ${others.length} "other" facts to classify\n`);

            if (others.length === 0) return;

            let totalReclassified = 0;

            for (let i = 0; i < others.length; i += cfg.autoClassify.batchSize) {
              const batch = others.slice(i, i + cfg.autoClassify.batchSize).map((e) => ({
                id: e.id,
                text: e.text,
              }));

              const results = await classifyBatch(
                openaiClient,
                classifyModel,
                batch,
                getMemoryCategories(),
              );

              for (const [id, newCat] of results) {
                const fact = batch.find((f) => f.id === id);
                if (opts.dryRun) {
                  console.log(`  [${newCat}] ${fact?.text?.slice(0, 80)}...`);
                } else {
                  factsDb.updateCategory(id, newCat);
                }
                totalReclassified++;
              }

              process.stdout.write(`  Processed ${Math.min(i + cfg.autoClassify.batchSize, others.length)}/${others.length}\r`);

              if (i + cfg.autoClassify.batchSize < others.length) {
                await new Promise((r) => setTimeout(r, 500));
              }
            }

            console.log(`\n\nResult: ${totalReclassified}/${others.length} reclassified${opts.dryRun ? " (dry run)" : ""}`);

            // Show updated stats
            if (!opts.dryRun) {
              const breakdown = factsDb.statsBreakdown();
              console.log("\nUpdated category breakdown:");
              for (const [cat, count] of Object.entries(breakdown)) {
                console.log(`  ${cat}: ${count}`);
              }
            }
          });

        mem
          .command("categories")
          .description("List all configured memory categories")
          .action(() => {
            const cats = getMemoryCategories();
            console.log(`Memory categories (${cats.length}):`);
            for (const cat of cats) {
              const count = factsDb.getByCategory(cat).length;
              console.log(`  ${cat}: ${count} facts`);
            }
          });
      },
      { commands: ["hybrid-mem", "hybrid-mem stats", "hybrid-mem prune", "hybrid-mem checkpoint", "hybrid-mem backfill-decay", "hybrid-mem extract-daily", "hybrid-mem search", "hybrid-mem lookup", "hybrid-mem classify", "hybrid-mem categories"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) return;

        try {
          const ftsResults = factsDb.search(event.prompt, 3);

          let lanceResults: SearchResult[] = [];
          try {
            const vector = await embeddings.embed(event.prompt);
            lanceResults = await vectorDb.search(vector, 3, 0.3);
          } catch (err) {
            api.logger.warn(
              `memory-hybrid: vector recall failed: ${err}`,
            );
          }

          const results = mergeResults(ftsResults, lanceResults, 5);
          if (results.length === 0) return;

          const memoryContext = results
            .map(
              (r) =>
                `- [${r.backend}/${r.entry.category}] ${r.entry.text}`,
            )
            .join("\n");

          api.logger.info?.(
            `memory-hybrid: injecting ${results.length} memories (sqlite: ${ftsResults.length}, lance: ${lanceResults.length})`,
          );

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-hybrid: recall failed: ${String(err)}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") continue;

            const content = msgObj.content;
            if (typeof content === "string") {
              texts.push(content);
              continue;
            }
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  texts.push(
                    (block as Record<string, unknown>).text as string,
                  );
                }
              }
            }
          }

          const toCapture = texts.filter((t) => t && shouldCapture(t));
          if (toCapture.length === 0) return;

          let stored = 0;
          for (const text of toCapture.slice(0, 3)) {
            // Heuristic classification only — "other" facts are reclassified
            // by the daily auto-classify timer (no LLM calls on the hot path)
            const category: MemoryCategory = detectCategory(text);
            const extracted = extractStructuredFields(text, category);

            if (factsDb.hasDuplicate(text)) continue;

            factsDb.store({
              text,
              category,
              importance: 0.7,
              entity: extracted.entity,
              key: extracted.key,
              value: extracted.value,
              source: "auto-capture",
            });

            try {
              const vector = await embeddings.embed(text);
              if (!(await vectorDb.hasDuplicate(vector))) {
                await vectorDb.store({ text, vector, importance: 0.7, category });
              }
            } catch (err) {
              api.logger.warn(
                `memory-hybrid: vector capture failed: ${err}`,
              );
            }

            stored++;
          }

          if (stored > 0) {
            api.logger.info(
              `memory-hybrid: auto-captured ${stored} memories`,
            );
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-hybrid",
      start: () => {
        const sqlCount = factsDb.count();
        const expired = factsDb.countExpired();
        api.logger.info(
          `memory-hybrid: initialized v${versionInfo.pluginVersion} (sqlite: ${sqlCount} facts, lance: ${resolvedLancePath}, model: ${cfg.embedding.model})`,
        );

        if (expired > 0) {
          const pruned = factsDb.pruneExpired();
          api.logger.info(`memory-hybrid: startup prune removed ${pruned} expired facts`);
        }

        pruneTimer = setInterval(() => {
          try {
            const hardPruned = factsDb.pruneExpired();
            const softPruned = factsDb.decayConfidence();
            if (hardPruned > 0 || softPruned > 0) {
              api.logger.info(
                `memory-hybrid: periodic prune — ${hardPruned} expired, ${softPruned} decayed`,
              );
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid: periodic prune failed: ${err}`);
          }
        }, 60 * 60_000); // every hour

        // Daily auto-classify: reclassify "other" facts using LLM (if enabled)
        if (cfg.autoClassify.enabled) {
          const CLASSIFY_INTERVAL = 24 * 60 * 60_000; // 24 hours

          // Run once shortly after startup (5 min delay to let things settle)
          classifyStartupTimeout = setTimeout(async () => {
            try {
              await runAutoClassify(factsDb, openaiClient, cfg.autoClassify, api.logger);
            } catch (err) {
              api.logger.warn(`memory-hybrid: startup auto-classify failed: ${err}`);
            }
          }, 5 * 60_000);

          classifyTimer = setInterval(async () => {
            try {
              await runAutoClassify(factsDb, openaiClient, cfg.autoClassify, api.logger);
            } catch (err) {
              api.logger.warn(`memory-hybrid: daily auto-classify failed: ${err}`);
            }
          }, CLASSIFY_INTERVAL);

          api.logger.info(
            `memory-hybrid: auto-classify enabled (model: ${cfg.autoClassify.model}, interval: 24h, batch: ${cfg.autoClassify.batchSize})`,
          );
        }
      },
      stop: () => {
        if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
        if (classifyStartupTimeout) { clearTimeout(classifyStartupTimeout); classifyStartupTimeout = null; }
        if (classifyTimer) { clearInterval(classifyTimer); classifyTimer = null; }
        factsDb.close();
        api.logger.info("memory-hybrid: stopped");
      },
    });
  },
};

export { versionInfo } from "./versionInfo.js";
export default memoryHybridPlugin;