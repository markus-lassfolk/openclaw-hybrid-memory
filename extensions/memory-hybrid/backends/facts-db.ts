/**
 * SQLite + FTS5 backend for structured facts.
 */

import Database from "better-sqlite3";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { MemoryCategory, DecayClass } from "../config.js";
import { TTL_DEFAULTS } from "../config.js";
import type { MemoryEntry, ProcedureEntry, SearchResult, MemoryTier, ScopeFilter } from "../types/memory.js";
import { normalizedHash, serializeTags, parseTags } from "../utils/tags.js";
import { calculateExpiry, classifyDecay } from "../utils/decay.js";
import { computeDynamicSalience } from "../utils/salience.js";
import { estimateTokensForDisplay } from "../utils/text.js";
import { capturePluginError } from "../services/error-reporter.js";
import { getLanguageKeywordsFilePath } from "../utils/language-keywords.js";

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

  /**
   * Sanitize query for FTS5 MATCH operator: strip FTS5 special characters and operators.
   * Removes: NOT, AND, OR (uppercase), *, (, ), and quotes (already stripped).
   */
  private sanitizeFTS5Query(query: string): string {
    return query
      .replace(/['"*()]/g, "")
      .replace(/\b(NOT|AND|OR)\b/g, "")
      .trim();
  }

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

    // ---- Source date for provenance ----
    this.migrateSourceDateColumn();

    // ---- Tags for topic filtering ----
    this.migrateTagsColumn();

    // ---- Access tracking for dynamic salience ----
    this.migrateAccessTracking();

    // ---- Supersession columns for contradiction resolution ----
    this.migrateSupersessionColumns();

    // ---- Bi-temporal valid_from / valid_until / supersedes_id ----
    this.migrateBiTemporalColumns();

    // ---- Graph-based spreading activation ----
    this.migrateMemoryLinksTable();

    // ---- Dynamic memory tiering (hot/warm/cold) ----
    this.migrateTierColumn();

    // ---- Memory scoping (global, user, agent, session) ----
    this.migrateScopeColumns();

    // ---- Procedural memory: procedure columns on facts + procedures table ----
    this.migrateProcedureColumns();
    this.migrateProceduresTable();

    // ---- Reinforcement-as-Metadata ----
    this.migrateReinforcementColumns();

    // ---- Phase 2: Reinforcement for procedures ----
    this.migrateReinforcementColumnsProcedures();

    // ---- Memory scoping for procedures ----
    this.migrateProcedureScopeColumns();
  }

  /** Add reinforcement tracking columns (reinforced_count, last_reinforced_at, reinforced_quotes). */
  private migrateReinforcementColumns(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("reinforced_count")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN reinforced_count INTEGER NOT NULL DEFAULT 0`);
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN last_reinforced_at INTEGER`);
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN reinforced_quotes TEXT`); // JSON array of strings
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_facts_reinforced ON facts(reinforced_count) WHERE reinforced_count > 0`,
    );
  }

  /** Add tier column; default 'warm' for existing rows. */
  private migrateTierColumn(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "tier")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN tier TEXT DEFAULT 'warm'`);
    this.liveDb.exec(`UPDATE facts SET tier = 'warm' WHERE tier IS NULL`);
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_facts_tier ON facts(tier) WHERE tier IS NOT NULL`,
    );
  }

  /** Add scope and scope_target columns for memory scoping. */
  private migrateScopeColumns(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("scope")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`);
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN scope_target TEXT`);
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope)`,
    );
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_facts_scope_target ON facts(scope, scope_target) WHERE scope_target IS NOT NULL`,
    );
  }

  /** Procedural memory: add procedure_type, success_count, last_validated, source_sessions to facts. */
  private migrateProcedureColumns(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(facts)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("procedure_type")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN procedure_type TEXT`);
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN success_count INTEGER DEFAULT 0`);
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN last_validated INTEGER`);
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN source_sessions TEXT`);
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_facts_procedure_type ON facts(procedure_type) WHERE procedure_type IS NOT NULL`,
    );
  }

  /** Procedural memory: create procedures table for full recipe storage. */
  private migrateProceduresTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS procedures (
        id TEXT PRIMARY KEY,
        task_pattern TEXT NOT NULL,
        recipe_json TEXT NOT NULL,
        procedure_type TEXT DEFAULT 'positive',
        success_count INTEGER DEFAULT 1,
        failure_count INTEGER DEFAULT 0,
        last_validated INTEGER,
        last_failed INTEGER,
        confidence REAL DEFAULT 0.5,
        ttl_days INTEGER DEFAULT 30,
        promoted_to_skill INTEGER DEFAULT 0,
        skill_path TEXT,
        created_at INTEGER,
        updated_at INTEGER
      )
    `);
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(procedures)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("source_sessions")) {
      this.liveDb.exec(`ALTER TABLE procedures ADD COLUMN source_sessions TEXT`);
    }
    this.liveDb.exec(`CREATE INDEX IF NOT EXISTS idx_procedures_type ON procedures(procedure_type)`);
    this.liveDb.exec(`CREATE INDEX IF NOT EXISTS idx_procedures_validated ON procedures(last_validated)`);
    this.liveDb.exec(`CREATE INDEX IF NOT EXISTS idx_procedures_confidence ON procedures(confidence)`);
    this.liveDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS procedures_fts USING fts5(
        task_pattern,
        content=procedures,
        content_rowid=rowid,
        tokenize='porter unicode61'
      )
    `);
    this.liveDb.exec(`
      CREATE TRIGGER IF NOT EXISTS procedures_fts_ai AFTER INSERT ON procedures BEGIN
        INSERT INTO procedures_fts(rowid, task_pattern) VALUES (new.rowid, new.task_pattern);
      END;
      CREATE TRIGGER IF NOT EXISTS procedures_fts_ad AFTER DELETE ON procedures BEGIN
        INSERT INTO procedures_fts(procedures_fts, rowid, task_pattern) VALUES ('delete', old.rowid, old.task_pattern);
      END;
      CREATE TRIGGER IF NOT EXISTS procedures_fts_au AFTER UPDATE ON procedures BEGIN
        INSERT INTO procedures_fts(procedures_fts, rowid, task_pattern) VALUES ('delete', old.rowid, old.task_pattern);
        INSERT INTO procedures_fts(rowid, task_pattern) VALUES (new.rowid, new.task_pattern);
      END
    `);
  }

  /** Phase 2: Add reinforcement tracking columns to procedures table (same pattern as facts). */
  private migrateReinforcementColumnsProcedures(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(procedures)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("reinforced_count")) return;
    this.liveDb.exec(`ALTER TABLE procedures ADD COLUMN reinforced_count INTEGER NOT NULL DEFAULT 0`);
    this.liveDb.exec(`ALTER TABLE procedures ADD COLUMN last_reinforced_at INTEGER`);
    this.liveDb.exec(`ALTER TABLE procedures ADD COLUMN reinforced_quotes TEXT`); // JSON array of strings
    this.liveDb.exec(`ALTER TABLE procedures ADD COLUMN promoted_at INTEGER`); // When auto-promoted via reinforcement
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_procedures_reinforced ON procedures(reinforced_count) WHERE reinforced_count > 0`,
    );
  }

  /** Add scope and scope_target columns to procedures table (same pattern as facts). */
  private migrateProcedureScopeColumns(): void {
    const cols = this.liveDb
      .prepare(`PRAGMA table_info(procedures)`)
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    // Check both columns independently, not just scope
    if (!colNames.has("scope")) {
      this.liveDb.exec(`ALTER TABLE procedures ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`);
    }
    if (!colNames.has("scope_target")) {
      this.liveDb.exec(`ALTER TABLE procedures ADD COLUMN scope_target TEXT`);
    }
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_procedures_scope ON procedures(scope)`,
    );
    this.liveDb.exec(
      `CREATE INDEX IF NOT EXISTS idx_procedures_scope_target ON procedures(scope, scope_target) WHERE scope_target IS NOT NULL`,
    );
  }

  /**
   * Build SQL fragment for scope filtering. Uses named params @scopeUserId, @scopeAgentId, @scopeSessionId.
   * ⚠️ SECURITY: Callers MUST derive scope filter values from trusted runtime identity (authenticated user/agent/session).
   * Do NOT pass arbitrary caller-controlled tool/CLI parameters here — that enables cross-tenant data leakage
   * (attacker can pass userId: "alice" to access alice's private memories). Use autoRecall.scopeFilter from config
   * (set by integration layer) rather than user-supplied parameters. See docs/MEMORY-SCOPING.md.
   */
  private scopeFilterClause(filter: ScopeFilter | null | undefined): { clause: string; params: Record<string, unknown> } {
    if (!filter || (!filter.userId && !filter.agentId && !filter.sessionId)) {
      return { clause: "", params: {} };
    }
    const parts: string[] = ["("];
    parts.push("scope = 'global'");
    const params: Record<string, unknown> = {};
    if (filter.userId) {
      parts.push("OR (scope = 'user' AND scope_target = @scopeUserId)");
      params.scopeUserId = filter.userId;
    }
    if (filter.agentId) {
      parts.push("OR (scope = 'agent' AND scope_target = @scopeAgentId)");
      params.scopeAgentId = filter.agentId;
    }
    if (filter.sessionId) {
      parts.push("OR (scope = 'session' AND scope_target = @scopeSessionId)");
      params.scopeSessionId = filter.sessionId;
    }
    parts.push(")");
    return { clause: "AND " + parts.join(" "), params };
  }

  /**
   * Build SQL fragment for scope filtering with positional params (for lookup/getAll).
   * Same security constraints as scopeFilterClause — derive from trusted identity only.
   */
  private scopeFilterClausePositional(filter: ScopeFilter | null | undefined): { clause: string; params: unknown[] } {
    if (!filter || (!filter.userId && !filter.agentId && !filter.sessionId)) {
      return { clause: "", params: [] };
    }
    const parts: string[] = ["("];
    parts.push("scope = 'global'");
    const params: unknown[] = [];
    if (filter.userId) {
      parts.push("OR (scope = 'user' AND scope_target = ?)");
      params.push(filter.userId);
    }
    if (filter.agentId) {
      parts.push("OR (scope = 'agent' AND scope_target = ?)");
      params.push(filter.agentId);
    }
    if (filter.sessionId) {
      parts.push("OR (scope = 'session' AND scope_target = ?)");
      params.push(filter.sessionId);
    }
    parts.push(")");
    return { clause: " AND " + parts.join(" "), params };
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

  /** Add recall_count and last_accessed for dynamic salience scoring. */
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

  /** Add superseded_at and superseded_by for contradiction resolution. */
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

  /** Bi-temporal columns valid_from, valid_until, supersedes_id for point-in-time queries. */
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

  /** Create memory_links table for graph-based spreading activation. */
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
      /** When this fact became true (epoch sec). Defaults to sourceDate ?? now. */
      validFrom?: number | null;
      /** When this fact stopped being true (epoch sec). Usually null for new facts. */
      validUntil?: number | null;
      /** Id of the fact this one supersedes. */
      supersedesId?: string | null;
      /** Procedural memory: fact as procedure summary. */
      procedureType?: "positive" | "negative" | null;
      successCount?: number;
      lastValidated?: number | null;
      sourceSessions?: string | null;
      /** Memory scope — global, user, agent, or session. Default global. */
      scope?: "global" | "user" | "agent" | "session";
      /** Scope target (userId, agentId, or sessionId). Required when scope is user/agent/session. */
      scopeTarget?: string | null;
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
    const importance = entry.importance ?? 0.7;
    const confidence = entry.confidence ?? 1.0;
    const summary = entry.summary ?? null;
    const normHash = normalizedHash(entry.text);
    const sourceDate = entry.sourceDate ?? null;
    const tags = entry.tags ?? null;
    const tagsStr = tags ? serializeTags(tags) : null;
    const validFrom = entry.validFrom ?? sourceDate ?? nowSec;
    const validUntil = entry.validUntil ?? null;
    const supersedesId = entry.supersedesId ?? null;
    const scope = entry.scope ?? "global";
    const scopeTarget = scope === "global" ? null : (entry.scopeTarget ?? null);
    if (scope !== "global" && !scopeTarget) {
      throw new Error(`scopeTarget required for non-global scope: ${scope}`);
    }
    const procedureType = entry.procedureType ?? null;
    const successCount = entry.successCount ?? 0;
    const lastValidated = entry.lastValidated ?? null;
    const sourceSessionsRaw = entry.sourceSessions ?? null;
    const sourceSessionsStr =
      sourceSessionsRaw == null
        ? null
        : typeof sourceSessionsRaw === "string"
          ? sourceSessionsRaw
          : JSON.stringify(sourceSessionsRaw);

    const tier: MemoryTier = (entry as { tier?: MemoryTier }).tier ?? "warm";
    this.liveDb
      .prepare(
        `INSERT INTO facts (id, text, category, importance, entity, key, value, source, created_at, decay_class, expires_at, last_confirmed_at, confidence, summary, normalized_hash, source_date, tags, valid_from, valid_until, supersedes_id, tier, scope, scope_target, procedure_type, success_count, last_validated, source_sessions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.text,
        entry.category,
        importance,
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
        tier,
        scope,
        scopeTarget,
        procedureType,
        successCount,
        lastValidated,
        sourceSessionsStr,
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
      scope,
      scopeTarget: scopeTarget ?? undefined,
      tags: tags ?? undefined,
      validFrom,
      validUntil: validUntil ?? undefined,
      supersedesId: supersedesId ?? undefined,
      tier,
      procedureType: procedureType ?? undefined,
      successCount,
      lastValidated: lastValidated ?? undefined,
      sourceSessions: sourceSessionsRaw ?? undefined,
    };
  }

  /** Update recall_count and last_accessed for facts (public for progressive disclosure). Bulk UPDATE to avoid N+1. */
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

  /** Get HOT-tier facts for session context, capped by token budget. */
  getHotFacts(maxTokens: number, scopeFilter?: ScopeFilter | null): SearchResult[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const { clause: scopeClause, params: scopeParams } = this.scopeFilterClausePositional(scopeFilter);
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM facts
         WHERE tier = 'hot' AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         ${scopeClause}
         ORDER BY COALESCE(last_accessed, last_confirmed_at, created_at) DESC`,
      )
      .all(nowSec, ...scopeParams) as Array<Record<string, unknown>>;
    const hotRows = rows;
    const results: SearchResult[] = [];
    let usedTokens = 0;
    for (const row of hotRows) {
      if (usedTokens >= maxTokens) break;
      const entry = this.rowToEntry(row);
      const tokens = estimateTokensForDisplay(entry.summary || entry.text);
      if (usedTokens + tokens > maxTokens) {
        // Skip oversized entry and continue scanning for smaller facts that might fit
        continue;
      }
      usedTokens += tokens;
      results.push({ entry, score: 1.0, backend: "sqlite" as const });
    }
    return results;
  }

  /** Set a fact's tier. */
  setTier(id: string, tier: MemoryTier): boolean {
    const result = this.liveDb
      .prepare(`UPDATE facts SET tier = ? WHERE id = ?`)
      .run(tier, id);
    return result.changes > 0;
  }

  /** Compaction — migrate facts between tiers. Completed tasks -> COLD, inactive preferences -> WARM, active blockers -> HOT. */
  runCompaction(opts: {
    inactivePreferenceDays: number;
    hotMaxTokens: number;
    hotMaxFacts: number;
  }): { hot: number; warm: number; cold: number } {
    const nowSec = Math.floor(Date.now() / 1000);
    const inactiveCutoff = nowSec - opts.inactivePreferenceDays * 86400;
    const counts = { hot: 0, warm: 0, cold: 0 };

    // 1) Completed tasks -> COLD (decision category or tag 'task')
    const taskRows = this.liveDb
      .prepare(
        `SELECT id FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND (category = 'decision' OR (',' || COALESCE(tags,'') || ',') LIKE '%,task,%')
         AND (tier IS NULL OR tier != 'cold')`,
      )
      .all(nowSec) as Array<{ id: string }>;
    for (const { id } of taskRows) {
      if (this.setTier(id, "cold")) counts.cold++;
    }

    // 2) Inactive preferences -> WARM (preference + not accessed recently)
    const prefRows = this.liveDb
      .prepare(
        `SELECT id FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND category = 'preference' AND COALESCE(last_accessed, last_confirmed_at, created_at) < ?
         AND tier = 'hot'`,
      )
      .all(nowSec, inactiveCutoff) as Array<{ id: string }>;
    for (const { id } of prefRows) {
      if (this.setTier(id, "warm")) counts.warm++;
    }

    // 2b) Collect existing HOT facts with blocker tag (avoid N+1 in step 4)
    const existingHotBlockerRows = this.liveDb
      .prepare(
        `SELECT id FROM facts WHERE tier = 'hot' AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND (',' || COALESCE(tags,'') || ',') LIKE '%,blocker,%'`,
      )
      .all(nowSec) as Array<{ id: string }>;
    const allBlockerIdSet = new Set(existingHotBlockerRows.map((r) => r.id));

    // 3) Active blockers -> HOT (tag 'blocker'); cap HOT tier by hotMaxFacts and hotMaxTokens
    const blockerRows = this.liveDb
      .prepare(
        `SELECT id, text, summary FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND (',' || COALESCE(tags,'') || ',') LIKE '%,blocker,%'
         AND (tier IS NULL OR tier != 'hot')`,
      )
      .all(nowSec) as Array<{ id: string; text: string; summary: string | null }>;
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
      if (this.setTier(id, "hot")) counts.hot++;
    }

    // 4) Demote HOT facts that are not blockers (so HOT stays small)
    const hotRows = this.liveDb
      .prepare(
        `SELECT id FROM facts WHERE tier = 'hot' AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(nowSec) as Array<{ id: string }>;
    for (const { id } of hotRows) {
      if (allBlockerIdSet.has(id)) continue;
      if (this.setTier(id, "warm")) counts.warm++;
    }

    return counts;
  }

  search(
    query: string,
    limit = 5,
    options: {
      includeExpired?: boolean;
      tag?: string;
      includeSuperseded?: boolean;
      /** Point-in-time: only facts valid at this epoch second. */
      asOf?: number;
      /** 'warm' = only warm tier (default), 'all' = warm + cold. */
      tierFilter?: "warm" | "all";
      /** Scope filter — only return global + matching user/agent/session. */
      scopeFilter?: ScopeFilter | null;
      /** Reinforcement boost — added to score when reinforced_count > 0 (default: 0.1). */
      reinforcementBoost?: number;
    } = {},
  ): SearchResult[] {
    const { includeExpired = false, tag, includeSuperseded = false, asOf, tierFilter = "warm", scopeFilter, reinforcementBoost = 0.1 } = options;

    const sanitized = this.sanitizeFTS5Query(query);
    const safeQuery = sanitized
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
    const tierFilterClause =
      tierFilter === "warm"
        ? "AND (f.tier IS NULL OR f.tier = 'warm' OR f.tier = 'hot')"
        : "";
    const { clause: scopeFilterClauseStr, params: scopeParams } = this.scopeFilterClause(scopeFilter);

    const rows = this.liveDb
      .prepare(
        `SELECT f.*, bm25(facts_fts) as fts_score,
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
           ${tierFilterClause}
           ${scopeFilterClauseStr}
         ORDER BY bm25(facts_fts)
         LIMIT @limit`,
      )
      .all({
        query: safeQuery,
        now: nowSec,
        ...(asOf != null ? { asOf } : {}),
        limit: limit * 2,
        decay_window: 7 * 24 * 3600,
        ...(tagPattern ? { tagPattern } : {}),
        ...scopeParams,
      }) as Array<Record<string, unknown>>;

    if (rows.length === 0) return [];

    const minScore = Math.min(...rows.map((r) => r.fts_score as number));
    const maxScore = Math.max(...rows.map((r) => r.fts_score as number));
    const range = maxScore - minScore || 1;

    const results = rows.map((row) => {
      const rawScore = 1 - ((row.fts_score as number) - minScore) / range;
      const bm25Score = Number.isNaN(rawScore) ? 0.8 : rawScore;
      const freshness = (row.freshness as number) || 1.0;
      const confidence = (row.confidence as number) || 1.0;
      const reinforcedCount = (row.reinforced_count as number) || 0;
      // Add reinforcement boost when fact has been praised
      const reinforcement = reinforcedCount > 0 ? reinforcementBoost : 0;
      const composite = Math.min(1.0, bm25Score * 0.6 + freshness * 0.25 + confidence * 0.15 + reinforcement);
      const entry = this.rowToEntry(row);
      // Apply dynamic salience (access boost + time decay)
      const salienceScore = computeDynamicSalience(composite, entry);

      return {
        entry,
        score: salienceScore,
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
    options?: { includeSuperseded?: boolean; asOf?: number; scopeFilter?: ScopeFilter | null },
  ): SearchResult[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const { includeSuperseded = false, asOf, scopeFilter } = options ?? {};
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
    const { clause: scopeClause, params: scopeParamsArr } = this.scopeFilterClausePositional(scopeFilter);

    const base = key
      ? `SELECT * FROM facts WHERE lower(entity) = lower(?) AND lower(key) = lower(?) AND (expires_at IS NULL OR expires_at > ?)${temporalFilter}${tagFilter}${scopeClause} ORDER BY confidence DESC, COALESCE(source_date, created_at) DESC`
      : `SELECT * FROM facts WHERE lower(entity) = lower(?) AND (expires_at IS NULL OR expires_at > ?)${temporalFilter}${tagFilter}${scopeClause} ORDER BY confidence DESC, COALESCE(source_date, created_at) DESC`;

    const params = key
      ? tagParam !== null
        ? asOf != null
          ? [...[entity, key, nowSec, asOf, asOf, tagParam], ...scopeParamsArr]
          : [...[entity, key, nowSec, tagParam], ...scopeParamsArr]
        : asOf != null
          ? [...[entity, key, nowSec, asOf, asOf], ...scopeParamsArr]
          : [...[entity, key, nowSec], ...scopeParamsArr]
      : tagParam !== null
        ? asOf != null
          ? [...[entity, nowSec, asOf, asOf, tagParam], ...scopeParamsArr]
          : [...[entity, nowSec, tagParam], ...scopeParamsArr]
        : asOf != null
          ? [...[entity, nowSec, asOf, asOf], ...scopeParamsArr]
          : [...[entity, nowSec], ...scopeParamsArr];
    const rows = this.liveDb.prepare(base).all(...params) as Array<
      Record<string, unknown>
    >;

    const results = rows.map((row) => {
      const entry = this.rowToEntry(row);
      const baseScore = (row.confidence as number) || 1.0;
      // Apply dynamic salience (access boost + time decay)
      const salienceScore = computeDynamicSalience(baseScore, entry);
      return {
        entry,
        score: salienceScore,
        backend: "sqlite" as const,
      };
    });

    this.refreshAccessedFacts(results.map((r) => r.entry.id));

    return results;
  }

  /** Find a fact ID by prefix (for truncated ID resolution).
   * Returns { id } for unique match, { ambiguous, count } for multiple, or null for no match.
   * Requires at least 4 hex chars to prevent full-table scans and reduce ambiguity. */
  findByIdPrefix(prefix: string): { id: string } | { ambiguous: true; count: number } | null {
    if (!prefix || prefix.length < 4) return null;
    // Only allow hex characters (UUIDs are hex + dashes, but truncated prefixes are hex-only)
    if (!/^[0-9a-f]+$/i.test(prefix)) return null;
    // Insert dashes at UUID positions to match stored format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    let pattern = prefix.toLowerCase();
    if (prefix.length > 8 && !prefix.includes("-")) {
      const parts: string[] = [];
      parts.push(pattern.slice(0, 8));
      if (pattern.length > 8) parts.push(pattern.slice(8, 12));
      if (pattern.length > 12) parts.push(pattern.slice(12, 16));
      if (pattern.length > 16) parts.push(pattern.slice(16, 20));
      if (pattern.length > 20) parts.push(pattern.slice(20));
      pattern = parts.join("-");
    }
    const rows = this.liveDb.prepare(
      `SELECT id FROM facts WHERE id LIKE ? || '%' LIMIT 3`
    ).all(pattern) as Array<{ id: string }>;
    if (rows.length === 0) return null;
    if (rows.length === 1) return { id: rows[0].id };
    return { ambiguous: true, count: rows.length >= 3 ? 3 : rows.length };
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

  /** Mark a fact as superseded by a new fact. Sets superseded_at, superseded_by, and valid_until (bi-temporal). */
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


  /** Find top-N most similar existing facts by entity+key overlap and normalized text. Used for ADD/UPDATE/DELETE classification. */
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
      const sanitized = this.sanitizeFTS5Query(text);
      const words = sanitized
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
        } catch (err) {
          capturePluginError(err as Error, {
            operation: 'fts-query',
            severity: 'info',
            subsystem: 'facts'
          });
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
      tier: (row.tier as MemoryTier) ?? undefined,
      scope: (row.scope as "global" | "user" | "agent" | "session") ?? "global",
      scopeTarget: (row.scope_target as string) || null,
      procedureType: (row.procedure_type as "positive" | "negative") ?? undefined,
      successCount: (row.success_count as number) ?? undefined,
      lastValidated: (row.last_validated as number) ?? undefined,
      sourceSessions: (row.source_sessions as string) ?? undefined,
      reinforcedCount: (row.reinforced_count as number) ?? 0,
      lastReinforcedAt: (row.last_reinforced_at as number) ?? null,
      reinforcedQuotes: (() => {
        const raw = row.reinforced_quotes as string | null;
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : null;
        } catch (err) {
          capturePluginError(err as Error, {
            operation: 'json-parse-quotes',
            severity: 'info',
            subsystem: 'facts'
          });
          return null;
        }
      })(),
    };
  }

  /** For consolidation (2.4): fetch facts with id, text, category, entity, key. Order by created_at DESC. Excludes superseded. */
  getFactsForConsolidation(limit: number): Array<{ id: string; text: string; category: string; entity: string | null; key: string | null }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = this.liveDb
      .prepare(
        `SELECT id, text, category, entity, key FROM facts
         WHERE (expires_at IS NULL OR expires_at > ?) AND superseded_at IS NULL ORDER BY created_at DESC LIMIT ?`,
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

  /** Alias for getById for CLI compatibility. */
  get(id: string): MemoryEntry | null {
    return this.getById(id);
  }

  /** Get one fact by id (for merge category). Returns null if not found. When asOf is set, returns null if the fact was not valid at that time. When scopeFilter is set, returns null if the fact is not in scope. */
  getById(id: string, options?: { asOf?: number; scopeFilter?: ScopeFilter | null }): MemoryEntry | null {
    const row = this.liveDb.prepare(`SELECT * FROM facts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const entry = this.rowToEntry(row);
    const asOf = options?.asOf;
    if (asOf != null) {
      const vf = entry.validFrom ?? entry.createdAt;
      const vu = entry.validUntil ?? null;
      if (vf > asOf || (vu != null && vu <= asOf)) return null;
    }
    const scopeFilter = options?.scopeFilter;
    if (scopeFilter && (scopeFilter.userId || scopeFilter.agentId || scopeFilter.sessionId)) {
      const scope = entry.scope ?? "global";
      if (scope === "global") return entry;
      const target = entry.scopeTarget ?? null;
      const matches =
        (scope === "user" && (scopeFilter.userId ?? null) === target) ||
        (scope === "agent" && (scopeFilter.agentId ?? null) === target) ||
        (scope === "session" && (scopeFilter.sessionId ?? null) === target);
      if (!matches) return null;
    }
    return entry;
  }

  /** Create a typed link between two facts. Returns link id. */
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

  /** Hebbian: Create or strengthen RELATED_TO link between two facts recalled together. */
  createOrStrengthenRelatedLink(
    factIdA: string,
    factIdB: string,
    deltaStrength = 0.1,
  ): void {
    if (factIdA === factIdB) return;
    const [source, target] = factIdA < factIdB ? [factIdA, factIdB] : [factIdB, factIdA];

    const existing = this.liveDb
      .prepare(
        `SELECT id, strength FROM memory_links WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'RELATED_TO'`,
      )
      .get(source, target) as { id: string; strength: number } | undefined;

    const newStrength = Math.min(1, (existing?.strength ?? 0) + deltaStrength);
    if (existing) {
      this.liveDb
        .prepare(`UPDATE memory_links SET strength = ? WHERE id = ?`)
        .run(newStrength, existing.id);
    } else {
      this.createLink(source, target, "RELATED_TO", newStrength);
    }
  }

  /** Get links from a fact (outgoing). */
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

  /** Get links to a fact (incoming). */
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

  /** BFS from given fact IDs up to maxDepth hops. Returns all connected fact IDs (including the seed set). */
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

  /** Get facts from the last N days (for reflection). Excludes pattern/rule by default. More efficient than getAll+filter. */
  getRecentFacts(days: number, options?: { excludeCategories?: string[] }): MemoryEntry[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStartSec = nowSec - Math.max(1, Math.min(90, days)) * 86400;
    const exclude = options?.excludeCategories ?? ["pattern", "rule"];
    const placeholders = exclude.map(() => "?").join(",");
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM facts WHERE (expires_at IS NULL OR expires_at > ?) AND superseded_at IS NULL
         AND (COALESCE(source_date, created_at) >= ?)
         AND category NOT IN (${placeholders})
         ORDER BY COALESCE(source_date, created_at) DESC`,
      )
      .all(nowSec, windowStartSec, ...exclude) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEntry(row));
  }

  /** Get all non-expired facts (for reflection). Optional point-in-time / include superseded. Optional scope filter. */
  getAll(options?: { includeSuperseded?: boolean; asOf?: number; scopeFilter?: ScopeFilter | null }): MemoryEntry[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const { includeSuperseded = false, asOf, scopeFilter } = options ?? {};
    const temporalFilter =
      asOf != null
        ? " AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)"
        : includeSuperseded
          ? ""
          : " AND superseded_at IS NULL";
    const { clause: scopeClause, params: scopeParams } = this.scopeFilterClausePositional(scopeFilter);
    const params = asOf != null ? [...[nowSec, asOf, asOf], ...scopeParams] : [...[nowSec], ...scopeParams];
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM facts WHERE (expires_at IS NULL OR expires_at > ?)${temporalFilter}${scopeClause} ORDER BY created_at DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEntry(row));
  }

  /** List recent facts with optional filters (for CLI list command). Order: created_at DESC. */
  list(
    limit: number,
    filters?: {
      category?: string;
      entity?: string;
      key?: string;
      source?: string;
      tier?: string;
    },
  ): MemoryEntry[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const parts: string[] = [
      "(expires_at IS NULL OR expires_at > ?)",
      "superseded_at IS NULL",
    ];
    const params: unknown[] = [nowSec];
    if (filters?.category != null) {
      parts.push("category = ?");
      params.push(filters.category);
    }
    if (filters?.entity != null) {
      parts.push("lower(entity) = lower(?)");
      params.push(filters.entity);
    }
    if (filters?.key != null) {
      parts.push("lower(key) = lower(?)");
      params.push(filters.key);
    }
    if (filters?.source != null) {
      parts.push("source = ?");
      params.push(filters.source);
    }
    if (filters?.tier != null) {
      parts.push("COALESCE(tier, 'warm') = ?");
      params.push(filters.tier);
    }
    const where = parts.join(" AND ");
    params.push(limit);
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM facts WHERE ${where} ORDER BY COALESCE(source_date, created_at) DESC LIMIT ?`,
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

  /** Prune session-scoped memories for a given session (cleared on session end). Returns count deleted. */
  pruneSessionScope(sessionId: string): number {
    const result = this.liveDb
      .prepare(`DELETE FROM facts WHERE scope = 'session' AND scope_target = ?`)
      .run(sessionId);
    return result.changes;
  }

  /** Promote a fact's scope (e.g. session → global or agent). Returns true if updated. */
  promoteScope(factId: string, newScope: "global" | "user" | "agent" | "session", newScopeTarget: string | null): boolean {
    const scopeTarget = newScope === "global" ? null : newScopeTarget;
    const result = this.liveDb
      .prepare(`UPDATE facts SET scope = ?, scope_target = ? WHERE id = ?`)
      .run(newScope, scopeTarget, factId);
    return result.changes > 0;
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

  /**
   * Helper: Parse existing reinforced_quotes JSON, append a new quote snippet, and cap at 10 entries.
   * Returns the updated JSON string.
   */
  private appendReinforcementQuote(existingJson: string | null, newSnippet: string): string {
    let quotes: string[] = [];
    if (existingJson) {
      try {
        const parsed = JSON.parse(existingJson);
        if (Array.isArray(parsed)) quotes = parsed.filter((q): q is string => typeof q === "string");
      } catch (err) {
        capturePluginError(err as Error, {
          operation: 'json-parse-quotes',
          severity: 'info',
          subsystem: 'facts'
        });
        // Corrupted JSON — start fresh
      }
    }
    quotes.push(newSnippet.slice(0, 200));
    if (quotes.length > 10) quotes = quotes.slice(-10);
    return JSON.stringify(quotes);
  }

  /**
   * Annotate a fact with reinforcement from user praise.
   * Increments reinforced_count, updates last_reinforced_at, appends quote (max 10 quotes kept).
   * Wraps read-modify-write in a transaction to prevent race conditions.
   * Returns true if fact was updated.
   */
  reinforceFact(id: string, quoteSnippet: string): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    
    const tx = this.liveDb.transaction(() => {
      const row = this.liveDb
        .prepare(`SELECT reinforced_quotes FROM facts WHERE id = ?`)
        .get(id) as { reinforced_quotes: string | null } | undefined;
      if (!row) return false;

      const quotesJson = this.appendReinforcementQuote(row.reinforced_quotes, quoteSnippet);

      this.liveDb
        .prepare(
          `UPDATE facts SET reinforced_count = reinforced_count + 1, last_reinforced_at = ?, reinforced_quotes = ? WHERE id = ?`,
        )
        .run(nowSec, quotesJson, id);
      return true;
    });
    
    return tx();
  }

  /**
   * Phase 2: Annotate a procedure with reinforcement from user praise.
   * Increments reinforced_count, updates last_reinforced_at, appends quote (max 10 quotes kept).
   * Checks if reinforced_count reaches promotion threshold and auto-promotes if needed.
   * Wraps read-modify-write in a transaction to prevent race conditions.
   * Returns true if procedure was updated.
   */
  reinforceProcedure(id: string, quoteSnippet: string, promotionThreshold = 2): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    
    const tx = this.liveDb.transaction(() => {
      const row = this.liveDb
        .prepare(`SELECT reinforced_quotes, reinforced_count, confidence FROM procedures WHERE id = ?`)
        .get(id) as { reinforced_quotes: string | null; reinforced_count: number; confidence: number } | undefined;
      if (!row) return false;

      const quotesJson = this.appendReinforcementQuote(row.reinforced_quotes, quoteSnippet);

      const newReinforcedCount = (row.reinforced_count ?? 0) + 1;

      // Phase 2: Auto-promote if reinforced_count >= threshold and confidence < 0.8
      let newConfidence = row.confidence;
      let promotedAt: number | null = null;
      if (newReinforcedCount >= promotionThreshold && row.confidence < 0.8) {
        newConfidence = Math.max(row.confidence, 0.8);
        promotedAt = nowSec;
      }

      if (promotedAt !== null) {
        this.liveDb
          .prepare(
            `UPDATE procedures SET reinforced_count = ?, last_reinforced_at = ?, reinforced_quotes = ?, confidence = ?, promoted_at = ? WHERE id = ?`,
          )
          .run(newReinforcedCount, nowSec, quotesJson, newConfidence, promotedAt, id);
      } else {
        this.liveDb
          .prepare(
            `UPDATE procedures SET reinforced_count = ?, last_reinforced_at = ?, reinforced_quotes = ? WHERE id = ?`,
          )
          .run(newReinforcedCount, nowSec, quotesJson, id);
      }
      return true;
    });
    
    return tx();
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
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'json-parse-checkpoint',
        severity: 'info',
        subsystem: 'facts'
      });
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

  /** Tier breakdown (hot/warm/cold) for non-superseded facts. */
  statsBreakdownByTier(): Record<string, number> {
    const rows = this.liveDb
      .prepare(
        `SELECT COALESCE(tier, 'warm') as tier, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY tier`,
      )
      .all() as Array<{ tier: string; cnt: number }>;
    const stats: Record<string, number> = { hot: 0, warm: 0, cold: 0 };
    for (const row of rows) {
      stats[row.tier || "warm"] = row.cnt;
    }
    return stats;
  }

  /** Source breakdown (conversation, cli, distillation, reflection, etc.) for non-superseded facts. */
  statsBreakdownBySource(): Record<string, number> {
    const rows = this.liveDb
      .prepare(
        `SELECT source, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY source`,
      )
      .all() as Array<{ source: string; cnt: number }>;
    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row.source || "unknown"] = row.cnt;
    }
    return stats;
  }

  /** Category breakdown for non-superseded facts (for rich stats). */
  statsBreakdownByCategory(): Record<string, number> {
    const rows = this.liveDb
      .prepare(
        `SELECT category, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY category`,
      )
      .all() as Array<{ category: string; cnt: number }>;
    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row.category || "other"] = row.cnt;
    }
    return stats;
  }

  /** Distinct memory categories present in non-superseded facts (for CLI stats/categories). */
  uniqueMemoryCategories(): string[] {
    const rows = this.liveDb
      .prepare(
        `SELECT DISTINCT category FROM facts WHERE superseded_at IS NULL ORDER BY category`,
      )
      .all() as Array<{ category: string }>;
    return rows.map((r) => r.category || "other");
  }

  /** Count of procedures (from procedures table). Returns 0 if table does not exist. */
  proceduresCount(): number {
    try {
      const row = this.liveDb.prepare(`SELECT COUNT(*) as cnt FROM procedures`).get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'count-procedures',
        severity: 'info',
        subsystem: 'facts'
      });
      return 0;
    }
  }

  /** Count of procedures with last_validated set (validated at least once). */
  proceduresValidatedCount(): number {
    try {
      const row = this.liveDb
        .prepare(`SELECT COUNT(*) as cnt FROM procedures WHERE last_validated IS NOT NULL`)
        .get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'count-procedures-validated',
        severity: 'info',
        subsystem: 'facts'
      });
      return 0;
    }
  }

  /** Count of procedures promoted to skill (promoted_to_skill = 1). */
  proceduresPromotedCount(): number {
    try {
      const row = this.liveDb
        .prepare(`SELECT COUNT(*) as cnt FROM procedures WHERE promoted_to_skill = 1`)
        .get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'count-procedures-promoted',
        severity: 'info',
        subsystem: 'facts'
      });
      return 0;
    }
  }

  /** Count of rows in memory_links (graph connections). Returns 0 if table does not exist. */
  linksCount(): number {
    try {
      const row = this.liveDb
        .prepare(`SELECT COUNT(*) as cnt FROM memory_links`)
        .get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'count-links',
        severity: 'info',
        subsystem: 'facts'
      });
      return 0;
    }
  }

  /** Count of facts with source LIKE 'directive:%' (extracted directives). */
  directivesCount(): number {
    const row = this.liveDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL AND source LIKE 'directive:%'`,
      )
      .get() as { cnt: number };
    return row?.cnt ?? 0;
  }

  /** Count of facts with category = 'pattern' and tag 'meta' (meta-patterns). */
  metaPatternsCount(): number {
    try {
      const row = this.liveDb
        .prepare(
          `SELECT COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL AND category = 'pattern' AND (',' || COALESCE(tags,'') || ',') LIKE '%,meta,%'`,
        )
        .get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'count-meta-patterns',
        severity: 'info',
        subsystem: 'facts'
      });
      return 0;
    }
  }

  /** Distinct entity count (non-null, non-empty entity values). */
  entityCount(): number {
    const row = this.liveDb
      .prepare(
        `SELECT COUNT(DISTINCT entity) as cnt FROM facts WHERE superseded_at IS NULL AND entity IS NOT NULL AND entity != ''`,
      )
      .get() as { cnt: number };
    return row?.cnt ?? 0;
  }

  /** Estimated total tokens stored (summary or text) for non-superseded facts. Uses same heuristic as auto-recall. */
  estimateStoredTokens(): number {
    const rows = this.liveDb
      .prepare(
        `SELECT summary, text FROM facts WHERE superseded_at IS NULL`,
      )
      .all() as Array<{ summary: string | null; text: string }>;
    return rows.reduce((sum, r) => sum + estimateTokensForDisplay(r.summary || r.text), 0);
  }

  /** Estimated tokens by tier (hot/warm/cold) for non-superseded facts. */
  estimateStoredTokensByTier(): { hot: number; warm: number; cold: number } {
    const rows = this.liveDb
      .prepare(
        `SELECT COALESCE(tier, 'warm') as tier, summary, text FROM facts WHERE superseded_at IS NULL`,
      )
      .all() as Array<{ tier: string; summary: string | null; text: string }>;
    const out = { hot: 0, warm: 0, cold: 0 };
    for (const r of rows) {
      const tok = estimateTokensForDisplay(r.summary || r.text);
      const t = r.tier || "warm";
      if (t === "hot") out.hot += tok;
      else if (t === "cold") out.cold += tok;
      else out.warm += tok;
    }
    return out;
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
    return rows.map((row) => this.rowToEntry(row));
  }

  /** List non-superseded facts by category (for CLI list command). */
  listFactsByCategory(category: string, limit = 100): MemoryEntry[] {
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM facts WHERE category = ? AND (superseded_at IS NULL) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(category, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEntry(row));
  }

  /** List directive facts (source LIKE 'directive:%'), non-superseded, by created_at DESC. */
  listDirectives(limit = 100): MemoryEntry[] {
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM facts WHERE source LIKE 'directive:%' AND (superseded_at IS NULL) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEntry(row));
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

  // ---------- Procedural memory: procedures table CRUD ----------

  private procedureRowToEntry(row: Record<string, unknown>): ProcedureEntry {
    return {
      id: row.id as string,
      taskPattern: row.task_pattern as string,
      recipeJson: row.recipe_json as string,
      procedureType: (row.procedure_type as "positive" | "negative") || "positive",
      successCount: (row.success_count as number) ?? 0,
      failureCount: (row.failure_count as number) ?? 0,
      lastValidated: (row.last_validated as number) ?? null,
      lastFailed: (row.last_failed as number) ?? null,
      confidence: (row.confidence as number) ?? 0.5,
      ttlDays: (row.ttl_days as number) ?? 30,
      promotedToSkill: (row.promoted_to_skill as number) ?? 0,
      skillPath: (row.skill_path as string) ?? null,
      createdAt: (row.created_at as number) ?? 0,
      updatedAt: (row.updated_at as number) ?? 0,
      sourceSessions: (row.source_sessions as string) ?? undefined,
      reinforcedCount: (row.reinforced_count as number) ?? 0,
      lastReinforcedAt: (row.last_reinforced_at as number) ?? null,
      reinforcedQuotes: (() => {
        const raw = row.reinforced_quotes as string | null;
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : null;
        } catch (err) {
          capturePluginError(err as Error, {
            operation: 'json-parse-quotes',
            severity: 'info',
            subsystem: 'facts'
          });
          return null;
        }
      })(),
      promotedAt: (row.promoted_at as number) ?? null,
      scope: (row.scope as string) ?? "global",
      scopeTarget: (row.scope_target as string) ?? null,
    };
  }

  /** Insert or replace a procedure. Returns the procedure id. */
  upsertProcedure(proc: {
    id?: string;
    taskPattern: string;
    recipeJson: string;
    procedureType: "positive" | "negative";
    successCount?: number;
    failureCount?: number;
    lastValidated?: number | null;
    lastFailed?: number | null;
    confidence?: number;
    ttlDays?: number;
    sourceSessionId?: string;
    /** Memory scope — global, user, agent, or session. Default global. */
    scope?: "global" | "user" | "agent" | "session";
    /** Scope target (userId, agentId, or sessionId). Required when scope is user/agent/session. */
    scopeTarget?: string | null;
  }): ProcedureEntry {
    const id = proc.id ?? randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const existing = this.getProcedureById(id);
    if (existing) {
      const successCount = (proc.successCount ?? existing.successCount);
      const failureCount = (proc.failureCount ?? existing.failureCount);
      const confidence = proc.confidence ?? Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (successCount - failureCount)));
      const scope = proc.scope ?? existing.scope;
      const scopeTarget = proc.scopeTarget ?? existing.scopeTarget;
      this.liveDb
        .prepare(
          `UPDATE procedures SET task_pattern = ?, recipe_json = ?, procedure_type = ?, success_count = ?, failure_count = ?, last_validated = ?, last_failed = ?, confidence = ?, ttl_days = ?, scope = ?, scope_target = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          proc.taskPattern,
          proc.recipeJson,
          proc.procedureType,
          successCount,
          failureCount,
          proc.lastValidated ?? existing.lastValidated,
          proc.lastFailed ?? existing.lastFailed,
          confidence,
          proc.ttlDays ?? existing.ttlDays,
          scope,
          scopeTarget,
          now,
          id,
        );
      return this.getProcedureById(id)!;
    }
    const scope = proc.scope ?? "global";
    const scopeTarget = proc.scopeTarget ?? null;
    this.liveDb
      .prepare(
        `INSERT INTO procedures (id, task_pattern, recipe_json, procedure_type, success_count, failure_count, last_validated, last_failed, confidence, ttl_days, promoted_to_skill, skill_path, source_sessions, scope, scope_target, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        proc.taskPattern,
        proc.recipeJson,
        proc.procedureType,
        proc.successCount ?? 1,
        proc.failureCount ?? 0,
        proc.lastValidated ?? null,
        proc.lastFailed ?? null,
        proc.confidence ?? 0.5,
        proc.ttlDays ?? 30,
        proc.sourceSessionId ?? null,
        scope,
        scopeTarget,
        now,
        now,
      );
    return this.getProcedureById(id)!;
  }

  /** List procedures ordered by updated_at DESC. Returns up to limit (default 100). */
  listProcedures(limit = 100): ProcedureEntry[] {
    try {
      const rows = this.liveDb
        .prepare(`SELECT * FROM procedures ORDER BY updated_at DESC, created_at DESC LIMIT ?`)
        .all(limit) as Array<Record<string, unknown>>;
      return rows.map((r) => this.procedureRowToEntry(r));
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'list-procedures',
        severity: 'info',
        subsystem: 'facts'
      });
      return [];
    }
  }

  /** List positive procedures updated in the last N days (for memory-to-skills). Days clamped to [1, 365]. */
  listProceduresUpdatedInLastNDays(days: number, limit = 500): ProcedureEntry[] {
    if (Number.isNaN(days) || days <= 0) return [];
    const clampedDays = Math.min(365, Math.max(1, Math.floor(days)));
    try {
      const cutoff = Math.floor(Date.now() / 1000) - clampedDays * 24 * 3600;
      const rows = this.liveDb
        .prepare(
          `SELECT * FROM procedures WHERE procedure_type = 'positive' AND updated_at >= ? AND promoted_to_skill = 0 ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
        )
        .all(cutoff, limit) as Array<Record<string, unknown>>;
      return rows.map((r) => this.procedureRowToEntry(r));
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'list-procedures-recent',
        severity: 'info',
        subsystem: 'facts'
      });
      return [];
    }
  }

  getProcedureById(id: string): ProcedureEntry | null {
    const row = this.liveDb.prepare(`SELECT * FROM procedures WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.procedureRowToEntry(row);
  }

  /** Find procedure by task_pattern hash or normalized match (for dedupe). */
  findProcedureByTaskPattern(taskPattern: string, limit = 5): ProcedureEntry[] {
    const sanitized = this.sanitizeFTS5Query(taskPattern);
    const safeQuery = sanitized
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, 5)
      .map((w) => `"${w}"`)
      .join(" OR ");
    if (!safeQuery) return [];
    try {
      const rows = this.liveDb
        .prepare(
          `SELECT p.* FROM procedures p JOIN procedures_fts fts ON p.rowid = fts.rowid WHERE procedures_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(safeQuery, limit) as Array<Record<string, unknown>>;
      return rows.map((r) => this.procedureRowToEntry(r));
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'fts-query',
        severity: 'info',
        subsystem: 'facts'
      });
      return [];
    }
  }

  /** 
   * Search procedures by task description (FTS). Returns positive procedures first, then negative.
   * Phase 2: Applies reinforcement boost to score when reinforced_count > 0.
   */
  searchProcedures(taskDescription: string, limit = 10, reinforcementBoost = 0.1, scopeFilter?: ScopeFilter): ProcedureEntry[] {
    const sanitized = this.sanitizeFTS5Query(taskDescription);
    const safeQuery = sanitized
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, 8)
      .map((w) => `"${w}"`)
      .join(" OR ");
    if (!safeQuery) return [];
    try {
      // Apply scope filter to procedures search
      const { clause: scopeClause, params: scopeParams } = this.scopeFilterClausePositional(scopeFilter);
      const baseSql = `SELECT p.*, bm25(procedures_fts) as fts_score FROM procedures p JOIN procedures_fts fts ON p.rowid = fts.rowid WHERE procedures_fts MATCH ?${scopeClause} ORDER BY p.procedure_type DESC, bm25(procedures_fts) LIMIT ?`;
      const rows = this.liveDb
        .prepare(baseSql)
        .all(safeQuery, ...scopeParams, limit * 2) as Array<Record<string, unknown>>;
      
      if (rows.length === 0) return [];
      
      // Phase 2: Compute composite score: FTS relevance + confidence + reinforcement
      const minFtsScore = Math.min(...rows.map((r) => r.fts_score as number));
      const maxFtsScore = Math.max(...rows.map((r) => r.fts_score as number));
      const ftsRange = maxFtsScore - minFtsScore || 1;
      
      type ScoredRow = Record<string, unknown> & { boostedScore: number };
      const scored: ScoredRow[] = rows.map((r) => {
        const reinforcedCount = (r.reinforced_count as number) ?? 0;
        const confidence = (r.confidence as number) ?? 0.5;
        const reinforcement = reinforcedCount > 0 ? reinforcementBoost : 0;
        // Normalize FTS score to 0-1 range (inverted because bm25 returns negative scores)
        const rawFtsScore = 1 - ((r.fts_score as number) - minFtsScore) / ftsRange;
        const ftsScore = Number.isNaN(rawFtsScore) ? 0.8 : rawFtsScore;
        // Composite: 60% FTS relevance, 40% confidence, plus reinforcement boost (capped at 1.0)
        const boostedScore = Math.min(1.0, ftsScore * 0.6 + confidence * 0.4 + reinforcement);
        return { ...r, boostedScore };
      });

      // Sort by procedure_type (positive first), then boosted score, then validation
      scored.sort((a, b) => {
        const typeA = (a.procedure_type as string) === "positive" ? 1 : 0;
        const typeB = (b.procedure_type as string) === "positive" ? 1 : 0;
        if (typeB !== typeA) return typeB - typeA;
        if (b.boostedScore !== a.boostedScore) return b.boostedScore - a.boostedScore;
        const lastValA = (a.last_validated as number) ?? 0;
        const lastValB = (b.last_validated as number) ?? 0;
        return lastValB - lastValA;
      });

      return scored.slice(0, limit).map((r) => this.procedureRowToEntry(r));
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'fts-query',
        severity: 'info',
        subsystem: 'facts'
      });
      return [];
    }
  }

  /**
   * Confidence-weighted procedural ranking (enhancement):
   * - Combines FTS relevance with confidence, recency, success rate, and recent failures
   * - Recency decay over 30-day window (min 0.3 factor)
   * - Success rate boost (50-100% weight based on successCount/failureCount)
   * - Penalty for procedures that failed in last 7 days (0.5 multiplier)
   * - Never-validated procedures get 30% penalty
   * - Reinforcement boost for user-praised procedures (configurable)
   * Returns procedures with relevanceScore, sorted by composite score.
   */
  searchProceduresRanked(taskDescription: string, limit = 10, reinforcementBoost = 0.1, scopeFilter?: ScopeFilter): Array<ProcedureEntry & { relevanceScore: number }> {
    const sanitized = this.sanitizeFTS5Query(taskDescription);
    const safeQuery = sanitized
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, 8)
      .map((w) => `"${w}"`)
      .join(" OR ");
    if (!safeQuery) return [];
    
    const nowSec = Math.floor(Date.now() / 1000);
    const RECENCY_WINDOW = 30 * 24 * 3600; // 30 days
    const RECENT_FAILURE_WINDOW = 7 * 24 * 3600; // 7 days
    const MIN_RECENCY_FACTOR = 0.3;
    const NEVER_VALIDATED_PENALTY = 0.7; // 30% penalty
    const RECENT_FAILURE_PENALTY = 0.5;
    
    try {
      // Apply scope filter to procedures search
      const { clause: scopeClause, params: scopeParams } = this.scopeFilterClausePositional(scopeFilter);
      const rows = this.liveDb
        .prepare(
          `SELECT p.*, bm25(procedures_fts) as fts_score FROM procedures p 
           JOIN procedures_fts fts ON p.rowid = fts.rowid 
           WHERE procedures_fts MATCH ?${scopeClause} 
           ORDER BY bm25(procedures_fts) 
           LIMIT ?`,
        )
        .all(safeQuery, ...scopeParams, limit * 3) as Array<Record<string, unknown>>;
      
      if (rows.length === 0) return [];
      
      // Normalize FTS scores to 0-1 range
      const minFtsScore = Math.min(...rows.map((r) => r.fts_score as number));
      const maxFtsScore = Math.max(...rows.map((r) => r.fts_score as number));
      const ftsRange = maxFtsScore - minFtsScore || 1;
      
      type ScoredRow = ProcedureEntry & { relevanceScore: number };
      const scored: ScoredRow[] = rows.map((r) => {
        const proc = this.procedureRowToEntry(r);
        const confidence = proc.confidence;
        
        // FTS relevance (inverted because bm25 returns negative scores)
        const rawFtsScore = 1 - ((r.fts_score as number) - minFtsScore) / ftsRange;
        const ftsScore = Number.isNaN(rawFtsScore) ? 0.8 : rawFtsScore;
        
        // Recency factor (decay over 30 days, min 0.3)
        const lastActive = proc.lastValidated ?? proc.createdAt;
        const ageSeconds = nowSec - lastActive;
        const recencyFactor = ageSeconds > RECENCY_WINDOW
          ? MIN_RECENCY_FACTOR
          : Math.max(MIN_RECENCY_FACTOR, 1 - (ageSeconds / RECENCY_WINDOW));
        
        // Success rate (50-100% weight based on successCount/failureCount)
        const totalTrials = proc.successCount + proc.failureCount;
        let successRateWeight = 0.75; // default for never-validated
        if (totalTrials > 0) {
          const successRate = proc.successCount / totalTrials;
          successRateWeight = 0.5 + (successRate * 0.5); // 50% base + up to 50% from success rate
        }
        
        // Penalty for recent failures (last 7 days)
        let recentFailurePenalty = 1.0;
        if (proc.lastFailed && (nowSec - proc.lastFailed) < RECENT_FAILURE_WINDOW) {
          recentFailurePenalty = RECENT_FAILURE_PENALTY;
        }
        
        // Penalty for never-validated procedures
        let validationPenalty = 1.0;
        if (!proc.lastValidated) {
          validationPenalty = NEVER_VALIDATED_PENALTY;
        }
        
        // Reinforcement boost for user-praised procedures
        const reinforcedCount = (r.reinforced_count as number) ?? 0;
        const reinforcement = reinforcedCount > 0 ? reinforcementBoost : 0;
        
        // Composite score: FTS relevance + confidence + reinforcement, weighted by recency, success_rate, and penalties
        const baseScore = ftsScore * 0.6 + confidence * 0.4 + reinforcement;
        const relevanceScore = Math.min(1.0, 
          baseScore * recencyFactor * successRateWeight * recentFailurePenalty * validationPenalty
        );
        
        return { ...proc, relevanceScore };
      });

      // Sort by relevanceScore, then procedure_type (positive first as tiebreaker), then last validated
      scored.sort((a, b) => {
        if (Math.abs(b.relevanceScore - a.relevanceScore) > 0.001) {
          return b.relevanceScore - a.relevanceScore;
        }
        const typeA = a.procedureType === "positive" ? 1 : 0;
        const typeB = b.procedureType === "positive" ? 1 : 0;
        if (typeB !== typeA) return typeB - typeA;
        const lastValA = a.lastValidated ?? 0;
        const lastValB = b.lastValidated ?? 0;
        return lastValB - lastValA;
      });

      return scored.slice(0, limit);
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'fts-query',
        severity: 'info',
        subsystem: 'facts'
      });
      return [];
    }
  }

  /** Get negative procedures whose task_pattern might match the given description (for warnings). */
  getNegativeProceduresMatching(taskDescription: string, limit = 5, scopeFilter?: ScopeFilter): ProcedureEntry[] {
    const all = this.searchProcedures(taskDescription, limit * 2, 0.1, scopeFilter);
    return all.filter((p) => p.procedureType === "negative").slice(0, limit);
  }

  /** Record a successful use of a procedure (bump success_count, last_validated). */
  recordProcedureSuccess(id: string, recipeJson?: string, sessionId?: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const proc = this.getProcedureById(id);
    if (!proc) return false;
    
    // Check if this session has already been counted
    if (sessionId) {
      const sourceSessions = proc.sourceSessions ? proc.sourceSessions.split(",") : [];
      if (sourceSessions.includes(sessionId)) {
        return false;
      }
      sourceSessions.push(sessionId);
      const newSourceSessions = sourceSessions.join(",");
      
      const successCount = proc.successCount + 1;
      const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (successCount - proc.failureCount)));
      if (recipeJson !== undefined) {
        this.liveDb
          .prepare(
            `UPDATE procedures SET success_count = ?, last_validated = ?, confidence = ?, procedure_type = 'positive', recipe_json = ?, source_sessions = ?, updated_at = ? WHERE id = ?`,
          )
          .run(successCount, now, confidence, recipeJson, newSourceSessions, now, id);
      } else {
        this.liveDb
          .prepare(
            `UPDATE procedures SET success_count = ?, last_validated = ?, confidence = ?, procedure_type = 'positive', source_sessions = ?, updated_at = ? WHERE id = ?`,
          )
          .run(successCount, now, confidence, newSourceSessions, now, id);
      }
    } else {
      const successCount = proc.successCount + 1;
      const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (successCount - proc.failureCount)));
      if (recipeJson !== undefined) {
        this.liveDb
          .prepare(
            `UPDATE procedures SET success_count = ?, last_validated = ?, confidence = ?, procedure_type = 'positive', recipe_json = ?, updated_at = ? WHERE id = ?`,
          )
          .run(successCount, now, confidence, recipeJson, now, id);
      } else {
        this.liveDb
          .prepare(
            `UPDATE procedures SET success_count = ?, last_validated = ?, confidence = ?, procedure_type = 'positive', updated_at = ? WHERE id = ?`,
          )
          .run(successCount, now, confidence, now, id);
      }
    }
    return true;
  }

  /** Record a failed use (bump failure_count, last_failed). */
  recordProcedureFailure(id: string, recipeJson?: string, sessionId?: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const proc = this.getProcedureById(id);
    if (!proc) return false;
    
    // Check if this session has already been counted
    if (sessionId) {
      const sourceSessions = proc.sourceSessions ? proc.sourceSessions.split(",") : [];
      if (sourceSessions.includes(sessionId)) {
        return false;
      }
      sourceSessions.push(sessionId);
      const newSourceSessions = sourceSessions.join(",");
      
      const failureCount = proc.failureCount + 1;
      const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (proc.successCount - failureCount)));
      if (recipeJson !== undefined) {
        this.liveDb
          .prepare(
            `UPDATE procedures SET failure_count = ?, last_failed = ?, confidence = ?, procedure_type = 'negative', recipe_json = ?, source_sessions = ?, updated_at = ? WHERE id = ?`,
          )
          .run(failureCount, now, confidence, recipeJson, newSourceSessions, now, id);
      } else {
        this.liveDb
          .prepare(
            `UPDATE procedures SET failure_count = ?, last_failed = ?, confidence = ?, procedure_type = 'negative', source_sessions = ?, updated_at = ? WHERE id = ?`,
          )
          .run(failureCount, now, confidence, newSourceSessions, now, id);
      }
    } else {
      const failureCount = proc.failureCount + 1;
      const confidence = Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (proc.successCount - failureCount)));
      if (recipeJson !== undefined) {
        this.liveDb
          .prepare(
            `UPDATE procedures SET failure_count = ?, last_failed = ?, confidence = ?, procedure_type = 'negative', recipe_json = ?, updated_at = ? WHERE id = ?`,
          )
          .run(failureCount, now, confidence, recipeJson, now, id);
      } else {
        this.liveDb
          .prepare(
            `UPDATE procedures SET failure_count = ?, last_failed = ?, confidence = ?, procedure_type = 'negative', updated_at = ? WHERE id = ?`,
          )
          .run(failureCount, now, confidence, now, id);
      }
    }
    return true;
  }

  /** Procedures with success_count >= threshold and not yet promoted (for auto skill generation). */
  getProceduresReadyForSkill(validationThreshold: number, limit = 50): ProcedureEntry[] {
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM procedures WHERE procedure_type = 'positive' AND success_count >= ? AND promoted_to_skill = 0 ORDER BY success_count DESC, last_validated DESC LIMIT ?`,
      )
      .all(validationThreshold, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.procedureRowToEntry(r));
  }

  /** Mark procedure as promoted to skill (skill_path set). */
  markProcedurePromoted(id: string, skillPath: string): boolean {
    const result = this.liveDb
      .prepare(`UPDATE procedures SET promoted_to_skill = 1, skill_path = ?, updated_at = ? WHERE id = ?`)
      .run(skillPath, Math.floor(Date.now() / 1000), id);
    return result.changes > 0;
  }

  /** Procedures that are past TTL (last_validated older than ttl_days). For revalidation/decay. */
  getStaleProcedures(ttlDays: number, limit = 100): ProcedureEntry[] {
    const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 24 * 3600;
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM procedures WHERE last_validated < ? OR (last_validated IS NULL AND created_at < ?) ORDER BY last_validated DESC NULLS LAST LIMIT ?`,
      )
      .all(cutoff, cutoff, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.procedureRowToEntry(r));
  }

  /** Alias for pruneExpired() for backward compatibility */
  prune(): number {
    return this.pruneExpired();
  }

  /** Alias for backfillDecayClasses() for backward compatibility */
  backfillDecay(): Record<string, number> {
    return this.backfillDecayClasses();
  }

  /** Get reflection statistics */
  statsReflection(): { reflectionPatternsCount: number; reflectionRulesCount: number } {
    const patterns = this.liveDb.prepare(
      `SELECT COUNT(*) as c FROM facts WHERE category = 'pattern' AND source = 'reflection'`
    ).pluck().get() as number;
    const rules = this.liveDb.prepare(
      `SELECT COUNT(*) as c FROM facts WHERE category = 'rule' AND source = 'reflection'`
    ).pluck().get() as number;
    return { reflectionPatternsCount: patterns, reflectionRulesCount: rules };
  }

  /** Get self-correction incidents count */
  selfCorrectionIncidentsCount(): number {
    return this.liveDb.prepare(
      `SELECT COUNT(*) as c FROM facts WHERE source = 'self-correction'`
    ).pluck().get() as number;
  }

  /** Get language keywords count */
  languageKeywordsCount(): number {
    const filePath = getLanguageKeywordsFilePath();
    if (!filePath || !existsSync(filePath)) return 0;

    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      let count = 0;

      // Count translations
      const translations = data.translations ?? {};
      for (const lang of Object.values(translations)) {
        for (const [key, val] of Object.entries(lang as Record<string, unknown>)) {
          if (Array.isArray(val)) count += val.length;
        }
      }

      // Count trigger structures
      const triggerStructures = data.triggerStructures ?? {};
      for (const val of Object.values(triggerStructures)) {
        if (Array.isArray(val)) count += val.length;
      }

      // Count directive signals by category
      const directiveSignals = data.directiveSignalsByCategory ?? {};
      for (const val of Object.values(directiveSignals)) {
        if (Array.isArray(val)) count += val.length;
      }

      // Count reinforcement categories
      const reinforcementCategories = data.reinforcementCategories ?? {};
      for (const val of Object.values(reinforcementCategories)) {
        if (Array.isArray(val)) count += val.length;
      }

      return count;
    } catch {
      return 0;
    }
  }

  /** Get statistics by source */
  statsBySource(): Record<string, number> {
    const rows = this.liveDb
      .prepare(`SELECT source, COUNT(*) as count FROM facts GROUP BY source`)
      .all() as Array<{ source: string; count: number }>;
    return Object.fromEntries(rows.map((r) => [r.source, r.count]));
  }

  /** Alias for estimateStoredTokens() for backward compatibility */
  estimateTokens(): number {
    return this.estimateStoredTokens();
  }

  /** Get unique scopes in the database */
  uniqueScopes(): Array<{ scope: string; scopeTarget: string | null }> {
    const rows = this.liveDb
      .prepare(`SELECT DISTINCT scope, scope_target as scopeTarget FROM facts WHERE scope IS NOT NULL`)
      .all() as Array<{ scope: string; scopeTarget: string | null }>;
    return rows;
  }

  /** Get statistics by scope */
  scopeStats(): Array<{ scope: string; scopeTarget: string | null; count: number }> {
    const rows = this.liveDb
      .prepare(`SELECT scope, scope_target as scopeTarget, COUNT(*) as count FROM facts WHERE scope IS NOT NULL GROUP BY scope, scope_target`)
      .all() as Array<{ scope: string; scopeTarget: string | null; count: number }>;
    return rows;
  }

  /** Prune facts matching scope filter */
  pruneScopedFacts(scopeFilter: ScopeFilter): number {
    const conditions: string[] = [];
    const params: (string | null)[] = [];

    if (scopeFilter.userId !== undefined) {
      conditions.push(`(scope = 'user' AND scope_target = ?)`);
      params.push(scopeFilter.userId);
    }
    if (scopeFilter.agentId !== undefined) {
      conditions.push(`(scope = 'agent' AND scope_target = ?)`);
      params.push(scopeFilter.agentId);
    }
    if (scopeFilter.sessionId !== undefined) {
      conditions.push(`(scope = 'session' AND scope_target = ?)`);
      params.push(scopeFilter.sessionId);
    }

    if (conditions.length === 0) return 0;

    const query = `DELETE FROM facts WHERE ${conditions.join(' OR ')}`;
    const result = this.liveDb.prepare(query).run(...params);
    return result.changes;
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'db-close',
        severity: 'info',
        subsystem: 'facts'
      });
      /* already closed */
    }
  }
}
