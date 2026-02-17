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
import { createHash, randomUUID, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";

import {
  DEFAULT_MEMORY_CATEGORIES,
  getMemoryCategories,
  setMemoryCategories,
  isValidCategory,
  type MemoryCategory,
  DECAY_CLASSES,
  type DecayClass,
  TTL_DEFAULTS,
  type HybridMemoryConfig,
  hybridConfigSchema,
  vectorDimsForModel,
  CREDENTIAL_TYPES,
  type CredentialType,
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
  /** When the fact originated (e.g. session date for distilled facts). Unix seconds. Null = use createdAt. */
  sourceDate?: number | null;
  decayClass: DecayClass;
  expiresAt: number | null;
  lastConfirmedAt: number;
  confidence: number;
  /** Short summary for long facts; used in injection when useSummaryInInjection (4.3) */
  summary?: string | null;
  /** Topic tags for sharper retrieval (FR-001); e.g. nibe, zigbee, auth */
  tags?: string[] | null;
  /** FR-005: Number of times this fact has been retrieved via search/recall */
  recallCount?: number;
  /** FR-005: Last time this fact was accessed (unix seconds) */
  lastAccessed?: number | null;
  /** FR-008/010: When this fact was superseded by a newer version (unix seconds; null = current) */
  supersededAt?: number | null;
  /** FR-008/010: ID of the fact that superseded this one */
  supersededBy?: string | null;
};

type SearchResult = {
  entry: MemoryEntry;
  score: number;
  backend: "sqlite" | "lancedb";
};

// ============================================================================
// SQLite + FTS5 Backend
// ============================================================================

/** Normalize text for fuzzy dedupe (2.3): trim, collapse whitespace, lowercase. */
function normalizeTextForDedupe(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedHash(text: string): string {
  return createHash("sha256").update(normalizeTextForDedupe(text)).digest("hex");
}

/** Tag patterns: [tag, regex]. Order matters; first match wins. */
const TAG_PATTERNS: Array<[string, RegExp]> = [
  ["nibe", /\bnibe\b/i],
  ["zigbee", /\bzigbee\b/i],
  ["z-wave", /\bz-?wave\b/i],
  ["auth", /\bauth(entication|orization)?\b/i],
  ["homeassistant", /\bhome[- ]?assistant\b/i],
  ["openclaw", /\bopenclaw\b/i],
  ["postgres", /\bpostgres(ql)?\b/i],
  ["sqlite", /\bsqlite\b/i],
  ["lancedb", /\blancedb\b/i],
  ["api", /\bapi\s+(key|endpoint|url)\b/i],
  ["docker", /\bdocker\b/i],
  ["kubernetes", /\bkubernetes|k8s\b/i],
  ["ha", /\bha\b/i],
];

/** Extract topic tags from text (FR-001). Returns lowercase, deduplicated tags. */
function extractTags(text: string, entity?: string | null): string[] {
  const combined = [text, entity].filter(Boolean).join(" ").toLowerCase();
  const seen = new Set<string>();
  for (const [tag, re] of TAG_PATTERNS) {
    if (re.test(combined) && !seen.has(tag)) {
      seen.add(tag);
    }
  }
  return [...seen];
}

/** Serialize tags for SQLite storage (comma-separated). */
function serializeTags(tags: string[]): string | null {
  if (tags.length === 0) return null;
  return tags.join(",");
}

/** Parse tags from SQLite (comma-separated). */
function parseTags(s: string | null | undefined): string[] {
  if (!s || typeof s !== "string") return [];
  return s
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/** Check if tags string contains tag (comma-separated, exact match). */
function tagsContains(tagsStr: string | null | undefined, tag: string): boolean {
  if (!tagsStr) return false;
  const tagLower = tag.toLowerCase().trim();
  return parseTags(tagsStr).includes(tagLower);
}

/** Parse sourceDate from ISO-8601 (YYYY-MM-DD) or Unix timestamp (seconds). Date strings are interpreted as UTC midnight for consistent ordering across timezones. Returns null if invalid. */
function parseSourceDate(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2})?/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    const ms = Date.UTC(parseInt(y!, 10), parseInt(m!, 10) - 1, parseInt(d!, 10));
    return isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  const n = parseInt(s, 10);
  return !isNaN(n) && n > 0 ? n : null;
}

// ============================================================================
// Write-Ahead Log (WAL) for Crash Resilience
// ============================================================================

type WALEntry = {
  id: string;
  timestamp: number;
  operation: "store" | "delete" | "update";
  data: {
    text: string;
    category?: string;
    importance?: number;
    entity?: string | null;
    key?: string | null;
    value?: string | null;
    source?: string;
    decayClass?: DecayClass;
    summary?: string | null;
    tags?: string[];
    vector?: number[];
  };
};

class WriteAheadLog {
  private walPath: string;
  private maxAge: number;
  private logger?: { warn: (msg: string) => void };

  constructor(walPath: string, maxAge: number = 300000, logger?: { warn: (msg: string) => void }) {
    this.walPath = walPath;
    this.maxAge = maxAge;
    this.logger = logger;
    mkdirSync(dirname(walPath), { recursive: true });
    
    // Initialize WAL file if it doesn't exist
    if (!existsSync(walPath)) {
      writeFileSync(walPath, "", "utf-8");
    }
  }

  write(entry: WALEntry): void {
    // Append entry as newline-delimited JSON for O(1) writes
    const line = JSON.stringify(entry) + "\n";
    try {
      const fd = openSync(this.walPath, "a");
      writeSync(fd, line);
      closeSync(fd);
    } catch (err) {
      this.logger?.warn(`memory-hybrid: WAL append failed (${err}), falling back to read-modify-write`);
      // Fallback to less efficient method if append fails
      const entries = this.readAll();
      entries.push(entry);
      this.writeAll(entries);
    }
  }

  remove(id: string): void {
    // Read all entries, filter out the one to remove, and rewrite
    const entries = this.readAll();
    const filtered = entries.filter((e) => e.id !== id);
    this.writeAll(filtered);
  }

  readAll(): WALEntry[] {
    try {
      const content = readFileSync(this.walPath, "utf-8");
      if (!content.trim()) return [];
      
      // Support both newline-delimited JSON and legacy JSON array format
      if (content.trim().startsWith("[")) {
        // Legacy JSON array format
        return JSON.parse(content) as WALEntry[];
      } else {
        // Newline-delimited JSON format
        return content
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as WALEntry);
      }
    } catch (err) {
      this.logger?.warn(`memory-hybrid: WAL read failed (${err}), returning empty array`);
      return [];
    }
  }

  private writeAll(entries: WALEntry[]): void {
    // Write as newline-delimited JSON
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
    writeFileSync(this.walPath, content, "utf-8");
  }

  pruneStale(): number {
    const now = Date.now();
    const entries = this.readAll();
    const fresh = entries.filter((e) => now - e.timestamp < this.maxAge);
    const pruned = entries.length - fresh.length;
    if (pruned > 0) {
      this.writeAll(fresh);
    }
    return pruned;
  }

  clear(): void {
    writeFileSync(this.walPath, "", "utf-8");
  }
}

class FactsDB {
  private db: Database.Database;
  private readonly dbPath: string;
  private readonly fuzzyDedupe: boolean;
  private supersededTextsCache: Set<string> | null = null;
  private supersededTextsCacheTime: number = 0;
  private readonly SUPERSEDED_CACHE_TTL_MS = 60000; // 1 minute cache

  constructor(dbPath: string, options?: { fuzzyDedupe?: boolean }) {
    this.dbPath = dbPath;
    this.fuzzyDedupe = options?.fuzzyDedupe ?? false;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.applyPragmas();

    // Create main table
    this.liveDb.exec(`
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
    this.liveDb.exec(`
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
    this.liveDb.exec(`
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
    this.liveDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
      CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
      CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at);
    `);

    // ---- TTL/Decay migration ----
    this.migrateDecayColumns();

    // ---- Fix ms/s unit mismatch from earlier versions ----
    this.migrateTimestampUnits();

    // ---- Summary column for chunked long facts (4.3) ----
    this.migrateSummaryColumn();

    // ---- Normalized hash for fuzzy dedupe (2.3) ----
    this.migrateNormalizedHash();

    // ---- Source date for provenance (FR-003) ----
    this.migrateSourceDateColumn();

    // ---- Tags for topic filtering (FR-001) ----
    this.migrateTagsColumn();

    // ---- Access tracking for dynamic salience (FR-005) ----
    this.migrateAccessTracking();

    // ---- Supersession columns for contradiction resolution (FR-008/010) ----
    this.migrateSupersessionColumns();
  }

  private migrateTagsColumn(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "tags")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN tags TEXT`);
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_facts_tags ON facts(tags) WHERE tags IS NOT NULL AND tags != ''`,
    );
  }

  /** FR-005: Add recall_count and last_accessed for dynamic salience scoring. */
  private migrateAccessTracking(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("recall_count")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0`);
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN last_accessed INTEGER`);
    this.liveDb.exec(`UPDATE facts SET last_accessed = last_confirmed_at WHERE last_accessed IS NULL`);
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_facts_last_accessed ON facts(last_accessed) WHERE last_accessed IS NOT NULL`,
    );
  }

  /** FR-008/010: Add superseded_at and superseded_by for contradiction resolution. */
  private migrateSupersessionColumns(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("superseded_at")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN superseded_at INTEGER`);
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN superseded_by TEXT`);
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_facts_superseded ON facts(superseded_at) WHERE superseded_at IS NOT NULL`,
    );
  }

  private migrateSourceDateColumn(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "source_date")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN source_date INTEGER`);
    this.liveDb.exec(`UPDATE facts SET source_date = created_at WHERE source_date IS NULL`);
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_facts_source_date ON facts(source_date) WHERE source_date IS NOT NULL`,
    );
  }

  private migrateNormalizedHash(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "normalized_hash")) {
      this.liveDb.exec(`ALTER TABLE facts ADD COLUMN normalized_hash TEXT`);
      this.liveDb.exec(`CREATE INDEX IF NOT EXISTS idx_facts_normalized_hash ON facts(normalized_hash) WHERE normalized_hash IS NOT NULL`);
    }
    const rows = this.liveDb
      .prepare(`SELECT id, text FROM facts WHERE normalized_hash IS NULL`)
      .all() as Array<{ id: string; text: string }>;
    if (rows.length === 0) return;
    const stmt = this.liveDb.prepare(`UPDATE facts SET normalized_hash = ? WHERE id = ?`);
    for (const row of rows) {
      stmt.run(normalizedHash(row.text), row.id);
    }
  }

  private migrateSummaryColumn(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "summary")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN summary TEXT`);
  }

  /** Re-apply connection pragmas (used on initial open and auto-reopen). */
  private applyPragmas(): void {
    this.liveDb.pragma("journal_mode = WAL");
    this.liveDb.pragma("busy_timeout = 5000");
    this.liveDb.pragma("synchronous = NORMAL");
    this.liveDb.pragma("wal_autocheckpoint = 1000");
  }

  private migrateDecayColumns(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));

    if (colNames.has("decay_class")) return;

    this.liveDb.exec(`
      ALTER TABLE facts ADD COLUMN decay_class TEXT NOT NULL DEFAULT 'stable';
      ALTER TABLE facts ADD COLUMN expires_at INTEGER;
      ALTER TABLE facts ADD COLUMN last_confirmed_at INTEGER;
      ALTER TABLE facts ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
    `);

    this.liveDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_facts_expires ON facts(expires_at)
        WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class);
    `);

    this.liveDb.exec(`
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

    const { cnt } = this.liveDb
      .prepare(`SELECT COUNT(*) as cnt FROM facts WHERE created_at > ?`)
      .get(MS_THRESHOLD) as { cnt: number };

    if (cnt === 0) return;

    this.liveDb.exec(`
      UPDATE facts
      SET created_at = created_at / 1000
      WHERE created_at > ${MS_THRESHOLD}
    `);

    // last_confirmed_at may have been seeded from ms-based created_at
    // by the migrateDecayColumns migration (created_at → last_confirmed_at).
    this.liveDb.exec(`
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
      summary?: string | null;
      sourceDate?: number | null;
      tags?: string[] | null;
    },
  ): MemoryEntry {
    if (this.fuzzyDedupe) {
      const existingId = this.getDuplicateIdByNormalizedHash(entry.text);
      if (existingId) {
        const existing = this.getById(existingId);
        if (existing) return existing;
      }
    }

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
    const summary = entry.summary ?? null;
    const normHash = normalizedHash(entry.text);
    const sourceDate = entry.sourceDate ?? null;
    const tags = entry.tags ?? null;
    const tagsStr = tags ? serializeTags(tags) : null;

    this.liveDb
      .prepare(
        `INSERT INTO facts (id, text, category, importance, entity, key, value, source, created_at, decay_class, expires_at, last_confirmed_at, confidence, summary, normalized_hash, source_date, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        summary,
        normHash,
        sourceDate,
        tagsStr,
      );

    return {
      ...entry,
      id,
      createdAt: nowSec,
      decayClass,
      expiresAt,
      lastConfirmedAt: nowSec,
      confidence,
      summary: summary ?? undefined,
      sourceDate,
      tags: tags ?? undefined,
    };
  }

  private refreshAccessedFacts(ids: string[]): void {
    if (ids.length === 0) return;
    const nowSec = Math.floor(Date.now() / 1000);

    const stmtDecay = this.liveDb.prepare(`
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

    // FR-005: Track access count and timestamp for dynamic salience scoring
    const stmtAccess = this.liveDb.prepare(`
      UPDATE facts
      SET recall_count = recall_count + 1,
          last_accessed = @now
      WHERE id = @id
    `);

    const tx = this.liveDb.transaction(() => {
      for (const id of ids) {
        stmtDecay.run({
          now: nowSec,
          stableTtl: TTL_DEFAULTS.stable,
          activeTtl: TTL_DEFAULTS.active,
          id,
        });
        stmtAccess.run({ now: nowSec, id });
      }
    });
    tx();
  }

  search(
    query: string,
    limit = 5,
    options: { includeExpired?: boolean; tag?: string; includeSuperseded?: boolean } = {},
  ): SearchResult[] {
    const { includeExpired = false, tag, includeSuperseded = false } = options;

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
    const supersededFilter = includeSuperseded
      ? ""
      : "AND f.superseded_at IS NULL";
    const tagFilter =
      tag && tag.trim()
        ? "AND (',' || COALESCE(f.tags,'') || ',') LIKE @tagPattern"
        : "";
    const tagPattern = tag && tag.trim() ? `%,${tag.toLowerCase().trim()},%` : null;

    const rows = this.liveDb
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
           ${supersededFilter}
           ${tagFilter}
         ORDER BY rank
         LIMIT @limit`,
      )
      .all({
        query: safeQuery,
        now: nowSec,
        limit: limit * 2,
        decay_window: 7 * 24 * 3600,
        ...(tagPattern ? { tagPattern } : {}),
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
          sourceDate: (row.source_date as number) ?? undefined,
          tags: parseTags(row.tags as string | null),
          decayClass: (row.decay_class as DecayClass) || "stable",
          expiresAt: (row.expires_at as number) || null,
          lastConfirmedAt: (row.last_confirmed_at as number) || 0,
          confidence,
          summary: (row.summary as string) || undefined,
          recallCount: (row.recall_count as number) || 0,
          lastAccessed: (row.last_accessed as number) || null,
          supersededAt: (row.superseded_at as number) || null,
          supersededBy: (row.superseded_by as string) || null,
        },
        score: composite,
        backend: "sqlite" as const,
      };
    });

    results.sort((a, b) => {
      const s = b.score - a.score;
      if (s !== 0) return s;
      const da = a.entry.sourceDate ?? a.entry.createdAt;
      const db = b.entry.sourceDate ?? b.entry.createdAt;
      return db - da;
    });
    const topResults = results.slice(0, limit);

    this.refreshAccessedFacts(topResults.map((r) => r.entry.id));

    return topResults;
  }

  lookup(entity: string, key?: string, tag?: string): SearchResult[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const tagFilter =
      tag && tag.trim()
        ? " AND (',' || COALESCE(tags,'') || ',') LIKE ?"
        : "";
    const tagParam = tag && tag.trim() ? `%,${tag.toLowerCase().trim()},%` : null;

    const base = key
      ? `SELECT * FROM facts WHERE lower(entity) = lower(?) AND lower(key) = lower(?) AND (expires_at IS NULL OR expires_at > ?) AND superseded_at IS NULL${tagFilter} ORDER BY confidence DESC, COALESCE(source_date, created_at) DESC`
      : `SELECT * FROM facts WHERE lower(entity) = lower(?) AND (expires_at IS NULL OR expires_at > ?) AND superseded_at IS NULL${tagFilter} ORDER BY confidence DESC, COALESCE(source_date, created_at) DESC`;

    const params = key
      ? tagParam !== null
        ? [entity, key, nowSec, tagParam]
        : [entity, key, nowSec]
      : tagParam !== null
        ? [entity, nowSec, tagParam]
        : [entity, nowSec];
    const rows = this.liveDb.prepare(base).all(...params) as Array<
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
        sourceDate: (row.source_date as number) ?? undefined,
        tags: parseTags(row.tags as string | null),
        decayClass: (row.decay_class as DecayClass) || "stable",
        expiresAt: (row.expires_at as number) || null,
        lastConfirmedAt: (row.last_confirmed_at as number) || 0,
        confidence: (row.confidence as number) || 1.0,
        summary: (row.summary as string) || undefined,
        recallCount: (row.recall_count as number) || 0,
        lastAccessed: (row.last_accessed as number) || null,
        supersededAt: (row.superseded_at as number) || null,
        supersededBy: (row.superseded_by as string) || null,
      },
      score: (row.confidence as number) || 1.0,
      backend: "sqlite" as const,
    }));

    this.refreshAccessedFacts(results.map((r) => r.entry.id));

    return results;
  }

  delete(id: string): boolean {
    const result = this.liveDb.prepare(`DELETE FROM facts WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Exact or (if fuzzyDedupe) normalized-text duplicate. */
  hasDuplicate(text: string): boolean {
    const exact = this.liveDb
      .prepare(`SELECT id FROM facts WHERE text = ? LIMIT 1`)
      .get(text);
    if (exact) return true;
    if (this.fuzzyDedupe && this.getDuplicateIdByNormalizedHash(text) !== null) return true;
    return false;
  }

  /** Id of an existing fact with same normalized text, or null. Used when store.fuzzyDedupe is true. */
  private getDuplicateIdByNormalizedHash(text: string): string | null {
    const hash = normalizedHash(text);
    const row = this.liveDb
      .prepare(`SELECT id FROM facts WHERE normalized_hash = ? LIMIT 1`)
      .get(hash) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** FR-008/010: Mark a fact as superseded by a new fact. For deletions, pass null as newId. */
  supersede(oldId: string, newId: string | null): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = this.liveDb
      .prepare(`UPDATE facts SET superseded_at = ?, superseded_by = ? WHERE id = ? AND superseded_at IS NULL`)
      .run(nowSec, newId, oldId);
    if (result.changes > 0) {
      this.invalidateSupersededCache();
    }
    return result.changes > 0;
  }


  /** FR-008: Find top-N most similar existing facts by entity+key overlap and normalized text. Used for ADD/UPDATE/DELETE classification. */
  findSimilarForClassification(text: string, entity: string | null, key: string | null, limit = 5): MemoryEntry[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const results: MemoryEntry[] = [];

    // Priority 1: exact entity+key match (most likely an UPDATE)
    if (entity && key) {
      const rows = this.liveDb
        .prepare(
          `SELECT * FROM facts WHERE lower(entity) = lower(?) AND lower(key) = lower(?) AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT ?`
        )
        .all(entity, key, nowSec, limit) as Array<Record<string, unknown>>;
      for (const row of rows) {
        results.push(this.rowToEntry(row));
      }
    }

    // Priority 2: same entity, different key
    if (entity && results.length < limit) {
      const remaining = limit - results.length;
      const seenIds = new Set(results.map((r) => r.id));
      const rows = this.liveDb
        .prepare(
          `SELECT * FROM facts WHERE lower(entity) = lower(?) AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT ?`
        )
        .all(entity, nowSec, remaining + results.length) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const entry = this.rowToEntry(row);
        if (!seenIds.has(entry.id)) {
          results.push(entry);
          seenIds.add(entry.id);
          if (results.length >= limit) break;
        }
      }
    }

    // Priority 3: FTS text match
    if (results.length < limit) {
      const remaining = limit - results.length;
      const seenIds = new Set(results.map((r) => r.id));
      const words = text
        .replace(/['"]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 5)
        .map((w) => `"${w}"`)
        .join(" OR ");
      if (words) {
        try {
          const rows = this.liveDb
            .prepare(
              `SELECT f.* FROM facts f JOIN facts_fts fts ON f.rowid = fts.rowid WHERE facts_fts MATCH ? AND f.superseded_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > ?) LIMIT ?`
            )
            .all(words, nowSec, remaining + results.length) as Array<Record<string, unknown>>;
          for (const row of rows) {
            const entry = this.rowToEntry(row);
            if (!seenIds.has(entry.id)) {
              results.push(entry);
              seenIds.add(entry.id);
              if (results.length >= limit) break;
            }
          }
        } catch {
          // FTS query can fail on unusual input; ignore
        }
      }
    }

    return results.slice(0, limit);
  }

  /** Convert a raw SQLite row to MemoryEntry. */
  private rowToEntry(row: Record<string, unknown>): MemoryEntry {
    return {
      id: row.id as string,
      text: row.text as string,
      category: row.category as MemoryCategory,
      importance: row.importance as number,
      entity: (row.entity as string) || null,
      key: (row.key as string) || null,
      value: (row.value as string) || null,
      source: row.source as string,
      createdAt: row.created_at as number,
      sourceDate: (row.source_date as number) ?? undefined,
      tags: parseTags(row.tags as string | null),
      decayClass: (row.decay_class as DecayClass) || "stable",
      expiresAt: (row.expires_at as number) || null,
      lastConfirmedAt: (row.last_confirmed_at as number) || 0,
      confidence: (row.confidence as number) || 1.0,
      summary: (row.summary as string) || undefined,
      recallCount: (row.recall_count as number) || 0,
      lastAccessed: (row.last_accessed as number) || null,
      supersededAt: (row.superseded_at as number) || null,
      supersededBy: (row.superseded_by as string) || null,
    };
  }

  /** For consolidation (2.4): fetch facts with id, text, category, entity, key. Order by created_at DESC. */
  getFactsForConsolidation(limit: number): Array<{ id: string; text: string; category: string; entity: string | null; key: string | null }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = this.liveDb
      .prepare(
        `SELECT id, text, category, entity, key FROM facts
         WHERE (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(nowSec, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      category: row.category as string,
      entity: (row.entity as string) || null,
      key: (row.key as string) || null,
    }));
  }

  /** Get one fact by id (for merge category). Returns null if not found. */
  getById(id: string): MemoryEntry | null {
    const row = this.liveDb.prepare(`SELECT * FROM facts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  /** Get all non-expired, non-superseded facts (for reflection). */
  getAll(): MemoryEntry[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = this.liveDb
      .prepare(`SELECT * FROM facts WHERE (expires_at IS NULL OR expires_at > ?) AND superseded_at IS NULL ORDER BY created_at DESC`)
      .all(nowSec) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEntry(row));
  }

  /** Get texts of superseded facts (for filtering LanceDB results). Cached for 1 minute to avoid repeated queries. */
  getSupersededTexts(): Set<string> {
    const now = Date.now();
    if (this.supersededTextsCache && (now - this.supersededTextsCacheTime) < this.SUPERSEDED_CACHE_TTL_MS) {
      return this.supersededTextsCache;
    }
    
    const rows = this.liveDb
      .prepare(`SELECT text FROM facts WHERE superseded_at IS NOT NULL`)
      .all() as Array<{ text: string }>;
    this.supersededTextsCache = new Set(rows.map((r) => r.text.toLowerCase()));
    this.supersededTextsCacheTime = now;
    return this.supersededTextsCache;
  }
  
  /** Invalidate superseded texts cache (called after supersede operations). */
  private invalidateSupersededCache(): void {
    this.supersededTextsCache = null;
  }

  count(): number {
    const row = this.liveDb
      .prepare(`SELECT COUNT(*) as cnt FROM facts`)
      .get() as Record<string, number>;
    return row.cnt;
  }

  pruneExpired(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = this.liveDb
      .prepare(`DELETE FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .run(nowSec);
    return result.changes;
  }

  decayConfidence(): number {
    const nowSec = Math.floor(Date.now() / 1000);

    this.liveDb
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

    const result = this.liveDb
      .prepare(`DELETE FROM facts WHERE confidence < 0.1`)
      .run();
    return result.changes;
  }

  confirmFact(id: string): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    const row = this.liveDb
      .prepare(`SELECT decay_class FROM facts WHERE id = ?`)
      .get(id) as { decay_class: DecayClass } | undefined;
    if (!row) return false;

    const newExpiry = calculateExpiry(row.decay_class, nowSec);
    this.liveDb
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
    const row = this.liveDb
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
    const rows = this.liveDb
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
    const row = this.liveDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?`,
      )
      .get(nowSec) as { cnt: number };
    return row.cnt;
  }

  backfillDecayClasses(): Record<string, number> {
    const rows = this.liveDb
      .prepare(`SELECT rowid, entity, key, value, text FROM facts WHERE decay_class = 'stable'`)
      .all() as Array<{ rowid: number; entity: string; key: string; value: string; text: string }>;

    const nowSec = Math.floor(Date.now() / 1000);
    const update = this.liveDb.prepare(
      `UPDATE facts SET decay_class = ?, expires_at = ? WHERE rowid = ?`,
    );

    const counts: Record<string, number> = {};
    const tx = this.liveDb.transaction(() => {
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
    const rows = this.liveDb
      .prepare("SELECT * FROM facts WHERE category = ? ORDER BY created_at DESC")
      .all(category) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      category: row.category as MemoryCategory,
      importance: row.importance as number,
      entity: (row.entity as string) || null,
      key: (row.key as string) || null,
      value: (row.value as string) || null,
      source: row.source as string,
      createdAt: row.created_at as number,
      sourceDate: (row.source_date as number) ?? undefined,
      tags: parseTags(row.tags as string | null),
      decayClass: (row.decay_class as DecayClass) || "stable",
      expiresAt: (row.expires_at as number) || null,
      lastConfirmedAt: (row.last_confirmed_at as number) || 0,
      confidence: (row.confidence as number) || 1.0,
      summary: (row.summary as string) || undefined,
      recallCount: (row.recall_count as number) || 0,
      lastAccessed: (row.last_accessed as number) || null,
      supersededAt: (row.superseded_at as number) || null,
      supersededBy: (row.superseded_by as string) || null,
    }));
  }

  updateCategory(id: string, category: string): boolean {
    const result = this.liveDb
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
// Credentials Store (opt-in, encrypted)
// ============================================================================

const CRED_IV_LEN = 12;
const CRED_AUTH_TAG_LEN = 16;
const CRED_ALGO = "aes-256-gcm";

function deriveKey(password: string): Buffer {
  return createHash("sha256").update(password, "utf8").digest();
}

function encryptValue(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(CRED_IV_LEN);
  const cipher = createCipheriv(CRED_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptValue(buffer: Buffer, key: Buffer): string {
  const iv = buffer.subarray(0, CRED_IV_LEN);
  const authTag = buffer.subarray(CRED_IV_LEN, CRED_IV_LEN + CRED_AUTH_TAG_LEN);
  const encrypted = buffer.subarray(CRED_IV_LEN + CRED_AUTH_TAG_LEN);
  const decipher = createDecipheriv(CRED_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

type CredentialEntry = {
  service: string;
  type: CredentialType;
  value: string;
  url: string | null;
  notes: string | null;
  created: number;
  updated: number;
  expires: number | null;
};

class CredentialsDB {
  private db: Database.Database;
  private readonly dbPath: string;
  private readonly key: Buffer;

  constructor(dbPath: string, encryptionKey: string) {
    this.dbPath = dbPath;
    this.key = deriveKey(encryptionKey);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        service TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        value BLOB NOT NULL,
        url TEXT,
        notes TEXT,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        expires INTEGER,
        PRIMARY KEY (service, type)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_credentials_service ON credentials(service)
    `);
  }

  store(entry: {
    service: string;
    type: CredentialType;
    value: string;
    url?: string;
    notes?: string;
    expires?: number | null;
  }): CredentialEntry {
    const now = Math.floor(Date.now() / 1000);
    const encrypted = encryptValue(entry.value, this.key);
    this.db
      .prepare(
        `INSERT INTO credentials (service, type, value, url, notes, created, updated, expires)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service, type) DO UPDATE SET
           value = excluded.value,
           url = excluded.url,
           notes = excluded.notes,
           updated = excluded.updated,
           expires = excluded.expires`,
      )
      .run(
        entry.service,
        entry.type,
        encrypted,
        entry.url ?? null,
        entry.notes ?? null,
        now,
        now,
        entry.expires ?? null,
      );
    return {
      service: entry.service,
      type: entry.type,
      value: "[redacted]",
      url: entry.url ?? null,
      notes: entry.notes ?? null,
      created: now,
      updated: now,
      expires: entry.expires ?? null,
    };
  }

  get(service: string, type?: CredentialType): CredentialEntry | null {
    const row = type
      ? (this.db.prepare("SELECT * FROM credentials WHERE service = ? AND type = ?").get(service, type) as Record<string, unknown> | undefined)
      : (this.db.prepare("SELECT * FROM credentials WHERE service = ? ORDER BY updated DESC LIMIT 1").get(service) as Record<string, unknown> | undefined);
    if (!row) return null;
    const buf = row.value as Buffer;
    const value = decryptValue(buf, this.key);
    return {
      service: row.service as string,
      type: (row.type as string) as CredentialType,
      value,
      url: (row.url as string) ?? null,
      notes: (row.notes as string) ?? null,
      created: row.created as number,
      updated: row.updated as number,
      expires: (row.expires as number) ?? null,
    };
  }

  list(): Array<{ service: string; type: string; url: string | null; expires: number | null }> {
    const rows = this.db.prepare("SELECT service, type, url, expires FROM credentials ORDER BY service, type").all() as Array<{
      service: string;
      type: string;
      url: string | null;
      expires: number | null;
    }>;
    return rows;
  }

  delete(service: string, type?: CredentialType): boolean {
    if (type) {
      const r = this.db.prepare("DELETE FROM credentials WHERE service = ? AND type = ?").run(service, type);
      return r.changes > 0;
    }
    const r = this.db.prepare("DELETE FROM credentials WHERE service = ?").run(service);
    return r.changes > 0;
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
// Token estimate (for auto-recall cap)
// ============================================================================

/** Rough token count (OpenAI-style: ~4 chars per token for English). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============================================================================
// Merge & Deduplicate
// ============================================================================

function mergeResults(
  sqliteResults: SearchResult[],
  lanceResults: SearchResult[],
  limit: number,
  factsDb?: FactsDB,
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const r of sqliteResults) {
    if (!seen.has(r.entry.id)) {
      seen.add(r.entry.id);
      merged.push(r);
    }
  }

  // Get superseded fact texts for filtering LanceDB results (optimized: text-only query)
  const supersededTexts = factsDb ? factsDb.getSupersededTexts() : new Set<string>();

  for (const r of lanceResults) {
    // Skip if this text matches a superseded fact
    const isSuperseded = supersededTexts.has(r.entry.text.toLowerCase());
    const isDupe = merged.some(
      (m) =>
        m.entry.id === r.entry.id ||
        m.entry.text.toLowerCase() === r.entry.text.toLowerCase(),
    );
    if (!isDupe && !isSuperseded) {
      merged.push(r);
    }
  }

  merged.sort((a, b) => {
    const s = b.score - a.score;
    if (s !== 0) return s;
    const da = a.entry.sourceDate ?? a.entry.createdAt;
    const db = b.entry.sourceDate ?? b.entry.createdAt;
    return db - da;
  });
  return merged.slice(0, limit);
}

// ============================================================================
// FR-008: Memory Operation Classification (ADD/UPDATE/DELETE/NOOP)
// ============================================================================

type MemoryClassification = {
  action: "ADD" | "UPDATE" | "DELETE" | "NOOP";
  targetId?: string;
  reason: string;
  /** For UPDATE: the updated text to store (only if LLM suggests a merge) */
  updatedText?: string;
};

/**
 * FR-008: Classify an incoming fact against existing similar facts.
 * Uses a cheap LLM call to determine ADD/UPDATE/DELETE/NOOP.
 * Falls back to ADD on error.
 */
async function classifyMemoryOperation(
  candidateText: string,
  candidateEntity: string | null,
  candidateKey: string | null,
  existingFacts: MemoryEntry[],
  openai: OpenAI,
  model: string,
  logger: { warn: (msg: string) => void },
): Promise<MemoryClassification> {
  if (existingFacts.length === 0) {
    return { action: "ADD", reason: "no similar facts found" };
  }

  const existingLines = existingFacts
    .slice(0, 5)
    .map(
      (f, i) =>
        `${i + 1}. [id=${f.id}] ${f.category}${f.entity ? ` | entity: ${f.entity}` : ""}${f.key ? ` | key: ${f.key}` : ""}: ${f.text.slice(0, 300)}`,
    )
    .join("\n");

  const prompt = `You are a memory classifier. A new fact is being stored. Compare it against existing facts and decide what to do.

New fact: "${candidateText.slice(0, 500)}"${candidateEntity ? `\nEntity: ${candidateEntity}` : ""}${candidateKey ? `\nKey: ${candidateKey}` : ""}

Existing similar facts:
${existingLines}

Classify as one of:
- ADD: The new fact is genuinely new information not covered by any existing fact.
- UPDATE <id>: The new fact supersedes or updates an existing fact (e.g., a preference changed, a value was corrected). Specify which existing fact id it replaces.
- DELETE <id>: The new fact explicitly retracts or negates an existing fact (e.g., "I no longer use X"). Specify which fact to invalidate.
- NOOP: The new fact is already adequately captured by existing facts. No action needed.

Respond with exactly one line in this format: ACTION [id] | reason
Examples:
  ADD | this is new information about the user's work setup
  UPDATE abc-123 | user changed their preferred IDE from VS Code to Cursor
  DELETE def-456 | user explicitly stated they no longer use Docker
  NOOP | this preference is already stored as fact #2`;

  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 100,
    });
    const content = (resp.choices[0]?.message?.content ?? "").trim();

    // Parse: "ACTION [id] | reason"
    const match = content.match(/^(ADD|UPDATE|DELETE|NOOP)\s*([a-f0-9-]*)\s*\|\s*(.+)$/i);
    if (!match) {
      return { action: "ADD", reason: `unparseable LLM response: ${content.slice(0, 80)}` };
    }

    const action = match[1].toUpperCase() as MemoryClassification["action"];
    const targetId = match[2]?.trim() || undefined;
    const reason = match[3].trim();

    // Validate targetId if UPDATE or DELETE
    if (action === "UPDATE" || action === "DELETE") {
      if (!targetId) {
        return { action: "ADD", reason: `missing targetId for ${action}; treating as ADD` };
      }
      const validTarget = existingFacts.find((f) => f.id === targetId);
      if (!validTarget) {
        return { action: "ADD", reason: `LLM referenced unknown id ${targetId}; treating as ADD` };
      }
    }

    return { action, targetId, reason };
  } catch (err) {
    logger.warn(`memory-hybrid: classify operation failed: ${err}`);
    return { action: "ADD", reason: "classification failed; defaulting to ADD" };
  }
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

/** Patterns that suggest a credential value - for auto-detect prompt to store */
const CREDENTIAL_PATTERNS: Array<{ regex: RegExp; type: string; hint: string }> = [
  { regex: /Bearer\s+eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i, type: "bearer", hint: "Bearer/JWT token" },
  { regex: /sk-[A-Za-z0-9]{20,}/, type: "api_key", hint: "OpenAI-style API key (sk-...)" },
  { regex: /ghp_[A-Za-z0-9]{36}/, type: "api_key", hint: "GitHub personal access token" },
  { regex: /gho_[A-Za-z0-9]{36}/, type: "api_key", hint: "GitHub OAuth token" },
  { regex: /xox[baprs]-[A-Za-z0-9-]{10,}/, type: "token", hint: "Slack token" },
  { regex: /ssh\s+[\w@.-]+\s+[\w@.-]+/i, type: "ssh", hint: "SSH connection string" },
  { regex: /[\w.-]+@[\w.-]+\.\w+.*(?:password|passwd|token|key)\s*[:=]\s*\S+/i, type: "password", hint: "Credentials with host/email" },
];

function detectCredentialPatterns(text: string): Array<{ type: string; hint: string }> {
  const found: Array<{ type: string; hint: string }> = [];
  const seen = new Set<string>();
  for (const { regex, type, hint } of CREDENTIAL_PATTERNS) {
    if (regex.test(text) && !seen.has(hint)) {
      seen.add(hint);
      found.push({ type, hint });
    }
  }
  return found;
}

/** First credential-like match in text; used to extract secret for vault. */
function extractCredentialMatch(text: string): { type: string; secretValue: string } | null {
  for (const { regex, type } of CREDENTIAL_PATTERNS) {
    const match = regex.exec(text);
    if (match) {
      const secretValue = match[0].replace(/^Bearer\s+/i, "").trim();
      if (secretValue.length >= 8) return { type, secretValue };
    }
  }
  return null;
}

/** True if content should be treated as a credential (store in vault when enabled, else in memory). */
function isCredentialLike(
  text: string,
  entity?: string | null,
  key?: string | null,
  value?: string | null,
): boolean {
  if ((entity ?? "").toLowerCase() === "credentials") return true;
  const k = (key ?? "").toLowerCase();
  const e = (entity ?? "").toLowerCase();
  if (["api_key", "password", "token", "secret", "bearer"].some((x) => k.includes(x) || e.includes(x)))
    return true;
  if (value && value.length >= 8 && /^(eyJ|sk-|ghp_|gho_|xox[baprs]-)/i.test(value)) return true;
  return CREDENTIAL_PATTERNS.some((p) => p.regex.test(text)) || SENSITIVE_PATTERNS.some((r) => r.test(text));
}

const VAULT_POINTER_PREFIX = "vault:";

/** Parse into vault entry when vault is enabled. Returns null if not credential-like or cannot derive service/secret. */
function tryParseCredentialForVault(
  text: string,
  entity?: string | null,
  key?: string | null,
  value?: string | null,
): { service: string; type: "token" | "password" | "api_key" | "ssh" | "bearer" | "other"; secretValue: string; url?: string; notes?: string } | null {
  if (!isCredentialLike(text, entity, key, value)) return null;
  const match = extractCredentialMatch(text);
  const secretValue = (value && value.length >= 8 ? value : match?.secretValue) ?? null;
  if (!secretValue) return null;
  const typeFromPattern = (match?.type ?? "other") as "token" | "password" | "api_key" | "ssh" | "bearer" | "other";
  const service =
    (entity?.toLowerCase() === "credentials" ? key : null) ||
    key ||
    (entity && entity.toLowerCase() !== "credentials" ? entity : null) ||
    inferServiceFromText(text) ||
    "imported";
  const serviceSlug = service.replace(/\s+/g, "-").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "imported";
  return {
    service: serviceSlug,
    type: typeFromPattern,
    secretValue,
    notes: text.length <= 500 ? text : text.slice(0, 497) + "...",
  };
}

function inferServiceFromText(text: string): string {
  const lower = text.toLowerCase();
  if (/home\s*assistant|ha\s*token|hass/i.test(lower)) return "home-assistant";
  if (/unifi|ubiquiti/i.test(lower)) return "unifi";
  if (/github|ghp_|gho_/i.test(lower)) return "github";
  if (/openai|sk-proj/i.test(lower)) return "openai";
  if (/twilio/i.test(lower)) return "twilio";
  if (/duckdns/i.test(lower)) return "duckdns";
  if (/slack|xox[baprs]/i.test(lower)) return "slack";
  return "imported";
}

const CREDENTIAL_REDACTION_MIGRATION_FLAG = ".credential-redaction-migrated";

/**
 * When vault is enabled: move existing credential facts from memory into the vault and replace them with pointers.
 * Idempotent: facts that are already pointers (value starts with vault:) are skipped.
 * Returns { migrated, skipped, errors }. If markDone is true, writes a flag file so init only runs once.
 */
async function migrateCredentialsToVault(opts: {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: Embeddings;
  credentialsDb: CredentialsDB;
  migrationFlagPath: string;
  markDone: boolean;
}): Promise<{ migrated: number; skipped: number; errors: string[] }> {
  const { factsDb, vectorDb, embeddings, credentialsDb, migrationFlagPath, markDone } = opts;
  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];

  const results = factsDb.lookup("Credentials");
  const toMigrate = results.filter(
    (r) =>
      !r.entry.text.includes("stored in secure vault") &&
      (r.entry.value == null || !String(r.entry.value).startsWith(VAULT_POINTER_PREFIX)),
  );

  for (const { entry } of toMigrate) {
    const parsed = tryParseCredentialForVault(
      entry.text,
      entry.entity,
      entry.key,
      entry.value,
    );
    if (!parsed) {
      skipped++;
      continue;
    }
    try {
      credentialsDb.store({
        service: parsed.service,
        type: parsed.type,
        value: parsed.secretValue,
        url: parsed.url,
        notes: parsed.notes,
      });
      factsDb.delete(entry.id);
      try {
        await vectorDb.delete(entry.id);
      } catch {
        // LanceDB row might not exist
      }
      const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
      const pointerValue = VAULT_POINTER_PREFIX + parsed.service;
      factsDb.store({
        text: pointerText,
        category: "technical" as MemoryCategory,
        importance: 0.8,
        entity: "Credentials",
        key: parsed.service,
        value: pointerValue,
        source: "conversation",
        decayClass: "permanent",
        tags: ["auth", ...extractTags(pointerText, "Credentials")],
      });
      try {
        const vector = await embeddings.embed(pointerText);
        if (!(await vectorDb.hasDuplicate(vector))) {
          await vectorDb.store({
            text: pointerText,
            vector,
            importance: 0.8,
            category: "technical",
          });
        }
      } catch (e) {
        errors.push(`vector store for ${parsed.service}: ${String(e)}`);
      }
      migrated++;
    } catch (e) {
      errors.push(`${parsed.service}: ${String(e)}`);
    }
  }

  if (markDone) {
    try {
      writeFileSync(migrationFlagPath, "1", "utf8");
    } catch (e) {
      errors.push(`write migration flag: ${String(e)}`);
    }
  }
  return { migrated, skipped, errors };
}

/** True if fact looks like identifier/number (IP, email, phone, UUID, etc.). Used by consolidate to skip by default (2.2/2.4). */
function isStructuredForConsolidation(
  text: string,
  entity: string | null,
  key: string | null,
): boolean {
  if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(text)) return true;
  if (/[\w.-]+@[\w.-]+\.\w+/.test(text)) return true;
  if (/\+\d{10,}/.test(text) || /\b\d{10,}\b/.test(text)) return true;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) return true;
  const k = (key ?? "").toLowerCase();
  const e = (entity ?? "").toLowerCase();
  if (["email", "phone", "api_key", "ip", "uuid", "password"].some((x) => k.includes(x) || e.includes(x))) return true;
  if (SENSITIVE_PATTERNS.some((r) => r.test(text))) return true;
  return false;
}

function shouldCapture(text: string): boolean {
  if (text.length < 10 || text.length > cfg.captureMaxChars) return false;
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
// Reflection Layer (FR-011): Pattern Synthesis from Observations
// ============================================================================

/**
 * Reflection prompt template: analyze facts to extract behavioral patterns.
 * Based on Claude-Diary and Generative Agents paper approach.
 */
function buildReflectionPrompt(facts: MemoryEntry[], window: number, minObservations: number): string {
  const factsByCategory = new Map<string, MemoryEntry[]>();
  for (const fact of facts) {
    if (!factsByCategory.has(fact.category)) {
      factsByCategory.set(fact.category, []);
    }
    factsByCategory.get(fact.category)!.push(fact);
  }

  // Limit facts per category and truncate long texts to prevent token overflow
  const MAX_FACTS_PER_CATEGORY = 50;
  const MAX_FACT_LENGTH = 300;
  
  const factsSummary = [...factsByCategory.entries()]
    .map(([cat, items]) => {
      const limited = items.slice(0, MAX_FACTS_PER_CATEGORY);
      const lines = limited.map((f, i) => {
        const text = f.text.length > MAX_FACT_LENGTH 
          ? f.text.slice(0, MAX_FACT_LENGTH) + "..."
          : f.text;
        return `  ${i + 1}. ${text}`;
      }).join("\n");
      const suffix = items.length > MAX_FACTS_PER_CATEGORY 
        ? `\n  ... and ${items.length - MAX_FACTS_PER_CATEGORY} more`
        : "";
      return `[${cat}] (${items.length} observations)\n${lines}${suffix}`;
    })
    .join("\n\n");

  return `You are analyzing a user's interaction history to identify behavioral patterns.

Below are facts extracted from the last ${window} days of sessions.
Identify recurring patterns — preferences that appear across multiple sessions,
consistent decision-making tendencies, and working-style traits.

Rules:
- Only report patterns supported by ${minObservations}+ observations
- Be specific and actionable ("prefers X over Y" not "has preferences")
- Each pattern should be 1-2 sentences
- Do not repeat individual facts; synthesize higher-level insights
- Focus on patterns that would help an AI agent match the user's working style
- Output each pattern on a new line, starting with "PATTERN:"

Facts:
${factsSummary}

Output format (one per line):
PATTERN: [your pattern here]
PATTERN: [another pattern here]`;
}

/**
 * Run reflection analysis: gather recent facts, send to LLM, extract patterns, deduplicate, store.
 */
async function runReflection(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  opts: {
    window: number;
    model: string;
    minObservations: number;
    dryRun: boolean;
  },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ factsAnalyzed: number; patternsExtracted: number; patternsStored: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartSec = nowSec - opts.window * 24 * 3600;

  // Gather recent observations (exclude existing patterns/rules to avoid recursion)
  const allFacts = factsDb.getAll();
  const recentFacts = allFacts.filter((f) => {
    const factDate = f.sourceDate ?? f.createdAt;
    return factDate >= windowStartSec && f.category !== "pattern" && f.category !== "rule";
  });

  if (recentFacts.length < opts.minObservations) {
    logger.info(`memory-hybrid: reflect — only ${recentFacts.length} facts in window (need ${opts.minObservations}+)`);
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0 };
  }

  logger.info(`memory-hybrid: reflect — analyzing ${recentFacts.length} facts from last ${opts.window} days...`);

  const prompt = buildReflectionPrompt(recentFacts, opts.window, opts.minObservations);

  let responseText: string;
  try {
    const resp = await openai.chat.completions.create({
      model: opts.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    });
    responseText = (resp.choices[0]?.message?.content ?? "").trim();
  } catch (err) {
    logger.warn(`memory-hybrid: reflect LLM call failed: ${err}`);
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0 };
  }

  if (!responseText) {
    logger.info("memory-hybrid: reflect — no patterns extracted");
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0 };
  }

  // Parse patterns from response
  const lines = responseText.split("\n");
  const patterns: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("PATTERN:")) {
      const pattern = trimmed.slice(8).trim();
      if (pattern.length >= 20 && pattern.length <= 500) {
        patterns.push(pattern);
      }
    }
  }

  if (patterns.length === 0) {
    logger.info("memory-hybrid: reflect — no valid patterns found in response");
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0 };
  }

  logger.info(`memory-hybrid: reflect — extracted ${patterns.length} patterns`);

  if (opts.dryRun) {
    for (let i = 0; i < patterns.length; i++) {
      logger.info(`  ${i + 1}. ${patterns[i]}`);
    }
    return { factsAnalyzed: recentFacts.length, patternsExtracted: patterns.length, patternsStored: 0 };
  }

  // Deduplicate against existing patterns using semantic similarity
  const existingPatterns = allFacts.filter((f) => f.category === "pattern");
  
  // Pre-compute embeddings for existing patterns to avoid redundant API calls
  const existingEmbeddings: Array<{ text: string; vector: number[] }> = [];
  for (const existing of existingPatterns) {
    try {
      const vector = await embeddings.embed(existing.text);
      existingEmbeddings.push({ text: existing.text, vector });
    } catch (err) {
      logger.warn(`memory-hybrid: reflect — failed to embed existing pattern: ${err}`);
    }
  }
  
  let stored = 0;

  for (const pattern of patterns) {
    // Check for semantic duplicates
    let isDuplicate = false;
    let patternVector: number[];
    try {
      patternVector = await embeddings.embed(pattern);
    } catch (err) {
      logger.warn(`memory-hybrid: reflect — embedding failed for pattern: ${err}`);
      continue;
    }

    for (const existing of existingEmbeddings) {
      // Use cosine similarity for normalized embeddings (OpenAI embeddings are normalized)
      // Cosine similarity = dot product for unit vectors
      const dotProduct = patternVector.reduce((s, v, k) => s + v * existing.vector[k], 0);
      const cosineSimilarity = dotProduct; // Already normalized, so no need to divide by magnitudes
      
      // 0.85 cosine similarity = 85% similar (actual semantic similarity)
      if (cosineSimilarity >= 0.85) {
        isDuplicate = true;
        logger.info(`memory-hybrid: reflect — skipping duplicate pattern (${(cosineSimilarity * 100).toFixed(0)}% similar to existing)`);
        break;
      }
    }

    if (isDuplicate) continue;

    // Store pattern with high importance and permanent decay
    const entry = factsDb.store({
      text: pattern,
      category: "pattern",
      importance: 0.9,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "permanent",
      tags: ["reflection", "pattern"],
    });

    try {
      // Reuse the already-computed embedding
      await vectorDb.store({ text: pattern, vector: patternVector, importance: 0.9, category: "pattern" });
    } catch (err) {
      logger.warn(`memory-hybrid: reflect — vector store failed for pattern: ${err}`);
    }

    // Add to existing embeddings so subsequent patterns in this batch are checked against it
    existingEmbeddings.push({ text: pattern, vector: patternVector });

    stored++;
    logger.info(`memory-hybrid: reflect — stored pattern: ${pattern.slice(0, 80)}...`);
  }

  return { factsAnalyzed: recentFacts.length, patternsExtracted: patterns.length, patternsStored: stored };
}

// ============================================================================
// LLM-based Auto-Classifier
// ============================================================================

/** Union-find for building clusters from edges. Returns parent map; use getRoot to resolve cluster root. */
function unionFind(ids: string[], edges: Array<[string, string]>): Map<string, string> {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  function find(x: string): string {
    const p = parent.get(x)!;
    if (p !== x) parent.set(x, find(p));
    return parent.get(x)!;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const [a, b] of edges) union(a, b);
  return parent;
}

function getRoot(parent: Map<string, string>, id: string): string {
  let r = id;
  while (parent.get(r) !== r) r = parent.get(r)!;
  return r;
}

/**
 * Consolidation (2.4): find clusters of similar facts (by embedding), merge each cluster with LLM, store one fact and delete cluster.
 * Uses SQLite as source; re-embeds to compute similarity (no Lance scan). Merged fact is stored in both SQLite and Lance.
 * Does not delete from Lance (ids differ); optional future: sync Lance.
 */
async function runConsolidate(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  opts: {
    threshold: number;
    includeStructured: boolean;
    dryRun: boolean;
    limit: number;
    model: string;
  },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ clustersFound: number; merged: number; deleted: number }> {
  const facts = factsDb.getFactsForConsolidation(opts.limit);
  let candidateFacts = opts.includeStructured
    ? facts
    : facts.filter((f) => !isStructuredForConsolidation(f.text, f.entity, f.key));
  if (candidateFacts.length < 2) {
    logger.info("memory-hybrid: consolidate — fewer than 2 candidate facts");
    return { clustersFound: 0, merged: 0, deleted: 0 };
  }

  const idToFact = new Map(candidateFacts.map((f) => [f.id, f]));
  const ids = candidateFacts.map((f) => f.id);

  logger.info(`memory-hybrid: consolidate — embedding ${ids.length} facts...`);
  const vectors: number[][] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    for (const id of batch) {
      const f = idToFact.get(id)!;
      try {
        const vec = await embeddings.embed(f.text);
        vectors.push(vec);
      } catch (err) {
        logger.warn(`memory-hybrid: consolidate embed failed for ${id}: ${err}`);
        vectors.push([]);
      }
    }
    if (i + 20 < ids.length) await new Promise((r) => setTimeout(r, 200));
  }

  const idToIndex = new Map(ids.map((id, idx) => [id, idx]));
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i++) {
    const vi = vectors[i];
    if (vi.length === 0) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const vj = vectors[j];
      if (vj.length === 0) continue;
      const dist = Math.sqrt(vi.reduce((s, v, k) => s + (v - vj[k]) ** 2, 0));
      const score = 1 / (1 + dist);
      if (score >= opts.threshold) edges.push([ids[i], ids[j]]);
    }
  }

  const parent = unionFind(ids, edges);
  const rootToCluster = new Map<string, string[]>();
  for (const id of ids) {
    const r = getRoot(parent, id);
    if (!rootToCluster.has(r)) rootToCluster.set(r, []);
    rootToCluster.get(r)!.push(id);
  }
  const clusters = [...rootToCluster.values()].filter((c) => c.length >= 2);
  logger.info(`memory-hybrid: consolidate — ${clusters.length} clusters (≥2 facts)`);

  if (clusters.length === 0) return { clustersFound: 0, merged: 0, deleted: 0 };

  let merged = 0;
  let deleted = 0;
  for (const clusterIds of clusters) {
    const texts = clusterIds.map((id) => idToFact.get(id)!.text);
    const prompt = `You are a memory consolidator. Merge the following facts into one concise fact. Preserve key information. Output only the merged fact, no explanation.\n\n${texts.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
    let mergedText: string;
    try {
      const resp = await openai.chat.completions.create({
        model: opts.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 300,
      });
      mergedText = (resp.choices[0]?.message?.content ?? "").trim().slice(0, 5000);
    } catch (err) {
      logger.warn(`memory-hybrid: consolidate LLM failed for cluster: ${err}`);
      continue;
    }
    if (!mergedText) continue;

    const clusterFacts = clusterIds.map((id) => factsDb.getById(id)).filter(Boolean) as MemoryEntry[];
    const first = clusterFacts[0];
    const category = (first?.category as MemoryCategory) ?? "other";
    const maxSourceDate = clusterFacts.reduce(
      (acc, f) => (f.sourceDate != null && (acc == null || f.sourceDate > acc) ? f.sourceDate : acc),
      null as number | null,
    );
    const mergedTags = [...new Set(clusterFacts.flatMap((f) => f.tags ?? []))];

    if (opts.dryRun) {
      logger.info(`memory-hybrid: consolidate [dry-run] would merge ${clusterIds.length} facts → "${mergedText.slice(0, 80)}..."`);
      merged++;
      continue;
    }

    const entry = factsDb.store({
      text: mergedText,
      category,
      importance: 0.8,
      entity: first?.entity ?? null,
      key: null,
      value: null,
      source: "conversation",
      sourceDate: maxSourceDate,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
    });
    try {
      const vector = await embeddings.embed(mergedText);
      await vectorDb.store({ text: mergedText, vector, importance: 0.8, category });
    } catch (err) {
      logger.warn(`memory-hybrid: consolidate vector store failed: ${err}`);
    }
    for (const id of clusterIds) {
      factsDb.delete(id);
      deleted++;
    }
    merged++;
  }

  return { clustersFound: clusters.length, merged, deleted };
}

/**
 * Find-duplicates (2.2): report pairs of facts with embedding similarity ≥ threshold.
 * Does not modify store. By default skips identifier-like facts; use includeStructured to include.
 */
async function runFindDuplicates(
  factsDb: FactsDB,
  embeddings: Embeddings,
  opts: { threshold: number; includeStructured: boolean; limit: number },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{
  pairs: Array<{ idA: string; idB: string; score: number; textA: string; textB: string }>;
  candidatesCount: number;
  skippedStructured: number;
}> {
  const facts = factsDb.getFactsForConsolidation(opts.limit);
  const skippedStructured = opts.includeStructured ? 0 : facts.filter((f) => isStructuredForConsolidation(f.text, f.entity, f.key)).length;
  const candidateFacts = opts.includeStructured
    ? facts
    : facts.filter((f) => !isStructuredForConsolidation(f.text, f.entity, f.key));
  if (candidateFacts.length < 2) {
    logger.info("memory-hybrid: find-duplicates — fewer than 2 candidate facts");
    return { pairs: [], candidatesCount: candidateFacts.length, skippedStructured };
  }

  const idToFact = new Map(candidateFacts.map((f) => [f.id, f]));
  const ids = candidateFacts.map((f) => f.id);

  logger.info(`memory-hybrid: find-duplicates — embedding ${ids.length} facts...`);
  const vectors: number[][] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    for (const id of batch) {
      const f = idToFact.get(id)!;
      try {
        const vec = await embeddings.embed(f.text);
        vectors.push(vec);
      } catch (err) {
        logger.warn(`memory-hybrid: find-duplicates embed failed for ${id}: ${err}`);
        vectors.push([]);
      }
    }
    if (i + 20 < ids.length) await new Promise((r) => setTimeout(r, 200));
  }

  const pairs: Array<{ idA: string; idB: string; score: number; textA: string; textB: string }> = [];
  for (let i = 0; i < ids.length; i++) {
    const vi = vectors[i];
    if (vi.length === 0) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const vj = vectors[j];
      if (vj.length === 0) continue;
      const dist = Math.sqrt(vi.reduce((s, v, k) => s + (v - vj[k]) ** 2, 0));
      const score = 1 / (1 + dist);
      if (score >= opts.threshold) {
        const idA = ids[i];
        const idB = ids[j];
        pairs.push({
          idA,
          idB,
          score,
          textA: idToFact.get(idA)!.text,
          textB: idToFact.get(idB)!.text,
        });
      }
    }
  }
  logger.info(`memory-hybrid: find-duplicates — ${pairs.length} pairs ≥ ${opts.threshold}`);
  return { pairs, candidatesCount: candidateFacts.length, skippedStructured };
}

/** Minimum "other" facts before we run category discovery (avoid noise on tiny sets). */
const MIN_OTHER_FOR_DISCOVERY = 15;
/** Batch size for discovery prompts (leave room for JSON array of labels). */
const DISCOVERY_BATCH_SIZE = 25;

/**
 * Normalize a free-form label to a valid category slug: lowercase, alphanumeric + underscore.
 * Returns empty string if result would be "other" or invalid.
 */
function normalizeSuggestedLabel(s: string): string {
  const t = s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return t && t !== "other" && t.length <= 40 ? t : "";
}

/**
 * Ask the LLM to group "other" facts by topic (free-form labels). Labels with at least
 * minFactsForNewCategory facts become new categories; we do not tell the LLM the threshold.
 * Returns list of newly created category names; updates DB and persists to discoveredCategoriesPath.
 */
async function discoverCategoriesFromOther(
  db: FactsDB,
  openai: OpenAI,
  config: { model: string; batchSize: number; suggestCategories?: boolean; minFactsForNewCategory?: number },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  discoveredCategoriesPath: string,
): Promise<string[]> {
  if (config.suggestCategories !== true) return [];
  const minForNew = config.minFactsForNewCategory ?? 10;
  const others = db.getByCategory("other");
  if (others.length < MIN_OTHER_FOR_DISCOVERY) return [];

  logger.info(`memory-hybrid: category discovery on ${others.length} "other" facts (min ${minForNew} per label)`);

  const existingCategories = new Set(getMemoryCategories());
  const labelToIds = new Map<string, string[]>();

  for (let i = 0; i < others.length; i += DISCOVERY_BATCH_SIZE) {
    const batch = others.slice(i, i + DISCOVERY_BATCH_SIZE);
    const factLines = batch.map((f, idx) => `${idx + 1}. ${f.text.slice(0, 280)}`).join("\n");
    const prompt = `For each fact below, assign a short category label (1–2 words) that describes its topic or type. Use the same label for facts about the same topic. Output only a JSON array of strings, one label per fact in the same order. No explanation.`;

    try {
      const resp = await openai.chat.completions.create({
        model: config.model,
        messages: [{ role: "user", content: `${prompt}\n\nFacts:\n${factLines}` }],
        temperature: 0,
        max_tokens: batch.length * 24,
      });
      const content = resp.choices[0]?.message?.content?.trim() || "[]";
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;
      const labels: unknown[] = JSON.parse(jsonMatch[0]);
      for (let j = 0; j < Math.min(labels.length, batch.length); j++) {
        const raw = typeof labels[j] === "string" ? (labels[j] as string) : "";
        const label = normalizeSuggestedLabel(raw);
        if (!label) continue;
        if (!labelToIds.has(label)) labelToIds.set(label, []);
        labelToIds.get(label)!.push(batch[j].id);
      }
    } catch (err) {
      logger.warn(`memory-hybrid: category discovery batch failed: ${err}`);
    }
    if (i + DISCOVERY_BATCH_SIZE < others.length) await new Promise((r) => setTimeout(r, 400));
  }

  const newCategoryNames: string[] = [];
  for (const [label, ids] of labelToIds) {
    if (existingCategories.has(label)) continue;
    if (ids.length < minForNew) continue;
    newCategoryNames.push(label);
    for (const id of ids) db.updateCategory(id, label);
  }

  if (newCategoryNames.length === 0) return [];

  setMemoryCategories([...getMemoryCategories(), ...newCategoryNames]);
  logger.info(`memory-hybrid: discovered ${newCategoryNames.length} new categories: ${newCategoryNames.join(", ")} (${newCategoryNames.reduce((acc, c) => acc + (labelToIds.get(c)?.length ?? 0), 0)} facts reclassified)`);

  mkdirSync(dirname(discoveredCategoriesPath), { recursive: true });
  const existingList: string[] = existsSync(discoveredCategoriesPath)
    ? (JSON.parse(readFileSync(discoveredCategoriesPath, "utf-8")) as string[])
    : [];
  const merged = [...new Set([...existingList, ...newCategoryNames])];
  writeFileSync(discoveredCategoriesPath, JSON.stringify(merged, null, 2), "utf-8");

  return newCategoryNames;
}

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
 * If opts.discoveredCategoriesPath and config.suggestCategories are set, runs category discovery first
 * (LLM groups "other" by free-form label; labels with ≥ minFactsForNewCategory become new categories).
 */
async function runAutoClassify(
  db: FactsDB,
  openai: OpenAI,
  config: { model: string; batchSize: number; suggestCategories?: boolean; minFactsForNewCategory?: number },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  opts?: { discoveredCategoriesPath?: string },
): Promise<{ reclassified: number; suggested: string[] }> {
  const categories = getMemoryCategories();

  // Optionally discover new categories from "other" (free-form grouping; threshold not told to LLM)
  if (opts?.discoveredCategoriesPath && config.suggestCategories) {
    await discoverCategoriesFromOther(db, openai, config, logger, opts.discoveredCategoriesPath);
  }

  // Get all "other" facts (after discovery some may have been reclassified)
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
let credentialsDb: CredentialsDB | null = null;
let wal: WriteAheadLog | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let classifyTimer: ReturnType<typeof setInterval> | null = null;
let classifyStartupTimeout: ReturnType<typeof setTimeout> | null = null;

const PLUGIN_ID = "openclaw-hybrid-memory";

const memoryHybridPlugin = {
  id: PLUGIN_ID,
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

    factsDb = new FactsDB(resolvedSqlitePath, { fuzzyDedupe: cfg.store.fuzzyDedupe });
    vectorDb = new VectorDB(resolvedLancePath, vectorDim);
    embeddings = new Embeddings(cfg.embedding.apiKey, cfg.embedding.model);
    openaiClient = new OpenAI({ apiKey: cfg.embedding.apiKey });

    if (cfg.credentials.enabled) {
      const credPath = join(dirname(resolvedSqlitePath), "credentials.db");
      credentialsDb = new CredentialsDB(credPath, cfg.credentials.encryptionKey);
      api.logger.info(`memory-hybrid: credentials store enabled (${credPath})`);
    } else {
      credentialsDb = null;
    }

    // Load previously discovered categories so they remain available after restart
    const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");
    if (existsSync(discoveredPath)) {
      try {
        const loaded = JSON.parse(readFileSync(discoveredPath, "utf-8")) as string[];
        if (Array.isArray(loaded) && loaded.length > 0) {
          setMemoryCategories([...getMemoryCategories(), ...loaded]);
          api.logger.info(`memory-hybrid: loaded ${loaded.length} discovered categories`);
        }
      } catch {
        // ignore invalid or missing file
      }
    }

    // Initialize WAL (Write-Ahead Log) for crash resilience
    if (cfg.wal?.enabled) {
      const walPath = cfg.wal?.walPath || join(dirname(resolvedSqlitePath), "memory.wal");
      const maxAge = cfg.wal?.maxAge || 300000; // 5 minutes default
      wal = new WriteAheadLog(api.resolvePath(walPath), maxAge, api.logger);
      api.logger.info(`memory-hybrid: WAL enabled (${walPath})`);
      
      // Prune stale entries on startup
      const pruned = wal.pruneStale();
      if (pruned > 0) {
        api.logger.info(`memory-hybrid: WAL pruned ${pruned} stale entries`);
      }
      
      // TODO: Implement WAL recovery logic here
      // For now, we just log that WAL is enabled
      // Recovery would replay uncommitted operations from the WAL
    } else {
      wal = null;
    }

    api.logger.info(
      `memory-hybrid: registered (v${versionInfo.pluginVersion}, memory-manager ${versionInfo.memoryManagerVersion}) sqlite: ${resolvedSqlitePath}, lance: ${resolvedLancePath}`,
    );

    // Prerequisite checks (async, non-blocking): verify keys and model access so user gets clear errors
    void (async () => {
      try {
        await embeddings.embed("verify");
        api.logger.info("memory-hybrid: embedding API check OK");
      } catch (e) {
        api.logger.error(
          `memory-hybrid: Embedding API check failed — ${String(e)}. ` +
            "Set a valid embedding.apiKey in plugin config and ensure the model is accessible. Run 'openclaw hybrid-mem verify' for details.",
        );
      }
      if (cfg.credentials.enabled && credentialsDb) {
        try {
          const items = credentialsDb.list();
          if (items.length > 0) {
            const first = items[0];
            credentialsDb.get(first.service, first.type as CredentialType);
          }
          api.logger.info("memory-hybrid: credentials vault check OK");
        } catch (e) {
          api.logger.error(
            `memory-hybrid: Credentials vault check failed — ${String(e)}. ` +
              "Check OPENCLAW_CRED_KEY (or credentials.encryptionKey). Wrong key or corrupted DB. Run 'openclaw hybrid-mem verify' for details.",
          );
        }
        // When vault is enabled: once per install, move existing credential facts into vault and redact from memory
        const migrationFlagPath = join(dirname(resolvedSqlitePath), CREDENTIAL_REDACTION_MIGRATION_FLAG);
        if (!existsSync(migrationFlagPath)) {
          try {
            const result = await migrateCredentialsToVault({
              factsDb,
              vectorDb,
              embeddings,
              credentialsDb,
              migrationFlagPath,
              markDone: true,
            });
            if (result.migrated > 0) {
              api.logger.info(`memory-hybrid: migrated ${result.migrated} credential(s) from memory into vault`);
            }
            if (result.errors.length > 0) {
              api.logger.warn(`memory-hybrid: credential migration had ${result.errors.length} error(s): ${result.errors.join("; ")}`);
            }
          } catch (e) {
            api.logger.warn(`memory-hybrid: credential migration failed: ${e}`);
          }
        }
      }
    })();

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
          tag: Type.Optional(
            Type.String({
              description: "Optional: filter by topic tag (e.g. nibe, zigbee)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            limit = 5,
            entity,
            tag,
          } = params as { query: string; limit?: number; entity?: string; tag?: string };

          let sqliteResults: SearchResult[] = [];
          if (entity) {
            sqliteResults = factsDb.lookup(entity, undefined, tag);
          }

          const ftsResults = factsDb.search(query, limit, { tag });
          sqliteResults = [...sqliteResults, ...ftsResults];

          let lanceResults: SearchResult[] = [];
          if (!tag) {
            try {
              const vector = await embeddings.embed(query);
              lanceResults = await vectorDb.search(vector, limit, 0.3);
            } catch (err) {
              api.logger.warn(`memory-hybrid: vector search failed: ${err}`);
            }
          }

          const results = mergeResults(sqliteResults, lanceResults, limit, factsDb);

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
            tags: r.entry.tags?.length ? r.entry.tags : undefined,
            sourceDate: r.entry.sourceDate
              ? new Date(r.entry.sourceDate * 1000).toISOString().slice(0, 10)
              : undefined,
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
          tags: Type.Optional(
            Type.Array(Type.String(), {
              description: "Topic tags for sharper retrieval (e.g. nibe, zigbee). Auto-inferred if omitted.",
            }),
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
            tags: paramTags,
          } = params as {
            text: string;
            importance?: number;
            category?: MemoryCategory;
            entity?: string;
            key?: string;
            value?: string;
            decayClass?: DecayClass;
            tags?: string[];
          };

          let textToStore = text;
          if (textToStore.length > cfg.captureMaxChars) {
            textToStore = textToStore.slice(0, cfg.captureMaxChars).trim() + " [truncated]";
          }

          if (factsDb.hasDuplicate(textToStore)) {
            return {
              content: [
                { type: "text", text: `Similar memory already exists.` },
              ],
              details: { action: "duplicate" },
            };
          }

          const extracted = extractStructuredFields(textToStore, category as MemoryCategory);
          const entity = paramEntity || extracted.entity;
          const key = paramKey || extracted.key;
          const value = paramValue || extracted.value;

          // Dual-mode credentials: vault enabled → store in vault + pointer in memory; vault disabled → store in memory (live behavior).
          // When vault is enabled, credential-like content that fails to parse must not be written to memory (see docs/CREDENTIALS.md).
          if (cfg.credentials.enabled && credentialsDb && isCredentialLike(textToStore, entity, key, value)) {
            const parsed = tryParseCredentialForVault(textToStore, entity, key, value);
            if (parsed) {
              credentialsDb.store({
                service: parsed.service,
                type: parsed.type,
                value: parsed.secretValue,
                url: parsed.url,
                notes: parsed.notes,
              });
              const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
              const pointerValue = VAULT_POINTER_PREFIX + parsed.service;
              const pointerEntry = factsDb.store({
                text: pointerText,
                category: "technical" as MemoryCategory,
                importance,
                entity: "Credentials",
                key: parsed.service,
                value: pointerValue,
                source: "conversation",
                decayClass: paramDecayClass ?? "permanent",
                tags: ["auth", ...extractTags(pointerText, "Credentials")],
              });
              try {
                const vector = await embeddings.embed(pointerText);
                if (!(await vectorDb.hasDuplicate(vector))) {
                  await vectorDb.store({
                    text: pointerText,
                    vector,
                    importance,
                    category: "technical",
                  });
                }
              } catch (err) {
                api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
              }
              return {
                content: [{ type: "text", text: `Credential stored in vault for ${parsed.service} (${parsed.type}). Pointer saved in memory.` }],
                details: { action: "credential_vault", id: pointerEntry.id, service: parsed.service, type: parsed.type },
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: "Credential-like content detected but could not be parsed as a structured credential; not stored (vault is enabled).",
                },
              ],
              details: { action: "credential_skipped" },
            };
          }

          const tags =
            paramTags && paramTags.length > 0
              ? paramTags.map((t) => t.trim().toLowerCase()).filter(Boolean)
              : extractTags(textToStore, entity);

          const summaryThreshold = cfg.autoRecall.summaryThreshold;
          const summary =
            summaryThreshold > 0 && textToStore.length > summaryThreshold
              ? textToStore.slice(0, cfg.autoRecall.summaryMaxChars).trim() + "…"
              : undefined;

          // Generate vector first (needed for WAL and storage)
          let vector: number[] | undefined;
          try {
            vector = await embeddings.embed(textToStore);
          } catch (err) {
            api.logger.warn(`memory-hybrid: embedding generation failed: ${err}`);
          }

          // FR-008: Classify the operation before storing
          if (cfg.store.classifyBeforeWrite) {
            const similarFacts = factsDb.findSimilarForClassification(textToStore, entity, key, 5);
            if (similarFacts.length > 0) {
              const classification = await classifyMemoryOperation(
                textToStore, entity, key, similarFacts, openaiClient, cfg.store.classifyModel, api.logger,
              );

              if (classification.action === "NOOP") {
                return {
                  content: [{ type: "text", text: `Already known: ${classification.reason}` }],
                  details: { action: "noop", reason: classification.reason },
                };
              }

              if (classification.action === "DELETE" && classification.targetId) {
                factsDb.supersede(classification.targetId, null);
                return {
                  content: [{ type: "text", text: `Retracted fact ${classification.targetId}: ${classification.reason}` }],
                  details: { action: "delete", targetId: classification.targetId, reason: classification.reason },
                };
              }

              if (classification.action === "UPDATE" && classification.targetId) {
                const oldFact = factsDb.getById(classification.targetId);
                if (oldFact) {
                  // WAL: Write pending UPDATE operation
                  const walEntryId = randomUUID();
                  if (wal) {
                    try {
                      wal.write({
                        id: walEntryId,
                        timestamp: Date.now(),
                        operation: "update",
                        data: {
                          text: textToStore,
                          category,
                          importance: Math.max(importance, oldFact.importance),
                          entity: entity || oldFact.entity,
                          key: key || oldFact.key,
                          value: value || oldFact.value,
                          source: "conversation",
                          decayClass: paramDecayClass ?? oldFact.decayClass,
                          summary,
                          tags,
                          vector,
                        },
                      });
                    } catch (err) {
                      api.logger.warn(`memory-hybrid: WAL write failed: ${err}`);
                    }
                  }

                  // Store the new version and supersede the old one
                  const newEntry = factsDb.store({
                    text: textToStore,
                    category: category as MemoryCategory,
                    importance: Math.max(importance, oldFact.importance),
                    entity: entity || oldFact.entity,
                    key: key || oldFact.key,
                    value: value || oldFact.value,
                    source: "conversation",
                    decayClass: paramDecayClass ?? oldFact.decayClass,
                    summary,
                    tags,
                  });
                  factsDb.supersede(classification.targetId, newEntry.id);

                  const finalImportance = Math.max(importance, oldFact.importance);
                  try {
                    if (vector && !(await vectorDb.hasDuplicate(vector))) {
                      await vectorDb.store({ text: textToStore, vector, importance: finalImportance, category });
                    }
                  } catch (err) {
                    api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
                  }

                  // WAL: Remove entry after successful commit
                  if (wal) {
                    try {
                      wal.remove(walEntryId);
                    } catch (err) {
                      api.logger.warn(`memory-hybrid: WAL cleanup failed: ${err}`);
                    }
                  }

                  api.logger.info?.(
                    `memory-hybrid: UPDATE — superseded ${classification.targetId} with ${newEntry.id}: ${classification.reason}`,
                  );
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Updated: superseded old fact with "${textToStore.slice(0, 100)}${textToStore.length > 100 ? "..." : ""}"${entity ? ` [entity: ${entity}]` : ""} [decay: ${newEntry.decayClass}] (reason: ${classification.reason})`,
                      },
                    ],
                    details: { action: "updated", id: newEntry.id, superseded: classification.targetId, reason: classification.reason, backend: "both", decayClass: newEntry.decayClass },
                  };
                }
              }
              // action === "ADD" falls through to normal store
            }
          }

          // WAL: Write pending operation before committing to storage
          const walEntryId = randomUUID();
          if (wal) {
            try {
              wal.write({
                id: walEntryId,
                timestamp: Date.now(),
                operation: "store",
                data: {
                  text: textToStore,
                  category,
                  importance,
                  entity,
                  key,
                  value,
                  source: "conversation",
                  decayClass: paramDecayClass,
                  summary,
                  tags,
                  vector,
                },
              });
            } catch (err) {
              api.logger.warn(`memory-hybrid: WAL write failed: ${err}`);
            }
          }

          // Now commit to actual storage
          const entry = factsDb.store({
            text: textToStore,
            category: category as MemoryCategory,
            importance,
            entity,
            key,
            value,
            source: "conversation",
            decayClass: paramDecayClass,
            summary,
            tags,
          });

          try {
            if (vector && !(await vectorDb.hasDuplicate(vector))) {
              await vectorDb.store({
                text: textToStore,
                vector,
                importance,
                category,
              });
            }
          } catch (err) {
            api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
          }

          // WAL: Remove entry after successful commit
          if (wal) {
            try {
              wal.remove(walEntryId);
            } catch (err) {
              api.logger.warn(`memory-hybrid: WAL cleanup failed: ${err}`);
            }
          }

          return {
            content: [
              {
                type: "text",
                text: `Stored: "${textToStore.slice(0, 100)}${textToStore.length > 100 ? "..." : ""}"${entity ? ` [entity: ${entity}]` : ""} [decay: ${entry.decayClass}]`,
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

            const results = mergeResults(sqlResults, lanceResults, 5, factsDb);

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

    // Credential tools (opt-in)
    if (cfg.credentials.enabled && credentialsDb) {
      api.registerTool(
        {
          name: "credential_store",
          label: "Store Credential",
          description:
            "Store a credential (API key, token, password, SSH key, etc.) in encrypted storage. Use exact service names for reliable retrieval.",
          parameters: Type.Object({
            service: Type.String({ description: "Service name (e.g. 'home-assistant', 'github', 'openai')" }),
            type: stringEnum(CREDENTIAL_TYPES as unknown as readonly string[]),
            value: Type.String({ description: "The secret value (token, password, API key)" }),
            url: Type.Optional(Type.String({ description: "Optional URL or endpoint" })),
            notes: Type.Optional(Type.String({ description: "Optional notes" })),
            expires: Type.Optional(Type.Number({ description: "Optional Unix timestamp when credential expires" })),
          }),
          async execute(_toolCallId, params) {
            const { service, type, value, url, notes, expires } = params as {
              service: string;
              type: CredentialType;
              value: string;
              url?: string;
              notes?: string;
              expires?: number | null;
            };
            if (!credentialsDb) throw new Error("Credentials store not available");
            credentialsDb.store({ service, type, value, url, notes, expires });
            return {
              content: [{ type: "text", text: `Stored credential for ${service} (${type}).` }],
              details: { service, type },
            };
          },
        },
        { name: "credential_store" },
      );

      api.registerTool(
        {
          name: "credential_get",
          label: "Get Credential",
          description:
            "Retrieve a credential by service name. Exact lookup — no fuzzy search. Specify type to disambiguate when multiple credential types exist for a service.",
          parameters: Type.Object({
            service: Type.String({ description: "Service name (e.g. 'home-assistant', 'github')" }),
            type: Type.Optional(stringEnum(CREDENTIAL_TYPES as unknown as readonly string[])),
          }),
          async execute(_toolCallId, params) {
            const { service, type } = params as { service: string; type?: CredentialType };
            if (!credentialsDb) throw new Error("Credentials store not available");
            const entry = credentialsDb.get(service, type);
            if (!entry) {
              return {
                content: [{ type: "text", text: `No credential found for service "${service}"${type ? ` (type: ${type})` : ""}.` }],
                details: { found: false },
              };
            }
            const warnDays = cfg.credentials.expiryWarningDays ?? 7;
            const nowSec = Math.floor(Date.now() / 1000);
            const expiresSoon = entry.expires != null && entry.expires - nowSec < warnDays * 24 * 3600;
            const expiryWarning = expiresSoon
              ? ` [WARNING: Expires in ${Math.ceil((entry.expires! - nowSec) / 86400)} days — consider rotating]`
              : "";
            return {
              content: [
                {
                  type: "text",
                  text: `Credential for ${entry.service} (${entry.type}) retrieved. Value available in tool result (details.value).${expiryWarning}`,
                },
              ],
              details: {
                service: entry.service,
                type: entry.type,
                url: entry.url,
                expires: entry.expires,
                value: entry.value,
                sensitiveFields: ["value"],
              },
            };
          },
        },
        { name: "credential_get" },
      );

      api.registerTool(
        {
          name: "credential_list",
          label: "List Credentials",
          description: "List stored credentials (service/type/url only — no values). Use credential_get to retrieve a specific credential.",
          parameters: Type.Object({}),
          async execute() {
            if (!credentialsDb) throw new Error("Credentials store not available");
            const items = credentialsDb.list();
            if (items.length === 0) {
              return {
                content: [{ type: "text", text: "No credentials stored." }],
                details: { count: 0, items: [] },
              };
            }
            const lines = items.map(
              (i) => `- ${i.service} (${i.type})${i.url ? ` @ ${i.url}` : ""}${i.expires ? ` [expires: ${new Date(i.expires * 1000).toISOString()}]` : ""}`,
            );
            return {
              content: [{ type: "text", text: `Stored credentials:\n${lines.join("\n")}` }],
              details: { count: items.length, items },
            };
          },
        },
        { name: "credential_list" },
      );

      api.registerTool(
        {
          name: "credential_delete",
          label: "Delete Credential",
          description: "Delete a stored credential by service name. Optionally specify type to delete only that credential type.",
          parameters: Type.Object({
            service: Type.String({ description: "Service name" }),
            type: Type.Optional(stringEnum(CREDENTIAL_TYPES as unknown as readonly string[])),
          }),
          async execute(_toolCallId, params) {
            const { service, type } = params as { service: string; type?: CredentialType };
            if (!credentialsDb) throw new Error("Credentials store not available");
            const deleted = credentialsDb.delete(service, type);
            if (!deleted) {
              return {
                content: [{ type: "text", text: `No credential found for "${service}"${type ? ` (type: ${type})` : ""}.` }],
                details: { deleted: false },
              };
            }
            return {
              content: [{ type: "text", text: `Deleted credential for ${service}${type ? ` (${type})` : ""}.` }],
              details: { deleted: true, service, type },
            };
          },
        },
        { name: "credential_delete" },
      );
    }

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

    api.registerTool(
      {
        name: "memory_reflect",
        label: "Memory Reflect",
        description:
          "Analyze recent facts to extract behavioral patterns and meta-insights (FR-011). Use this periodically to synthesize higher-order patterns from observations.",
        parameters: Type.Object({
          window: Type.Optional(
            Type.Number({ description: "Time window in days (default from config or 14)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          if (!cfg.reflection.enabled) {
            return {
              content: [{ type: "text", text: "Reflection is disabled. Enable it in config: reflection.enabled = true" }],
              details: { enabled: false },
            };
          }

          const { window = cfg.reflection.defaultWindow } = params as { window?: number };
          const validWindow = Math.max(1, Math.min(90, window));

          const result = await runReflection(
            factsDb,
            vectorDb,
            embeddings,
            openaiClient,
            {
              window: validWindow,
              model: cfg.reflection.model,
              minObservations: cfg.reflection.minObservations,
              dryRun: false,
            },
            api.logger,
          );

          const text = `Reflection complete.\nFacts analyzed: ${result.factsAnalyzed} (last ${validWindow} days)\nPatterns extracted: ${result.patternsExtracted}\nPatterns stored: ${result.patternsStored}`;

          return {
            content: [{ type: "text", text }],
            details: {
              factsAnalyzed: result.factsAnalyzed,
              patternsExtracted: result.patternsExtracted,
              patternsStored: result.patternsStored,
              window: validWindow,
            },
          };
        },
      },
      { name: "memory_reflect" },
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

                const category = detectCategory(trimmed);
                const extracted = extractStructuredFields(trimmed, category);

                // Dual-mode credentials: vault on → store in vault + pointer only; vault off → store in facts (live behavior).
                // When vault is enabled, credential-like content that fails to parse must not be written to memory (see docs/CREDENTIALS.md).
                if (isCredentialLike(trimmed, extracted.entity, extracted.key, extracted.value)) {
                  if (cfg.credentials.enabled && credentialsDb) {
                    const parsed = tryParseCredentialForVault(trimmed, extracted.entity, extracted.key, extracted.value);
                    if (parsed) {
                      if (!opts.dryRun) {
                        credentialsDb.store({
                          service: parsed.service,
                          type: parsed.type,
                          value: parsed.secretValue,
                          url: parsed.url,
                          notes: parsed.notes,
                        });
                        const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
                        const sourceDateSec = Math.floor(new Date(dateStr).getTime() / 1000);
                        factsDb.store({
                          text: pointerText,
                          category: "technical",
                          importance: 0.8,
                          entity: "Credentials",
                          key: parsed.service,
                          value: VAULT_POINTER_PREFIX + parsed.service,
                          source: `daily-scan:${dateStr}`,
                          sourceDate: sourceDateSec,
                          tags: ["auth", ...extractTags(pointerText, "Credentials")],
                        });
                        try {
                          const vector = await embeddings.embed(pointerText);
                          if (!(await vectorDb.hasDuplicate(vector))) {
                            await vectorDb.store({ text: pointerText, vector, importance: 0.8, category: "technical" });
                          }
                        } catch (err) {
                          api.logger.warn(`memory-hybrid: extract-daily vector store failed: ${err}`);
                        }
                        totalStored++;
                      } else {
                        totalExtracted++;
                      }
                      continue;
                    }
                    /* vault enabled but parse failed: skip this line (do not store credential-like text in facts) */
                    continue;
                  }
                  /* vault disabled: fall through to store in facts */
                }

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
                  sourceDate: Math.floor(new Date(dateStr).getTime() / 1000),
                  tags: extractTags(trimmed, extracted.entity),
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
          .option("--tag <tag>", "Filter by topic tag (e.g. nibe, zigbee)")
          .action(async (query, opts: { limit?: string; tag?: string }) => {
            const limit = parseInt(opts.limit || "5");
            const tag = opts.tag?.trim();
            const sqlResults = factsDb.search(query, limit, { tag });
            let lanceResults: SearchResult[] = [];
            if (!tag) {
              const vector = await embeddings.embed(query);
              lanceResults = await vectorDb.search(vector, limit, 0.3);
            }
            const merged = mergeResults(sqlResults, lanceResults, limit, factsDb);

            const output = merged.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              entity: r.entry.entity,
              score: r.score,
              backend: r.backend,
              tags: r.entry.tags?.length ? r.entry.tags : undefined,
              sourceDate: r.entry.sourceDate
                ? new Date(r.entry.sourceDate * 1000).toISOString().slice(0, 10)
                : undefined,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        mem
          .command("lookup")
          .description("Exact entity lookup in SQLite")
          .argument("<entity>", "Entity name")
          .option("--key <key>", "Optional key filter")
          .option("--tag <tag>", "Filter by topic tag (e.g. nibe, zigbee)")
          .action(async (entity, opts: { key?: string; tag?: string }) => {
            const results = factsDb.lookup(entity, opts.key, opts.tag?.trim());
            const output = results.map((r) => ({
              id: r.entry.id,
              text: r.entry.text,
              entity: r.entry.entity,
              key: r.entry.key,
              value: r.entry.value,
              tags: r.entry.tags?.length ? r.entry.tags : undefined,
              sourceDate: r.entry.sourceDate
                ? new Date(r.entry.sourceDate * 1000).toISOString().slice(0, 10)
                : undefined,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        mem
          .command("store")
          .description("Store a fact (for scripts; agents use memory_store tool)")
          .requiredOption("--text <text>", "Fact text")
          .option("--category <cat>", "Category", "other")
          .option("--entity <entity>", "Entity name")
          .option("--key <key>", "Structured key")
          .option("--value <value>", "Structured value")
          .option("--source-date <date>", "When fact originated (ISO-8601, e.g. 2026-01-15)")
          .option("--tags <tags>", "Comma-separated topic tags (e.g. nibe,zigbee); auto-inferred if omitted")
          .action(async (opts: { text: string; category?: string; entity?: string; key?: string; value?: string; sourceDate?: string; tags?: string }) => {
            const text = opts.text;
            if (!text || text.length < 2) {
              console.error("--text is required and must be at least 2 characters");
              process.exitCode = 1;
              return;
            }
            if (factsDb.hasDuplicate(text)) {
              console.log("Similar memory already exists.");
              return;
            }
            const sourceDate = opts.sourceDate ? parseSourceDate(opts.sourceDate) : null;
            const extracted = extractStructuredFields(text, (opts.category ?? "other") as MemoryCategory);
            const entity = opts.entity ?? extracted.entity ?? null;
            const key = opts.key ?? extracted.key ?? null;
            const value = opts.value ?? extracted.value ?? null;

            // Dual-mode: vault enabled and credential-like → vault + pointer; else store in memory.
            // When vault is enabled, credential-like content that fails to parse must not be written to memory (see docs/CREDENTIALS.md).
            if (cfg.credentials.enabled && credentialsDb && isCredentialLike(text, entity, key, value)) {
              const parsed = tryParseCredentialForVault(text, entity, key, value);
              if (parsed) {
                credentialsDb.store({
                  service: parsed.service,
                  type: parsed.type,
                  value: parsed.secretValue,
                  url: parsed.url,
                  notes: parsed.notes,
                });
                const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
                const pointerValue = VAULT_POINTER_PREFIX + parsed.service;
                const pointerEntry = factsDb.store({
                  text: pointerText,
                  category: "technical" as MemoryCategory,
                  importance: 0.7,
                  entity: "Credentials",
                  key: parsed.service,
                  value: pointerValue,
                  source: "cli",
                  sourceDate,
                  tags: ["auth", ...extractTags(pointerText, "Credentials")],
                });
                try {
                  const vector = await embeddings.embed(pointerText);
                  if (!(await vectorDb.hasDuplicate(vector))) {
                    await vectorDb.store({ text: pointerText, vector, importance: 0.7, category: "technical" });
                  }
                } catch (err) {
                  api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
                }
                console.log(`Credential stored in vault for ${parsed.service} (${parsed.type}). Pointer [id: ${pointerEntry.id}].`);
                return;
              }
              console.error(
                "Credential-like content detected but could not be parsed as a structured credential; not stored (vault is enabled).",
              );
              process.exitCode = 1;
              return;
            }

            const tags = opts.tags
              ? opts.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
              : undefined;
            const entry = factsDb.store({
              text,
              category: (opts.category ?? "other") as MemoryCategory,
              importance: 0.7,
              entity,
              key: opts.key ?? extracted.key ?? null,
              value: opts.value ?? extracted.value ?? null,
              source: "cli",
              sourceDate,
              tags: tags ?? extractTags(text, entity),
            });
            try {
              const vector = await embeddings.embed(text);
              if (!(await vectorDb.hasDuplicate(vector))) {
                await vectorDb.store({ text, vector, importance: 0.7, category: opts.category ?? "other" });
              }
            } catch (err) {
              api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
            }
            console.log(`Stored: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" [id: ${entry.id}]`);
          });

        mem
          .command("classify")
          .description("Auto-classify 'other' facts using LLM (uses autoClassify config). Runs category discovery first when enabled.")
          .option("--dry-run", "Show classifications without applying")
          .option("--limit <n>", "Max facts to classify", "500")
          .option("--model <model>", "Override LLM model")
          .action(async (opts: { dryRun?: boolean; limit?: string; model?: string }) => {
            const classifyModel = opts.model || cfg.autoClassify.model;
            const limit = parseInt(opts.limit || "500");
            const logger = { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) };

            console.log(`Auto-classify config:`);
            console.log(`  Model: ${classifyModel}`);
            console.log(`  Batch size: ${cfg.autoClassify.batchSize}`);
            console.log(`  Suggest categories: ${cfg.autoClassify.suggestCategories !== false}`);
            console.log(`  Categories: ${getMemoryCategories().join(", ")}`);
            console.log(`  Limit: ${limit}`);
            console.log(`  Dry run: ${!!opts.dryRun}\n`);

            let others = factsDb.getByCategory("other").slice(0, limit);
            if (others.length === 0) {
              console.log("No 'other' facts to classify.");
              return;
            }

            // Run category discovery first (when not dry-run and enough "other" facts)
            if (!opts.dryRun && cfg.autoClassify.suggestCategories && others.length >= MIN_OTHER_FOR_DISCOVERY) {
              const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");
              await discoverCategoriesFromOther(
                factsDb,
                openaiClient,
                { ...cfg.autoClassify, model: classifyModel },
                logger,
                discoveredPath,
              );
              others = factsDb.getByCategory("other").slice(0, limit);
            }

            console.log(`Classifying ${others.length} "other" facts\n`);

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

        mem
          .command("find-duplicates")
          .description("Report pairs of facts with embedding similarity ≥ threshold (2.2); no merge")
          .option("--threshold <n>", "Similarity threshold 0–1 (default 0.92)", "0.92")
          .option("--include-structured", "Include identifier-like facts (IP, email, etc.); default is to skip")
          .option("--limit <n>", "Max facts to consider (default 300)", "300")
          .action(async (opts: { threshold?: string; includeStructured?: boolean; limit?: string }) => {
            const threshold = Math.min(1, Math.max(0, parseFloat(opts.threshold || "0.92")));
            const limit = Math.min(500, Math.max(10, parseInt(opts.limit || "300")));
            const result = await runFindDuplicates(
              factsDb,
              embeddings,
              { threshold, includeStructured: !!opts.includeStructured, limit },
              api.logger,
            );
            console.log(`Candidates: ${result.candidatesCount} (skipped identifier-like: ${result.skippedStructured})`);
            console.log(`Pairs with similarity ≥ ${threshold}: ${result.pairs.length}`);
            const trim = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max) + "…");
            for (const p of result.pairs) {
              console.log(`  ${p.idA} <-> ${p.idB} (${p.score.toFixed(3)})`);
              console.log(`    A: ${trim(p.textA, 80)}`);
              console.log(`    B: ${trim(p.textB, 80)}`);
            }
          });

        mem
          .command("reflect")
          .description("Analyze recent facts to extract behavioral patterns (FR-011)")
          .option("--window <days>", "Time window in days (default from config or 14)", String(cfg.reflection.defaultWindow))
          .option("--dry-run", "Show extracted patterns without storing")
          .option("--model <model>", "LLM for reflection (default from config or gpt-4o-mini)", cfg.reflection.model)
          .option("--force", "Run even if reflection is disabled in config")
          .action(async (opts: { window?: string; dryRun?: boolean; model?: string; force?: boolean }) => {
            if (!cfg.reflection.enabled && !opts.force) {
              console.error("Reflection is disabled in config. Enable it with reflection.enabled = true, or use --force to run anyway.");
              process.exitCode = 1;
              return;
            }
            const window = Math.max(1, Math.min(90, parseInt(opts.window || String(cfg.reflection.defaultWindow))));
            const model = opts.model || cfg.reflection.model;
            const result = await runReflection(
              factsDb,
              vectorDb,
              embeddings,
              openaiClient,
              {
                window,
                model,
                minObservations: cfg.reflection.minObservations,
                dryRun: !!opts.dryRun,
              },
              api.logger,
            );
            console.log(`Facts analyzed: ${result.factsAnalyzed} (last ${window} days)`);
            console.log(`Patterns extracted: ${result.patternsExtracted}`);
            console.log(`Patterns stored: ${result.patternsStored}${opts.dryRun ? " (dry run)" : ""}`);
          });

        mem
          .command("consolidate")
          .description("Merge near-duplicate facts: cluster by embedding similarity, LLM-merge each cluster (2.4)")
          .option("--threshold <n>", "Similarity threshold 0–1 (default 0.92)", "0.92")
          .option("--include-structured", "Include identifier-like facts (IP, email, etc.); default is to skip")
          .option("--dry-run", "Report clusters and would-merge only; do not store or delete")
          .option("--limit <n>", "Max facts to consider (default 300)", "300")
          .option("--model <model>", "LLM for merge (default gpt-4o-mini)", "gpt-4o-mini")
          .action(async (opts: { threshold?: string; includeStructured?: boolean; dryRun?: boolean; limit?: string; model?: string }) => {
            const threshold = Math.min(1, Math.max(0, parseFloat(opts.threshold || "0.92")));
            const limit = Math.min(500, Math.max(10, parseInt(opts.limit || "300")));
            const result = await runConsolidate(
              factsDb,
              vectorDb,
              embeddings,
              openaiClient,
              {
                threshold,
                includeStructured: !!opts.includeStructured,
                dryRun: !!opts.dryRun,
                limit,
                model: opts.model || "gpt-4o-mini",
              },
              api.logger,
            );
            console.log(`Clusters found: ${result.clustersFound}`);
            console.log(`Merged: ${result.merged}`);
            console.log(`Deleted: ${result.deleted}${opts.dryRun ? " (dry run)" : ""}`);
          });

        mem
          .command("install")
          .description("Apply full recommended config, prompts, and optional jobs (idempotent). Run after first plugin setup for best defaults.")
          .option("--dry-run", "Print what would be merged without writing")
          .action(async (opts: { dryRun?: boolean }) => {
            const openclawDir = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
            const configPath = join(openclawDir, "openclaw.json");
            mkdirSync(openclawDir, { recursive: true });
            const memoryDir = join(openclawDir, "memory");
            mkdirSync(memoryDir, { recursive: true });

            const fullDefaults = {
              memory: { backend: "builtin" as const, citations: "auto" as const },
              plugins: {
                slots: { memory: PLUGIN_ID },
                entries: {
                  "memory-core": { enabled: true },
                  [PLUGIN_ID]: {
                    enabled: true,
                    config: {
                      embedding: { apiKey: "YOUR_OPENAI_API_KEY", model: "text-embedding-3-small" },
                      autoCapture: true,
                      autoRecall: true,
                      captureMaxChars: 5000,
                      store: { fuzzyDedupe: false },
                      autoClassify: { enabled: true, model: "gpt-4o-mini", batchSize: 20 },
                      categories: [] as string[],
                      credentials: { enabled: false, store: "sqlite" as const, encryptionKey: "", autoDetect: false, expiryWarningDays: 7 },
                    },
                  },
                },
              },
              agents: {
                defaults: {
                  bootstrapMaxChars: 15000,
                  bootstrapTotalMaxChars: 50000,
                  memorySearch: {
                    enabled: true,
                    sources: ["memory"],
                    provider: "openai",
                    model: "text-embedding-3-small",
                    sync: { onSessionStart: true, onSearch: true, watch: true },
                    chunking: { tokens: 500, overlap: 50 },
                    query: { maxResults: 8, minScore: 0.3, hybrid: { enabled: true } },
                  },
                  compaction: {
                    mode: "default",
                    memoryFlush: {
                      enabled: true,
                      softThresholdTokens: 4000,
                      systemPrompt: "Session nearing compaction. You MUST save all important context NOW using BOTH memory systems before it is lost. This is your last chance to preserve this information.",
                      prompt: "URGENT: Context is about to be compacted. Scan the full conversation and:\n1. Use memory_store for each important fact, preference, decision, or entity (structured storage survives compaction)\n2. Write a session summary to memory/YYYY-MM-DD.md with key topics, decisions, and open items\n3. Update any relevant memory/ files if project state or technical details changed\n\nDo NOT skip this. Reply NO_REPLY only if there is truly nothing worth saving.",
                    },
                  },
                  pruning: { ttl: "30m" },
                },
              },
              jobs: [
                {
                  name: "nightly-memory-sweep",
                  schedule: "0 2 * * *",
                  channel: "system",
                  message: "Run nightly session distillation: last 3 days, Gemini model, isolated session. Log to scripts/distill-sessions/nightly-logs/YYYY-MM-DD.log",
                  isolated: true,
                  model: "gemini",
                },
              ],
            };

            function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
              for (const key of Object.keys(source)) {
                const srcVal = source[key];
                const tgtVal = target[key];
                if (srcVal !== null && typeof srcVal === "object" && !Array.isArray(srcVal) && tgtVal !== null && typeof tgtVal === "object" && !Array.isArray(tgtVal)) {
                  deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
                } else if (key === "jobs" && Array.isArray(srcVal)) {
                  const arr = (Array.isArray(tgtVal) ? [...tgtVal] : []) as unknown[];
                  const hasNightly = arr.some((j: unknown) => (j as Record<string, unknown>)?.name === "nightly-memory-sweep");
                  if (!hasNightly) {
                    const nightly = (srcVal as unknown[]).find((j: unknown) => (j as Record<string, unknown>)?.name === "nightly-memory-sweep");
                    if (nightly) arr.push(nightly);
                  }
                  (target as Record<string, unknown>)[key] = arr;
                } else if (tgtVal === undefined && !Array.isArray(srcVal)) {
                  (target as Record<string, unknown>)[key] = srcVal;
                }
              }
            }

            let config: Record<string, unknown> = {};
            if (existsSync(configPath)) {
              try {
                config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
              } catch (e) {
                console.error(`Could not read ${configPath}: ${e}`);
                return;
              }
            }
            const existingApiKey = (config?.plugins as Record<string, unknown>)?.["entries"] && ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)?.[PLUGIN_ID] && (((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>)?.config && ((((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>).config as Record<string, unknown>)?.embedding && (((((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)[PLUGIN_ID] as Record<string, unknown>).config as Record<string, unknown>).embedding as Record<string, unknown>)?.apiKey;
            const isRealKey = typeof existingApiKey === "string" && existingApiKey.length >= 10 && existingApiKey !== "YOUR_OPENAI_API_KEY" && existingApiKey !== "<OPENAI_API_KEY>";

            if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
            if (!(config.agents && typeof config.agents === "object")) config.agents = { defaults: {} };
            deepMerge(config, fullDefaults as unknown as Record<string, unknown>);
            if (isRealKey) {
              const entries = (config.plugins as Record<string, unknown>).entries as Record<string, unknown>;
              const mh = entries[PLUGIN_ID] as Record<string, unknown>;
              const cfg = mh?.config as Record<string, unknown>;
              const emb = cfg?.embedding as Record<string, unknown>;
              if (emb) emb.apiKey = existingApiKey;
            }
            const after = JSON.stringify(config, null, 2);

            if (opts.dryRun) {
              console.log("Would merge into " + configPath + ":");
              console.log(after);
              return;
            }
            writeFileSync(configPath, after, "utf-8");
            console.log("Config written: " + configPath);
            console.log(`Applied: plugins.slots.memory=${PLUGIN_ID}, ${PLUGIN_ID} config (all features), memorySearch, compaction prompts, bootstrap limits, pruning, autoClassify, nightly-memory-sweep job.`);
            console.log("\nNext steps:");
            console.log(`  1. Set embedding.apiKey in plugins.entries["${PLUGIN_ID}"].config (or use env:OPENAI_API_KEY in config).`);
            console.log("  2. Restart the gateway: openclaw gateway stop && openclaw gateway start");
            console.log("  3. Run: openclaw hybrid-mem verify [--fix]");
          });

        mem
          .command("verify")
          .description("Verify plugin config, databases, and suggest fixes (run after gateway start for full checks)")
          .option("--fix", "Print or apply default config for missing items")
          .option("--log-file <path>", "Check this log file for memory-hybrid / cron errors")
          .action(async (opts: { fix?: boolean; logFile?: string }) => {
            const issues: string[] = [];
            const fixes: string[] = [];
            let configOk = true;
            let sqliteOk = false;
            let lanceOk = false;
            let embeddingOk = false;

            const loadBlocking: string[] = [];
            if (!cfg.embedding.apiKey || cfg.embedding.apiKey === "YOUR_OPENAI_API_KEY" || cfg.embedding.apiKey.length < 10) {
              issues.push("embedding.apiKey is missing, placeholder, or too short");
              loadBlocking.push("embedding.apiKey is missing, placeholder, or too short");
              fixes.push(`LOAD-BLOCKING: Set plugins.entries["${PLUGIN_ID}"].config.embedding.apiKey to a valid OpenAI key (and embedding.model to "text-embedding-3-small"). Edit ~/.openclaw/openclaw.json or set OPENAI_API_KEY and use env:OPENAI_API_KEY in config.`);
              configOk = false;
            }
            if (!cfg.embedding.model) {
              issues.push("embedding.model is missing");
              loadBlocking.push("embedding.model is missing");
              fixes.push('Set "embedding.model" to "text-embedding-3-small" or "text-embedding-3-large" in plugin config');
              configOk = false;
            }
            const openclawDir = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
            const defaultConfigPath = join(openclawDir, "openclaw.json");
            if (configOk) console.log("Config: embedding.apiKey and model present");
            else console.log("Config: issues found");

            try {
              const n = factsDb.count();
              sqliteOk = true;
              console.log(`SQLite: OK (${resolvedSqlitePath}, ${n} facts)`);
            } catch (e) {
              issues.push(`SQLite: ${String(e)}`);
              fixes.push(`SQLite: Ensure path is writable and not corrupted. Path: ${resolvedSqlitePath}. If corrupted, back up and remove the file to recreate, or run from a process with write access.`);
              console.log(`SQLite: FAIL — ${String(e)}`);
            }

            try {
              const n = await vectorDb.count();
              lanceOk = true;
              console.log(`LanceDB: OK (${resolvedLancePath}, ${n} vectors)`);
            } catch (e) {
              issues.push(`LanceDB: ${String(e)}`);
              fixes.push(`LanceDB: Ensure path is writable. Path: ${resolvedLancePath}. If corrupted, back up and remove the directory to recreate. Restart gateway after fix.`);
              console.log(`LanceDB: FAIL — ${String(e)}`);
            }

            try {
              await embeddings.embed("verify test");
              embeddingOk = true;
              console.log("Embedding API: OK");
            } catch (e) {
              issues.push(`Embedding API: ${String(e)}`);
              fixes.push(`Embedding API: Check key at platform.openai.com; ensure it has access to the embedding model (${cfg.embedding.model}). Set plugins.entries[\"openclaw-hybrid-memory\"].config.embedding.apiKey and restart. 401/403 = invalid or revoked key.`);
              console.log(`Embedding API: FAIL — ${String(e)}`);
            }

            // Features summary
            console.log("\nFeatures:");
            console.log(`  autoCapture: ${cfg.autoCapture}`);
            console.log(`  autoRecall: ${cfg.autoRecall.enabled}`);
            console.log(`  autoClassify: ${cfg.autoClassify.enabled ? cfg.autoClassify.model : "off"}`);
            console.log(`  credentials: ${cfg.credentials.enabled ? "enabled" : "disabled"}`);
            console.log(`  store.fuzzyDedupe: ${cfg.store.fuzzyDedupe}`);

            // Credentials: enabled?, key defined?, vault accessible?
            let credentialsOk = true;
            if (cfg.credentials.enabled) {
              const keyDefined = !!cfg.credentials.encryptionKey && cfg.credentials.encryptionKey.length >= 16;
              if (!keyDefined) {
                issues.push("credentials.enabled but encryption key missing or too short (min 16 chars or env:VAR)");
                loadBlocking.push("credentials enabled but encryption key missing or too short");
                fixes.push("LOAD-BLOCKING: Set credentials.encryptionKey to env:OPENCLAW_CRED_KEY and export OPENCLAW_CRED_KEY (min 16 chars), or set a 16+ character secret in plugin config. See docs/CREDENTIALS.md.");
                credentialsOk = false;
                console.log("\nCredentials: enabled — key missing or too short (set OPENCLAW_CRED_KEY or credentials.encryptionKey)");
              } else if (credentialsDb) {
                try {
                  const items = credentialsDb.list();
                  if (items.length > 0) {
                    const first = items[0];
                    credentialsDb.get(first.service, first.type as CredentialType);
                  }
                  console.log(`\nCredentials: enabled — key set, vault OK (${items.length} stored)`);
                } catch (e) {
                  issues.push(`Credentials vault: ${String(e)} (wrong key or corrupted DB)`);
                  fixes.push(`Credentials vault: Wrong encryption key or corrupted DB. Set OPENCLAW_CRED_KEY to the same key used when credentials were stored, or disable credentials in config. See docs/CREDENTIALS.md.`);
                  credentialsOk = false;
                  console.log(`\nCredentials: enabled — vault FAIL — ${String(e)} (check OPENCLAW_CRED_KEY / encryptionKey)`);
                }
              } else {
                console.log("\nCredentials: enabled — key set (vault not opened in this process)");
              }
            } else {
              console.log("\nCredentials: disabled");
            }

            // Session distillation: last run (optional file)
            const memoryDir = dirname(resolvedSqlitePath);
            const distillLastRunPath = join(memoryDir, ".distill_last_run");
            if (existsSync(distillLastRunPath)) {
              try {
                const line = readFileSync(distillLastRunPath, "utf-8").split("\n")[0]?.trim() || "";
                console.log(`\nSession distillation: last run recorded ${line ? `— ${line}` : "(empty file)"}`);
              } catch {
                console.log("\nSession distillation: last run file present but unreadable");
              }
            } else {
              console.log("\nSession distillation: last run not recorded (optional).");
              console.log("  If you use session distillation (extracting facts from old logs): after each run, run: openclaw hybrid-mem record-distill");
              console.log("  If you have a nightly distillation cron job: add a final step to that job to run openclaw hybrid-mem record-distill so this is recorded.");
              console.log("  If you don't use it, ignore this.");
            }

            // Optional / suggested jobs (e.g. nightly session distillation)
            // Check OpenClaw cron store first (~/.openclaw/cron/jobs.json), then legacy openclaw.json "jobs"
            let nightlySweepDefined = false;
            let nightlySweepEnabled = true;
            const cronStorePath = join(openclawDir, "cron", "jobs.json");
            if (existsSync(cronStorePath)) {
              try {
                const raw = readFileSync(cronStorePath, "utf-8");
                const store = JSON.parse(raw) as Record<string, unknown>;
                const jobs = store.jobs;
                if (Array.isArray(jobs)) {
                  const nightly = jobs.find((j: unknown) => {
                    if (typeof j !== "object" || j === null) return false;
                    const name = String((j as Record<string, unknown>).name ?? "").toLowerCase();
                    const pl = (j as Record<string, unknown>).payload as Record<string, unknown> | undefined;
                    const msg = String(pl?.message ?? (j as Record<string, unknown>).message ?? "").toLowerCase();
                    return /nightly-memory-sweep|memory distillation.*nightly|nightly.*memory.*distill/.test(name) || /nightly memory distillation|memory distillation pipeline/.test(msg);
                  }) as Record<string, unknown> | undefined;
                  if (nightly) {
                    nightlySweepDefined = true;
                    nightlySweepEnabled = nightly.enabled !== false;
                  }
                }
              } catch {
                // ignore parse or read errors
              }
            }
            if (!nightlySweepDefined && existsSync(defaultConfigPath)) {
              try {
                const raw = readFileSync(defaultConfigPath, "utf-8");
                const root = JSON.parse(raw) as Record<string, unknown>;
                const jobs = root.jobs;
                if (Array.isArray(jobs)) {
                  const nightly = jobs.find((j: unknown) => typeof j === "object" && j !== null && (j as Record<string, unknown>).name === "nightly-memory-sweep") as Record<string, unknown> | undefined;
                  if (nightly) {
                    nightlySweepDefined = true;
                    nightlySweepEnabled = nightly.enabled !== false;
                  }
                } else if (jobs && typeof jobs === "object" && !Array.isArray(jobs)) {
                  const nightly = (jobs as Record<string, unknown>)["nightly-memory-sweep"];
                  if (nightly && typeof nightly === "object") {
                    nightlySweepDefined = true;
                    nightlySweepEnabled = (nightly as Record<string, unknown>).enabled !== false;
                  }
                }
              } catch {
                // ignore
              }
            }
            console.log("\nOptional / suggested jobs (cron store or openclaw.json):");
            if (nightlySweepDefined) {
              console.log(`  nightly-memory-sweep (session distillation): defined, ${nightlySweepEnabled ? "enabled" : "disabled"}`);
            } else {
              console.log("  nightly-memory-sweep (session distillation): not defined");
              fixes.push("Optional: Set up nightly session distillation via OpenClaw's scheduled jobs (e.g. cron store or UI) or system cron. See docs/SESSION-DISTILLATION.md § Nightly Cron Setup.");
            }

            console.log("\nBackground jobs (when gateway is running): prune every 60min, auto-classify every 24h if enabled. No external cron required.");
            if (opts.logFile && existsSync(opts.logFile)) {
              const content = readFileSync(opts.logFile, "utf-8");
              const lines = content.split("\n").filter((l) => /memory-hybrid|prune|auto-classify|periodic|failed/.test(l));
              const errLines = lines.filter((l) => /error|fail|warn/i.test(l));
              if (errLines.length > 0) {
                console.log(`\nRecent log lines mentioning memory-hybrid/errors (last ${errLines.length}):`);
                errLines.slice(-10).forEach((l) => console.log(`  ${l.slice(0, 120)}`));
              } else if (lines.length > 0) {
                console.log(`\nLog file: ${lines.length} relevant lines (no errors in sample)`);
              }
            } else if (opts.logFile) {
              console.log(`\nLog file not found: ${opts.logFile}`);
            }

            const allOk = configOk && sqliteOk && lanceOk && embeddingOk && (!cfg.credentials.enabled || credentialsOk);
            if (allOk) {
              console.log("\nAll checks passed.");
              if (!nightlySweepDefined) {
                console.log("Optional: Set up nightly session distillation via OpenClaw's scheduled jobs or system cron. See docs/SESSION-DISTILLATION.md.");
              }
            } else {
              console.log("\n--- Issues ---");
              if (loadBlocking.length > 0) {
                console.log("Load-blocking (prevent OpenClaw / plugin from loading):");
                loadBlocking.forEach((i) => console.log(`  - ${i}`));
              }
              const other = issues.filter((i) => !loadBlocking.includes(i));
              if (other.length > 0) {
                console.log(other.length > 0 && loadBlocking.length > 0 ? "Other:" : "Issues:");
                other.forEach((i) => console.log(`  - ${i}`));
              }
              console.log("\n--- Fixes for detected issues ---");
              fixes.forEach((f) => console.log(`  • ${f}`));
              console.log("\nEdit config: " + defaultConfigPath + " (or OPENCLAW_HOME/openclaw.json). Restart gateway after changing plugin config.");
            }

            if (opts.fix) {
              const applied: string[] = [];
              if (existsSync(defaultConfigPath)) {
                try {
                  const raw = readFileSync(defaultConfigPath, "utf-8");
                  const fixConfig = JSON.parse(raw) as Record<string, unknown>;
                  let changed = false;
                  if (!fixConfig.plugins || typeof fixConfig.plugins !== "object") fixConfig.plugins = {};
                  const plugins = fixConfig.plugins as Record<string, unknown>;
                  if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
                  const entries = plugins.entries as Record<string, unknown>;
                  if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object") entries[PLUGIN_ID] = { enabled: true, config: {} };
                  const mh = entries[PLUGIN_ID] as Record<string, unknown>;
                  if (!mh.config || typeof mh.config !== "object") mh.config = {};
                  const cfg = mh.config as Record<string, unknown>;
                  if (!cfg.embedding || typeof cfg.embedding !== "object") cfg.embedding = {};
                  const emb = cfg.embedding as Record<string, unknown>;
                  const curKey = emb.apiKey;
                  const placeholder = typeof curKey !== "string" || curKey.length < 10 || curKey === "YOUR_OPENAI_API_KEY" || curKey === "<OPENAI_API_KEY>";
                  if (placeholder) {
                    emb.apiKey = process.env.OPENAI_API_KEY || "YOUR_OPENAI_API_KEY";
                    emb.model = emb.model || "text-embedding-3-small";
                    changed = true;
                    applied.push("Set embedding.apiKey and model (replace YOUR_OPENAI_API_KEY with your key if not using env)");
                  }
                  // Add nightly-memory-sweep job if missing (same as install), so upgrade/snippet-only users get it without running full install.
                  const jobs = Array.isArray(fixConfig.jobs) ? fixConfig.jobs : [];
                  const hasNightly = jobs.some((j: unknown) => (j as Record<string, unknown>)?.name === "nightly-memory-sweep");
                  if (!hasNightly) {
                    jobs.push({
                      name: "nightly-memory-sweep",
                      schedule: "0 2 * * *",
                      channel: "system",
                      message:
                        "Run nightly session distillation: last 3 days, Gemini model, isolated session. Log to scripts/distill-sessions/nightly-logs/YYYY-MM-DD.log",
                      isolated: true,
                      model: "gemini",
                    });
                    (fixConfig as Record<string, unknown>).jobs = jobs;
                    changed = true;
                    applied.push("Added nightly-memory-sweep job for session distillation");
                  }
                  const memoryDirPath = dirname(resolvedSqlitePath);
                  if (!existsSync(memoryDirPath)) {
                    mkdirSync(memoryDirPath, { recursive: true });
                    applied.push("Created memory directory: " + memoryDirPath);
                  }
                  if (changed) {
                    writeFileSync(defaultConfigPath, JSON.stringify(fixConfig, null, 2), "utf-8");
                  }
                  if (applied.length > 0) {
                    console.log("\n--- Applied fixes ---");
                    applied.forEach((a) => console.log("  • " + a));
                    if (changed) console.log("Config written: " + defaultConfigPath + ". Restart the gateway and run verify again.");
                  }
                } catch (e) {
                  console.log("\nCould not apply fixes to config: " + String(e));
                  const snippet = {
                    embedding: { apiKey: process.env.OPENAI_API_KEY || "<set your key>", model: "text-embedding-3-small" },
                    autoCapture: true,
                    autoRecall: true,
                    captureMaxChars: 5000,
                    store: { fuzzyDedupe: false },
                  };
                  console.log(`Minimal config snippet to merge into plugins.entries["${PLUGIN_ID}"].config:`);
                  console.log(JSON.stringify(snippet, null, 2));
                }
              } else {
                console.log("\n--- Fix (--fix) ---");
                console.log("Config file not found. Run 'openclaw hybrid-mem install' to create it with full defaults, then set your API key and restart.");
              }
            }
          });

        const cred = mem
          .command("credentials")
          .description("Credentials vault commands");
        cred
          .command("migrate-to-vault")
          .description("Move credential facts from memory into vault and redact originals (idempotent)")
          .action(async () => {
            if (!credentialsDb) {
              console.error("Credentials vault is disabled. Enable it in plugin config (credentials.encryptionKey) and restart.");
              return;
            }
            const migrationFlagPath = join(dirname(resolvedSqlitePath), CREDENTIAL_REDACTION_MIGRATION_FLAG);
            const result = await migrateCredentialsToVault({
              factsDb,
              vectorDb,
              embeddings,
              credentialsDb,
              migrationFlagPath,
              markDone: true,
            });
            console.log(`Migrated: ${result.migrated}, skipped: ${result.skipped}`);
            if (result.errors.length > 0) {
              console.error("Errors:");
              result.errors.forEach((e) => console.error(`  - ${e}`));
            }
          });

        /** Full distillation: max days of history to process when .distill_last_run is missing (avoids unbounded first run). */
        const FULL_DISTILL_MAX_DAYS = 90;
        /** Incremental: process at least this many days when last run exists (overlap window). */
        const INCREMENTAL_MIN_DAYS = 3;

        mem
          .command("distill-window")
          .description("Print the session distillation window (full or incremental). Use at start of a distillation job to decide what to process; end the job with record-distill.")
          .option("--json", "Output machine-readable JSON only (mode, startDate, endDate, mtimeDays)")
          .action(async (opts: { json?: boolean }) => {
            const memoryDir = dirname(resolvedSqlitePath);
            const distillLastRunPath = join(memoryDir, ".distill_last_run");
            const now = new Date();
            const today = now.toISOString().slice(0, 10);

            let mode: "full" | "incremental";
            let startDate: string;
            let endDate: string = today;
            let mtimeDays: number;

            if (!existsSync(distillLastRunPath)) {
              mode = "full";
              const start = new Date(now);
              start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
              startDate = start.toISOString().slice(0, 10);
              mtimeDays = FULL_DISTILL_MAX_DAYS;
            } else {
              try {
                const line = readFileSync(distillLastRunPath, "utf-8").split("\n")[0]?.trim() || "";
                if (!line) {
                  mode = "full";
                  const start = new Date(now);
                  start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
                  startDate = start.toISOString().slice(0, 10);
                  mtimeDays = FULL_DISTILL_MAX_DAYS;
                } else {
                  const lastRun = new Date(line);
                  if (Number.isNaN(lastRun.getTime())) {
                    mode = "full";
                    const start = new Date(now);
                    start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
                    startDate = start.toISOString().slice(0, 10);
                    mtimeDays = FULL_DISTILL_MAX_DAYS;
                  } else {
                    mode = "incremental";
                    const lastRunDate = lastRun.toISOString().slice(0, 10);
                    const threeDaysAgo = new Date(now);
                    threeDaysAgo.setDate(threeDaysAgo.getDate() - INCREMENTAL_MIN_DAYS);
                    const threeDaysAgoStr = threeDaysAgo.toISOString().slice(0, 10);
                    startDate = lastRunDate < threeDaysAgoStr ? lastRunDate : threeDaysAgoStr;
                    const start = new Date(startDate);
                    mtimeDays = Math.ceil((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
                    if (mtimeDays < 1) mtimeDays = 1;
                  }
                }
              } catch {
                mode = "full";
                const start = new Date(now);
                start.setDate(start.getDate() - FULL_DISTILL_MAX_DAYS);
                startDate = start.toISOString().slice(0, 10);
                mtimeDays = FULL_DISTILL_MAX_DAYS;
              }
            }

            if (opts.json) {
              console.log(JSON.stringify({ mode, startDate, endDate, mtimeDays }));
              return;
            }
            console.log(`Distill window: ${mode}`);
            console.log(`  startDate: ${startDate}`);
            console.log(`  endDate: ${endDate}`);
            console.log(`  mtimeDays: ${mtimeDays} (use find ... -mtime -${mtimeDays} for session files)`);
            console.log("Process sessions from that window; then run: openclaw hybrid-mem record-distill");
          });

        mem
          .command("record-distill")
          .description("Record that session distillation was run (writes timestamp to .distill_last_run for 'verify' to show)")
          .action(async () => {
            const memoryDir = dirname(resolvedSqlitePath);
            mkdirSync(memoryDir, { recursive: true });
            const path = join(memoryDir, ".distill_last_run");
            const ts = new Date().toISOString();
            writeFileSync(path, ts + "\n", "utf-8");
            console.log(`Recorded distillation run: ${ts}`);
            console.log(`Written to ${path}. Run 'openclaw hybrid-mem verify' to see it.`);
          });

        mem
          .command("uninstall")
          .description("Revert to OpenClaw default memory (memory-core). Safe: OpenClaw works normally; your data is kept unless you use --clean-all.")
          .option("--clean-all", "Remove SQLite and LanceDB data (irreversible)")
          .option("--force-cleanup", "Same as --clean-all")
          .option("--leave-config", "Do not modify openclaw.json; only print instructions")
          .action(async (opts: { cleanAll?: boolean; forceCleanup?: boolean; leaveConfig?: boolean }) => {
            const doClean = !!opts.cleanAll || !!opts.forceCleanup;
            const openclawDir = process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
            const configPath = join(openclawDir, "openclaw.json");

            if (!opts.leaveConfig && existsSync(configPath)) {
              try {
                const raw = readFileSync(configPath, "utf-8");
                const config = JSON.parse(raw) as Record<string, unknown>;
                if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
                const plugins = config.plugins as Record<string, unknown>;
                if (!plugins.slots || typeof plugins.slots !== "object") plugins.slots = {};
                (plugins.slots as Record<string, string>).memory = "memory-core";
                if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
                const entries = plugins.entries as Record<string, unknown>;
                if (!entries[PLUGIN_ID] || typeof entries[PLUGIN_ID] !== "object") {
                  entries[PLUGIN_ID] = {};
                }
                (entries[PLUGIN_ID] as Record<string, boolean>).enabled = false;
                writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
                console.log(`Config updated: plugins.slots.memory = "memory-core", ${PLUGIN_ID} disabled.`);
                console.log("OpenClaw will use the default memory manager. Restart the gateway. Your hybrid data is kept unless you run with --clean-all.");
              } catch (e) {
                console.error(`Could not update config (${configPath}): ${e}`);
                console.log("Apply these changes manually:");
                console.log("  1. Set plugins.slots.memory to \"memory-core\"");
                console.log(`  2. Set plugins.entries["${PLUGIN_ID}"].enabled to false`);
                console.log("  3. Restart the gateway.");
              }
            } else if (!opts.leaveConfig) {
              console.log(`Config file not found at ${configPath}. Apply these changes manually:`);
              console.log("  1. Open your OpenClaw config (e.g. ~/.openclaw/openclaw.json).");
              console.log("  2. Set plugins.slots.memory to \"memory-core\".");
              console.log(`  3. Set plugins.entries["${PLUGIN_ID}"].enabled to false.`);
              console.log("  4. Restart the gateway.");
            } else {
              console.log("To use the default OpenClaw memory manager instead of hybrid:");
              console.log("  1. Open your OpenClaw config (e.g. ~/.openclaw/openclaw.json).");
              console.log("  2. Set plugins.slots.memory to \"memory-core\".");
              console.log(`  3. Set plugins.entries["${PLUGIN_ID}"].enabled to false.`);
              console.log("  4. Restart the gateway.");
            }

            if (!doClean) {
              console.log("\nMemory data (SQLite and LanceDB) was left in place. To remove it: openclaw hybrid-mem uninstall --clean-all");
              return;
            }
            console.log("\nRemoving hybrid-memory data...");
            const toRemove: string[] = [];
            if (existsSync(resolvedSqlitePath)) {
              try {
                rmSync(resolvedSqlitePath, { force: true });
                toRemove.push(resolvedSqlitePath);
              } catch (e) {
                console.error(`Failed to remove SQLite file: ${e}`);
              }
            }
            if (existsSync(resolvedLancePath)) {
              try {
                rmSync(resolvedLancePath, { recursive: true, force: true });
                toRemove.push(resolvedLancePath);
              } catch (e) {
                console.error(`Failed to remove LanceDB dir: ${e}`);
              }
            }
            if (toRemove.length > 0) {
              console.log("Removed: " + toRemove.join(", "));
            } else {
              console.log("No hybrid data files found at configured paths.");
            }
          });
      },
      { commands: ["hybrid-mem", "hybrid-mem install", "hybrid-mem stats", "hybrid-mem prune", "hybrid-mem checkpoint", "hybrid-mem backfill-decay", "hybrid-mem extract-daily", "hybrid-mem search", "hybrid-mem lookup", "hybrid-mem store", "hybrid-mem classify", "hybrid-mem categories", "hybrid-mem find-duplicates", "hybrid-mem consolidate", "hybrid-mem reflect", "hybrid-mem verify", "hybrid-mem credentials migrate-to-vault", "hybrid-mem distill-window", "hybrid-mem record-distill", "hybrid-mem uninstall"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (cfg.autoRecall.enabled) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) return;

        try {
          // FR-009: Use wider candidate pool for progressive disclosure
          const isProgressive = cfg.autoRecall.injectionFormat === "progressive";
          const searchLimit = isProgressive ? Math.max(cfg.autoRecall.limit, 15) : cfg.autoRecall.limit;
          const { minScore } = cfg.autoRecall;
          const limit = searchLimit;
          const ftsResults = factsDb.search(event.prompt, limit);
          let lanceResults: SearchResult[] = [];
          try {
            const vector = await embeddings.embed(event.prompt);
            lanceResults = await vectorDb.search(vector, limit, minScore);
          } catch (err) {
            api.logger.warn(
              `memory-hybrid: vector recall failed: ${err}`,
            );
          }

          let candidates = mergeResults(ftsResults, lanceResults, limit, factsDb);

          const { entityLookup } = cfg.autoRecall;
          if (entityLookup.enabled && entityLookup.entities.length > 0) {
            const promptLower = event.prompt.toLowerCase();
            const seenIds = new Set(candidates.map((c) => c.entry.id));
            for (const entity of entityLookup.entities) {
              if (!promptLower.includes(entity.toLowerCase())) continue;
              const entityResults = factsDb.lookup(entity).slice(0, entityLookup.maxFactsPerEntity);
              for (const r of entityResults) {
                if (!seenIds.has(r.entry.id)) {
                  seenIds.add(r.entry.id);
                  candidates.push(r);
                }
              }
            }
            candidates.sort((a, b) => {
              const s = b.score - a.score;
              if (s !== 0) return s;
              const da = a.entry.sourceDate ?? a.entry.createdAt;
              const db = b.entry.sourceDate ?? b.entry.createdAt;
              return db - da;
            });
            candidates = candidates.slice(0, limit);
          }

          if (candidates.length === 0) return;

          {
            const nowSec = Math.floor(Date.now() / 1000);
            const NINETY_DAYS_SEC = 90 * 24 * 3600;
            const boosted = candidates.map((r) => {
              let s = r.score;
              if (cfg.autoRecall.preferLongTerm) {
                s *=
                  r.entry.decayClass === "permanent"
                    ? 1.2
                    : r.entry.decayClass === "stable"
                      ? 1.1
                      : 1;
              }
              if (cfg.autoRecall.useImportanceRecency) {
                const importanceFactor = 0.7 + 0.3 * r.entry.importance;
                const recencyFactor =
                  r.entry.lastConfirmedAt === 0
                    ? 1
                    : 0.8 +
                      0.2 *
                        Math.max(
                          0,
                          1 - (nowSec - r.entry.lastConfirmedAt) / NINETY_DAYS_SEC,
                        );
                s *= importanceFactor * recencyFactor;
              }
              // FR-005: Access-count salience boost — frequently recalled facts score higher
              const recallCount = r.entry.recallCount ?? 0;
              if (recallCount > 0) {
                s *= 1 + 0.1 * Math.log(recallCount + 1);
              }
              return { ...r, score: s };
            });
            boosted.sort((a, b) => b.score - a.score);
            candidates = boosted;
          }

          const {
            maxTokens,
            maxPerMemoryChars,
            injectionFormat,
            useSummaryInInjection,
            summarizeWhenOverBudget,
            summarizeModel,
          } = cfg.autoRecall;

          // FR-009: Progressive disclosure — inject a lightweight index, let the agent decide what to fetch
          if (injectionFormat === "progressive") {
            const totalTokens = candidates.reduce((sum, r) => {
              const t = r.entry.summary || r.entry.text;
              return sum + estimateTokens(t);
            }, 0);
            const indexHeader = `<relevant-memories format="index">\nAvailable memories (${candidates.length} matches, ~${totalTokens} tokens total):\n`;
            const indexFooter = `\n→ Use memory_recall("query") or memory_recall with an entity/key to fetch full details.\n</relevant-memories>`;
            let indexTokens = estimateTokens(indexHeader + indexFooter);
            const indexLines: string[] = [];

            for (let i = 0; i < candidates.length; i++) {
              const r = candidates[i];
              const title = r.entry.key
                ? `${r.entry.entity ? r.entry.entity + ": " : ""}${r.entry.key}`
                : (r.entry.summary || r.entry.text.slice(0, 60).trim() + (r.entry.text.length > 60 ? "…" : ""));
              const tokenCost = estimateTokens(r.entry.summary || r.entry.text);
              const line = `  ${i + 1}. [${r.entry.category}] ${title} (${tokenCost} tok)`;
              const lineTokens = estimateTokens(line + "\n");
              if (indexTokens + lineTokens > maxTokens) break;
              indexLines.push(line);
              indexTokens += lineTokens;
            }

            if (indexLines.length === 0) return;

            const indexContent = indexLines.join("\n");
            api.logger.info?.(
              `memory-hybrid: progressive disclosure — injecting index of ${indexLines.length} memories (~${indexTokens} tokens)`,
            );
            return {
              prependContext: `${indexHeader}${indexContent}${indexFooter}`,
            };
          }

          const header = "<relevant-memories>\nThe following memories may be relevant:\n";
          const footer = "\n</relevant-memories>";
          let usedTokens = estimateTokens(header + footer);

          const lines: string[] = [];
          for (const r of candidates) {
            let text =
              useSummaryInInjection && r.entry.summary ? r.entry.summary : r.entry.text;
            if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars) {
              text = text.slice(0, maxPerMemoryChars).trim() + "…";
            }
            const line =
              injectionFormat === "minimal"
                ? `- ${text}`
                : injectionFormat === "short"
                  ? `- ${r.entry.category}: ${text}`
                  : `- [${r.backend}/${r.entry.category}] ${text}`;
            const lineTokens = estimateTokens(line + "\n");
            if (usedTokens + lineTokens > maxTokens) break;
            lines.push(line);
            usedTokens += lineTokens;
          }

          if (lines.length === 0) return;

          let memoryContext = lines.join("\n");

          if (summarizeWhenOverBudget && lines.length < candidates.length) {
            const fullBullets = candidates
              .map((r) => {
                let text =
                  useSummaryInInjection && r.entry.summary ? r.entry.summary : r.entry.text;
                if (maxPerMemoryChars > 0 && text.length > maxPerMemoryChars) {
                  text = text.slice(0, maxPerMemoryChars).trim() + "…";
                }
                return injectionFormat === "minimal"
                  ? `- ${text}`
                  : injectionFormat === "short"
                    ? `- ${r.entry.category}: ${text}`
                    : `- [${r.backend}/${r.entry.category}] ${text}`;
              })
              .join("\n");
            try {
              const resp = await openaiClient.chat.completions.create({
                model: summarizeModel,
                messages: [
                  {
                    role: "user",
                    content: `Summarize these memories into 2-3 short sentences. Preserve key facts.\n\n${fullBullets.slice(0, 4000)}`,
                  },
                ],
                temperature: 0,
                max_tokens: 200,
              });
              const summary = (resp.choices[0]?.message?.content ?? "").trim();
              if (summary) {
                memoryContext = summary;
                usedTokens = estimateTokens(header + memoryContext + footer);
                api.logger.info?.(
                  `memory-hybrid: over budget — injected LLM summary (~${usedTokens} tokens)`,
                );
              }
            } catch (err) {
              api.logger.warn(`memory-hybrid: summarize-when-over-budget failed: ${err}`);
            }
          }

          if (!memoryContext) return;

          if (!summarizeWhenOverBudget || lines.length >= candidates.length) {
            api.logger.info?.(
              `memory-hybrid: injecting ${lines.length} memories (sqlite: ${ftsResults.length}, lance: ${lanceResults.length}, ~${usedTokens} tokens)`,
            );
          }

          return {
            prependContext: `${header}${memoryContext}${footer}`,
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
            let textToStore = text;
            if (textToStore.length > cfg.captureMaxChars) {
              textToStore = textToStore.slice(0, cfg.captureMaxChars).trim() + " [truncated]";
            }

            // Heuristic classification only — "other" facts are reclassified
            // by the daily auto-classify timer (no LLM calls on the hot path)
            const category: MemoryCategory = detectCategory(textToStore);
            const extracted = extractStructuredFields(textToStore, category);

            if (factsDb.hasDuplicate(textToStore)) continue;

            const summaryThreshold = cfg.autoRecall.summaryThreshold;
            const summary =
              summaryThreshold > 0 && textToStore.length > summaryThreshold
                ? textToStore.slice(0, cfg.autoRecall.summaryMaxChars).trim() + "…"
                : undefined;

            // FR-008: Classify before auto-capture to avoid stale duplicates
            if (cfg.store.classifyBeforeWrite) {
              const similarFacts = factsDb.findSimilarForClassification(
                textToStore, extracted.entity, extracted.key, 3,
              );
              if (similarFacts.length > 0) {
                try {
                  const classification = await classifyMemoryOperation(
                    textToStore, extracted.entity, extracted.key, similarFacts,
                    openaiClient, cfg.store.classifyModel, api.logger,
                  );
                  if (classification.action === "NOOP") continue;
                  if (classification.action === "DELETE" && classification.targetId) {
                    factsDb.supersede(classification.targetId, null);
                    api.logger.info?.(`memory-hybrid: auto-capture DELETE — retracted ${classification.targetId}`);
                    continue;
                  }
                  if (classification.action === "UPDATE" && classification.targetId) {
                    const oldFact = factsDb.getById(classification.targetId);
                    if (oldFact) {
                      const finalImportance = Math.max(0.7, oldFact.importance);
                      
                      // Generate vector first
                      let vector: number[] | undefined;
                      try {
                        vector = await embeddings.embed(textToStore);
                      } catch (err) {
                        api.logger.warn(`memory-hybrid: auto-capture embedding failed: ${err}`);
                      }

                      // WAL: Write pending UPDATE operation
                      const walEntryId = randomUUID();
                      if (wal) {
                        try {
                          wal.write({
                            id: walEntryId,
                            timestamp: Date.now(),
                            operation: "update",
                            data: {
                              text: textToStore,
                              category,
                              importance: finalImportance,
                              entity: extracted.entity || oldFact.entity,
                              key: extracted.key || oldFact.key,
                              value: extracted.value || oldFact.value,
                              source: "auto-capture",
                              decayClass: oldFact.decayClass,
                              summary,
                              tags: extractTags(textToStore, extracted.entity),
                              vector,
                            },
                          });
                        } catch (err) {
                          api.logger.warn(`memory-hybrid: auto-capture WAL write failed: ${err}`);
                        }
                      }

                      const newEntry = factsDb.store({
                        text: textToStore,
                        category,
                        importance: finalImportance,
                        entity: extracted.entity || oldFact.entity,
                        key: extracted.key || oldFact.key,
                        value: extracted.value || oldFact.value,
                        source: "auto-capture",
                        decayClass: oldFact.decayClass,
                        summary,
                      });
                      factsDb.supersede(classification.targetId, newEntry.id);
                      try {
                        if (vector && !(await vectorDb.hasDuplicate(vector))) {
                          await vectorDb.store({ text: textToStore, vector, importance: finalImportance, category });
                        }
                      } catch (err) {
                        api.logger.warn(`memory-hybrid: vector capture failed: ${err}`);
                      }

                      // WAL: Remove entry after successful commit
                      if (wal) {
                        try {
                          wal.remove(walEntryId);
                        } catch (err) {
                          api.logger.warn(`memory-hybrid: auto-capture WAL cleanup failed: ${err}`);
                        }
                      }

                      api.logger.info?.(
                        `memory-hybrid: auto-capture UPDATE — superseded ${classification.targetId} with ${newEntry.id}`,
                      );
                      stored++;
                      continue;
                    }
                  }
                  // ADD: fall through to normal store
                } catch (err) {
                  api.logger.warn(`memory-hybrid: auto-capture classification failed: ${err}`);
                  // fall through to normal store on error
                }
              }
            }

            // Generate vector first (needed for WAL)
            let vector: number[] | undefined;
            try {
              vector = await embeddings.embed(textToStore);
            } catch (err) {
              api.logger.warn(`memory-hybrid: auto-capture embedding failed: ${err}`);
            }

            // WAL: Write pending operation before committing to storage
            const walEntryId = randomUUID();
            if (wal) {
              try {
                wal.write({
                  id: walEntryId,
                  timestamp: Date.now(),
                  operation: "store",
                  data: {
                    text: textToStore,
                    category,
                    importance: 0.7,
                    entity: extracted.entity,
                    key: extracted.key,
                    value: extracted.value,
                    source: "auto-capture",
                    summary,
                    tags: extractTags(textToStore, extracted.entity),
                    vector,
                  },
                });
              } catch (err) {
                api.logger.warn(`memory-hybrid: auto-capture WAL write failed: ${err}`);
              }
            }

            // Now commit to actual storage
            factsDb.store({
              text: textToStore,
              category,
              importance: 0.7,
              entity: extracted.entity,
              key: extracted.key,
              value: extracted.value,
              source: "auto-capture",
              summary,
            });

            try {
              if (vector && !(await vectorDb.hasDuplicate(vector))) {
                await vectorDb.store({ text: textToStore, vector, importance: 0.7, category });
              }
            } catch (err) {
              api.logger.warn(
                `memory-hybrid: vector capture failed: ${err}`,
              );
            }

            // WAL: Remove entry after successful commit
            if (wal) {
              try {
                wal.remove(walEntryId);
              } catch (err) {
                api.logger.warn(`memory-hybrid: auto-capture WAL cleanup failed: ${err}`);
              }
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

    // Credential auto-detect: when patterns found in conversation, persist hint for next turn
    if (cfg.credentials.enabled && cfg.credentials.autoDetect) {
      const pendingPath = join(dirname(resolvedSqlitePath), "credentials-pending.json");
      const PENDING_TTL_MS = 5 * 60 * 1000; // 5 min

      api.on("agent_end", async (event) => {
        if (!event.messages || event.messages.length === 0) return;
        try {
          const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const content = msgObj.content;
            if (typeof content === "string") texts.push(content);
            else if (Array.isArray(content)) {
              for (const block of content) {
                if (block && typeof block === "object" && "type" in block && (block as Record<string, unknown>).type === "text" && "text" in block) {
                  const t = (block as Record<string, unknown>).text;
                  if (typeof t === "string") texts.push(t);
                }
              }
            }
          }
          const allText = texts.join("\n");
          const detected = detectCredentialPatterns(allText);
          if (detected.length === 0) return;
          mkdirSync(dirname(pendingPath), { recursive: true });
          writeFileSync(
            pendingPath,
            JSON.stringify({
              hints: detected.map((d) => d.hint),
              at: Date.now(),
            }),
            "utf-8",
          );
          api.logger.info(`memory-hybrid: credential patterns detected (${detected.map((d) => d.hint).join(", ")}) — will prompt next turn`);
        } catch (err) {
          api.logger.warn(`memory-hybrid: credential auto-detect failed: ${err}`);
        }
      });

      api.on("before_agent_start", async () => {
        try {
          if (!existsSync(pendingPath)) return;
          const raw = readFileSync(pendingPath, "utf-8");
          const data = JSON.parse(raw) as { hints?: string[]; at?: number };
          const at = typeof data.at === "number" ? data.at : 0;
          if (Date.now() - at > PENDING_TTL_MS) {
            rmSync(pendingPath, { force: true });
            return;
          }
          const hints = Array.isArray(data.hints) ? data.hints : [];
          if (hints.length === 0) {
            rmSync(pendingPath, { force: true });
            return;
          }
          rmSync(pendingPath, { force: true });
          const hintText = hints.join(", ");
          return {
            prependContext: `\n<credential-hint>\nA credential may have been shared in the previous exchange (${hintText}). Consider asking the user if they want to store it securely with credential_store.\n</credential-hint>\n`,
          };
        } catch {
          try { rmSync(pendingPath, { force: true }); } catch { /* ignore */ }
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: PLUGIN_ID,
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
          const discoveredPath = join(dirname(resolvedSqlitePath), ".discovered-categories.json");

          // Run once shortly after startup (5 min delay to let things settle)
          classifyStartupTimeout = setTimeout(async () => {
            try {
              await runAutoClassify(factsDb, openaiClient, cfg.autoClassify, api.logger, {
                discoveredCategoriesPath: discoveredPath,
              });
            } catch (err) {
              api.logger.warn(`memory-hybrid: startup auto-classify failed: ${err}`);
            }
          }, 5 * 60_000);

          classifyTimer = setInterval(async () => {
            try {
              await runAutoClassify(factsDb, openaiClient, cfg.autoClassify, api.logger, {
                discoveredCategoriesPath: discoveredPath,
              });
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
        if (credentialsDb) { credentialsDb.close(); credentialsDb = null; }
        api.logger.info("memory-hybrid: stopped");
      },
    });
  },
};

export { versionInfo } from "./versionInfo.js";
export default memoryHybridPlugin;