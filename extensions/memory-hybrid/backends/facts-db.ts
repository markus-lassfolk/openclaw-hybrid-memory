/**
 * SQLite + FTS5 backend for structured facts.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { MemoryCategory, DecayClass } from "../config.js";
import { TTL_DEFAULTS } from "../config.js";
import type { MemoryEntry, SearchResult } from "../types/memory.js";
import { normalizedHash, serializeTags, parseTags } from "../utils/tags.js";
import { calculateExpiry, classifyDecay } from "../utils/decay.js";

export const MEMORY_LINK_TYPES = ["SUPERSEDES", "CAUSED_BY", "PART_OF", "RELATED_TO", "DEPENDS_ON"] as const;
export type MemoryLinkType = (typeof MEMORY_LINK_TYPES)[number];

export class FactsDB {
  private db: Database.Database;
  private readonly dbPath: string;
  private readonly fuzzyDedupe: boolean;
  private supersededTextsCache: Set<string> | null = null;
  private supersededTextsCacheTime = 0;
  /** Cache TTL for superseded texts to avoid full table scan on every search. Increased to reduce thrashing. */
  private readonly SUPERSEDED_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

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

    // ---- FR-010: Bi-temporal valid_from / valid_until / supersedes_id ----
    this.migrateBiTemporalColumns();

    // ---- FR-007: Graph-based spreading activation ----
    this.migrateMemoryLinksTable();
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

  /** FR-010: Bi-temporal columns valid_from, valid_until, supersedes_id for point-in-time queries. */
  private migrateBiTemporalColumns(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("valid_from")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN valid_from INTEGER`);
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN valid_until INTEGER`);
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN supersedes_id TEXT`);
    this.liveDb.exec(
      `UPDATE facts SET valid_from = COALESCE(source_date, created_at), valid_until = NULL, supersedes_id = NULL WHERE valid_from IS NULL`,
    );
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_facts_valid_range ON facts(valid_from, valid_until)`,
    );
  }

  /** FR-007: Create memory_links table for graph-based spreading activation. */
  private migrateMemoryLinksTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS memory_links (
        id TEXT PRIMARY KEY,
        source_fact_id TEXT NOT NULL,
        target_fact_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source_fact_id) REFERENCES facts(id) ON DELETE CASCADE,
        FOREIGN KEY (target_fact_id) REFERENCES facts(id) ON DELETE CASCADE
      )
    `);
    this.liveDb.exec(`CREATE INDEX IF NOT EXISTS idx_links_source ON memory_links(source_fact_id)`);
    this.liveDb.exec(`CREATE INDEX IF NOT EXISTS idx_links_target ON memory_links(target_fact_id)`);
    this.liveDb.exec(`CREATE INDEX IF NOT EXISTS idx_links_type ON memory_links(link_type)`);
    this.liveDb.exec(`CREATE INDEX IF NOT EXISTS idx_links_source_type ON memory_links(source_fact_id, link_type)`);
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
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("wal_autocheckpoint = 1000");
    this.db.pragma("foreign_keys = ON"); // Required for memory_links ON DELETE CASCADE
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
      /** FR-010: When this fact became true (epoch sec). Defaults to sourceDate ?? now. */
      validFrom?: number | null;
      /** FR-010: When this fact stopped being true (epoch sec). Usually null for new facts. */
      validUntil?: number | null;
      /** FR-010: Id of the fact this one supersedes. */
      supersedesId?: string | null;
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
    const validFrom = entry.validFrom ?? sourceDate ?? nowSec;
    const validUntil = entry.validUntil ?? null;
    const supersedesId = entry.supersedesId ?? null;

    this.liveDb
      .prepare(
        `INSERT INTO facts (id, text, category, importance, entity, key, value, source, created_at, decay_class, expires_at, last_confirmed_at, confidence, summary, normalized_hash, source_date, tags, valid_from, valid_until, supersedes_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        validFrom,
        validUntil,
        supersedesId,
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
      validFrom,
      validUntil: validUntil ?? undefined,
      supersedesId: supersedesId ?? undefined,
    };
  }

  /** FR-005: Update recall_count and last_accessed for facts (public for progressive disclosure). Bulk UPDATE to avoid N+1. */
  refreshAccessedFacts(ids: string[]): void {
    if (ids.length === 0) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const BATCH_SIZE = 500; // SQLite variable limit

    const tx = this.liveDb.transaction(() => {
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => "?").join(",");

        // Extend TTL for stable/active facts that were just accessed
        this.liveDb
          .prepare(
            `UPDATE facts SET last_confirmed_at = ?, expires_at = CASE decay_class WHEN 'stable' THEN ? + ? WHEN 'active' THEN ? + ? ELSE expires_at END WHERE id IN (${placeholders}) AND decay_class IN ('stable', 'active')`,
          )
          .run(nowSec, nowSec, TTL_DEFAULTS.stable, nowSec, TTL_DEFAULTS.active, ...batch);

        // Bump recall_count and last_accessed for all
        this.liveDb
          .prepare(
            `UPDATE facts SET recall_count = recall_count + 1, last_accessed = ? WHERE id IN (${placeholders})`,
          )
          .run(nowSec, ...batch);
      }
    });
    tx();
  }

  search(
    query: string,
    limit = 5,
    options: {
      includeExpired?: boolean;
      tag?: string;
      includeSuperseded?: boolean;
      /** FR-010: Point-in-time: only facts valid at this epoch second. */
      asOf?: number;
    } = {},
  ): SearchResult[] {
    const { includeExpired = false, tag, includeSuperseded = false, asOf } = options;

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
    const temporalFilter =
      asOf != null
        ? "AND f.valid_from <= @asOf AND (f.valid_until IS NULL OR f.valid_until > @asOf)"
        : includeSuperseded
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
           ${temporalFilter}
           ${tagFilter}
         ORDER BY rank
         LIMIT @limit`,
      )
      .all({
        query: safeQuery,
        now: nowSec,
        ...(asOf != null ? { asOf } : {}),
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
          validFrom: (row.valid_from as number) ?? undefined,
          validUntil: (row.valid_until as number) ?? undefined,
          supersedesId: (row.supersedes_id as string) ?? undefined,
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

  lookup(
    entity: string,
    key?: string,
    tag?: string,
    options?: { includeSuperseded?: boolean; asOf?: number },
  ): SearchResult[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const { includeSuperseded = false, asOf } = options ?? {};
    const temporalFilter =
      asOf != null
        ? " AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)"
        : includeSuperseded
          ? ""
          : " AND superseded_at IS NULL";
    const tagFilter =
      tag && tag.trim()
        ? " AND (',' || COALESCE(tags,'') || ',') LIKE ?"
        : "";
    const tagParam = tag && tag.trim() ? `%,${tag.toLowerCase().trim()},%` : null;

    const base = key
      ? `SELECT * FROM facts WHERE lower(entity) = lower(?) AND lower(key) = lower(?) AND (expires_at IS NULL OR expires_at > ?)${temporalFilter}${tagFilter} ORDER BY confidence DESC, COALESCE(source_date, created_at) DESC`
      : `SELECT * FROM facts WHERE lower(entity) = lower(?) AND (expires_at IS NULL OR expires_at > ?)${temporalFilter}${tagFilter} ORDER BY confidence DESC, COALESCE(source_date, created_at) DESC`;

    const params = key
      ? tagParam !== null
        ? asOf != null
          ? [entity, key, nowSec, asOf, asOf, tagParam]
          : [entity, key, nowSec, tagParam]
        : asOf != null
          ? [entity, key, nowSec, asOf, asOf]
          : [entity, key, nowSec]
      : tagParam !== null
        ? asOf != null
          ? [entity, nowSec, asOf, asOf, tagParam]
          : [entity, nowSec, tagParam]
        : asOf != null
          ? [entity, nowSec, asOf, asOf]
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
        validFrom: (row.valid_from as number) ?? undefined,
        validUntil: (row.valid_until as number) ?? undefined,
        supersedesId: (row.supersedes_id as string) ?? undefined,
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

  /** FR-008/010: Mark a fact as superseded by a new fact. Sets superseded_at, superseded_by, and valid_until (bi-temporal). */
  supersede(oldId: string, newId: string | null): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = this.liveDb
      .prepare(
        `UPDATE facts SET superseded_at = ?, superseded_by = ?, valid_until = ? WHERE id = ? AND superseded_at IS NULL`,
      )
      .run(nowSec, newId, nowSec, oldId);
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
      validFrom: (row.valid_from as number) ?? undefined,
      validUntil: (row.valid_until as number) ?? undefined,
      supersedesId: (row.supersedes_id as string) ?? undefined,
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

  /** FR-007: Create a typed link between two facts. Returns link id. */
  createLink(
    sourceFactId: string,
    targetFactId: string,
    linkType: MemoryLinkType,
    strength = 1.0,
  ): string {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.liveDb
      .prepare(
        `INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sourceFactId, targetFactId, linkType, Math.max(0, Math.min(1, strength)), now);
    return id;
  }

  /** FR-007: Get links from a fact (outgoing). */
  getLinksFrom(factId: string): Array<{ id: string; targetFactId: string; linkType: string; strength: number }> {
    const rows = this.liveDb
      .prepare(
        `SELECT id, target_fact_id, link_type, strength FROM memory_links WHERE source_fact_id = ?`,
      )
      .all(factId) as Array<{ id: string; target_fact_id: string; link_type: string; strength: number }>;
    return rows.map((r) => ({
      id: r.id,
      targetFactId: r.target_fact_id,
      linkType: r.link_type,
      strength: r.strength,
    }));
  }

  /** FR-007: Get links to a fact (incoming). */
  getLinksTo(factId: string): Array<{ id: string; sourceFactId: string; linkType: string; strength: number }> {
    const rows = this.liveDb
      .prepare(
        `SELECT id, source_fact_id, link_type, strength FROM memory_links WHERE target_fact_id = ?`,
      )
      .all(factId) as Array<{ id: string; source_fact_id: string; link_type: string; strength: number }>;
    return rows.map((r) => ({
      id: r.id,
      sourceFactId: r.source_fact_id,
      linkType: r.link_type,
      strength: r.strength,
    }));
  }

  /** FR-007: BFS from given fact IDs up to maxDepth hops. Returns all connected fact IDs (including the seed set). */
  getConnectedFactIds(factIds: string[], maxDepth: number): string[] {
    if (factIds.length === 0 || maxDepth < 1) return [...factIds];
    const seen = new Set<string>(factIds);
    let frontier = [...factIds];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        const out = this.liveDb
          .prepare(`SELECT target_fact_id FROM memory_links WHERE source_fact_id = ?`)
          .all(id) as Array<{ target_fact_id: string }>;
        const in_ = this.liveDb
          .prepare(`SELECT source_fact_id FROM memory_links WHERE target_fact_id = ?`)
          .all(id) as Array<{ source_fact_id: string }>;
        for (const r of out) {
          if (!seen.has(r.target_fact_id)) {
            seen.add(r.target_fact_id);
            next.push(r.target_fact_id);
          }
        }
        for (const r of in_) {
          if (!seen.has(r.source_fact_id)) {
            seen.add(r.source_fact_id);
            next.push(r.source_fact_id);
          }
        }
      }
      frontier = next;
    }
    return [...seen];
  }

  /** Get all non-expired facts (for reflection). Optional FR-010 point-in-time / include superseded. */
  getAll(options?: { includeSuperseded?: boolean; asOf?: number }): MemoryEntry[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const { includeSuperseded = false, asOf } = options ?? {};
    const temporalFilter =
      asOf != null
        ? " AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)"
        : includeSuperseded
          ? ""
          : " AND superseded_at IS NULL";
    const params = asOf != null ? [nowSec, asOf, asOf] : [nowSec];
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM facts WHERE (expires_at IS NULL OR expires_at > ?)${temporalFilter} ORDER BY created_at DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
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
      validFrom: (row.valid_from as number) || null,
      validUntil: (row.valid_until as number) || null,
      supersedesId: (row.supersedes_id as string) || null,
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
