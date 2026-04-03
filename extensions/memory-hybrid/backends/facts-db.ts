/**
 * SQLite + FTS5 backend for structured facts.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { MemoryCategory, DecayClass } from "../config.js";
import { DECAY_CLASSES, TTL_DEFAULTS } from "../config.js";
import { isValidCategory } from "../config.js";
import type {
  MemoryEntry,
  ProcedureEntry,
  SearchResult,
  MemoryTier,
  ScopeFilter,
  Episode,
  EpisodeOutcome,
} from "../types/memory.js";
import { normalizedHash, serializeTags, parseTags } from "../utils/tags.js";
import { calculateExpiry, classifyDecay } from "../utils/decay.js";
import { applyConsolidationRetrievalControls } from "../utils/consolidation-controls.js";
import { computeDynamicSalience } from "../utils/salience.js";
import { estimateTokensForDisplay } from "../utils/text.js";
import { capturePluginError } from "../services/error-reporter.js";
import { INTERACTIVE_FTS_MAX_OR_TERMS } from "../utils/constants.js";
import { getLanguageKeywordsFilePath } from "../utils/language-keywords.js";
import { createTransaction } from "../utils/sqlite-transaction.js";
import { tryRestrictSqliteDbFileMode } from "../utils/sqlite-file-perms.js";
import { runFactsMigrations } from "./migrations/facts-migrations.js";
import { searchFts } from "../services/fts-search.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";
import { SupersededTextsCache } from "./facts-db/cache-manager.js";
import { verifyFts5Support } from "./facts-db/db-connection.js";
import {
  buildClassificationFtsOrClause,
  buildFactsSearchFtsOrClause,
  fetchSupersededFactTextsLower,
} from "./facts-db/fact-queries.js";
import { sanitizeFts5QueryForFacts } from "./facts-db/fts-text.js";
import {
  batchGetReinforcementEvents as batchGetReinforcementEventsHelper,
  boostConfidence as boostConfidenceHelper,
  calculateDiversityScore as calculateDiversityScoreHelper,
  getReinforcementEvents as getReinforcementEventsHelper,
  reinforceFact as reinforceFactHelper,
  reinforceProcedure as reinforceProcedureHelper,
  computeDiversityFromEvents as computeDiversityFromEventsHelper,
} from "./facts-db/reinforcement.js";
import {
  createLink as createLinkHelper,
  createOrStrengthenRelatedLink as createOrStrengthenRelatedLinkHelper,
  expandGraphWithCTE as expandGraphWithCTEHelper,
  getConnectedFactIds as getConnectedFactIdsHelper,
  getLinksFrom as getLinksFromHelper,
  getLinksTo as getLinksToHelper,
  strengthenRelatedLinksBatch as strengthenRelatedLinksBatchHelper,
} from "./facts-db/links.js";
import {
  getScanCursor as getScanCursorHelper,
  migrateScanCursorsTable as migrateScanCursorsTableHelper,
  updateScanCursor as updateScanCursorHelper,
} from "./facts-db/scan-cursors.js";
import {
  replaceFactEntityMentions,
  getOrganizationByKeyOrName as lookupOrganizationByKeyOrName,
  listContactsForOrg as entityLayerListContactsForOrg,
  listContactsByNamePrefix as entityLayerListContactsByNamePrefix,
  listFactIdsForOrg as entityLayerListFactIdsForOrg,
  listFactsNeedingEnrichment as entityLayerListFactsNeedingEnrichment,
  type ContactRow,
  type OrganizationRow,
} from "./facts-db/entity-layer.js";
import type { ExtractedMention } from "../services/entity-enrichment.js";
export {
  MEMORY_LINK_TYPES,
  type MemoryLinkType,
  type ReinforcementContext,
} from "./facts-db/types.js";
import type { MemoryLinkType, ReinforcementContext, ReinforcementEvent } from "./facts-db/types.js";

/** Allowlisted tier values for dynamic SQL fragments in list()/dashboard filters (#842). */
const DASHBOARD_TIER_FILTER = new Set<string>(["warm", "hot", "cold"]);
const DECAY_CLASS_FILTER = new Set<string>(DECAY_CLASSES);

/** A single contradiction record (from the contradictions table). */
export interface ContradictionRecord {
  id: string;
  factIdNew: string;
  factIdOld: string;
  detectedAt: string;
  resolved: boolean;
  resolution: "superseded" | "kept" | "merged" | null;
  oldFactOriginalConfidence?: number;
}

export class FactsDB extends BaseSqliteStore {
  // Responsibility note:
  // - This class is the stable API boundary.
  // - Extracted implementation modules under backends/facts-db/ own links/reinforcement/scan-cursor logic.
  private readonly dbPath: string;
  private readonly fuzzyDedupe: boolean;
  private readonly supersededTextsCacheMgr = new SupersededTextsCache(5 * 60_000);
  private knownEntitiesCache: string[] | null = null;
  private knownEntitiesCacheTime = 0;
  /** Cache TTL for known-entity list used by autoLinkEntities on every write. */
  private readonly KNOWN_ENTITIES_CACHE_TTL_MS = 30_000; // 30 seconds

  constructor(dbPath: string, options?: { fuzzyDedupe?: boolean }) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);

    try {
      FactsDB.verifyFts5Support(db);
    } catch (err) {
      try {
        db.close();
      } catch {
        // Ignore close errors during failure cleanup
      }
      throw err;
    }

    super(db, {
      foreignKeys: true,
      customPragmas: ["PRAGMA synchronous = NORMAL", "PRAGMA wal_autocheckpoint = 1000"],
    });
    this.dbPath = dbPath;
    tryRestrictSqliteDbFileMode(dbPath);
    this.fuzzyDedupe = options?.fuzzyDedupe ?? false;

    // Create main table
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        why TEXT,
        category TEXT NOT NULL DEFAULT 'other',
        importance REAL NOT NULL DEFAULT 0.5,
        entity TEXT,
        key TEXT,
        value TEXT,
        source TEXT NOT NULL DEFAULT 'conversation',
        created_at INTEGER NOT NULL
      )
    `);

    // Create FTS5 virtual table for full-text search.
    // NOTE: tags column is added later by migrateFtsTagsSupport() once the facts.tags
    // column exists (via migrateTagsColumn). For brand-new databases the FTS5 starts
    // without tags and is immediately upgraded by the migration sequence.
    // porter stemmer indexes stemmed forms; user MATCH strings from sanitizeFts5QueryForFacts / fts-search
    // use quoted tokens — see fts-search buildFts5Query() notes on tokenizer alignment (#898).
    this.liveDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        text,
        category,
        entity,
        key,
        value,
        tokenize='porter unicode61'
      )
    `);

    // Triggers to keep FTS in sync (without tags — upgraded by migrateFtsTagsSupport)
    this.liveDb.exec(`
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, text, category, entity, key, value)
        VALUES (new.rowid, new.text, new.category, new.entity, new.key, new.value);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        DELETE FROM facts_fts WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        DELETE FROM facts_fts WHERE rowid = old.rowid;
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

    // Run all schema migrations
    runFactsMigrations(this.liveDb);
  }

  /**
   * Hard-startup guard for SQLite FTS5 support.
   *
   * Some Node.js/SQLite builds can run without FTS5 enabled, which would cause
   * hybrid retrieval to silently degrade to vector-only once the FTS strategy
   * starts failing. Probe FTS5 explicitly and fail fast with an actionable error.
   */
  /** @deprecated Prefer importing `verifyFts5Support` from `./facts-db/db-connection.js` (kept for tests). */
  static verifyFts5Support(db: DatabaseSync): void {
    verifyFts5Support(db);
  }

  /** Create reinforcement_log table for per-event context (#259). */
  private migrateReinforcementLogTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS reinforcement_log (
        id TEXT PRIMARY KEY,
        fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        signal TEXT NOT NULL DEFAULT 'positive',
        query_snippet TEXT,
        topic TEXT,
        tool_sequence TEXT,
        session_file TEXT,
        occurred_at INTEGER NOT NULL
      )
    `);
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_rl_fact_id ON reinforcement_log(fact_id)");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_rl_occurred ON reinforcement_log(occurred_at)");

    // Idempotent migration: add FK constraint to existing tables that pre-date this migration.
    // SQLite does not support ALTER TABLE ADD CONSTRAINT, so we use RENAME-RECREATE-INSERT-DROP.
    const fkList = this.liveDb.prepare("PRAGMA foreign_key_list(reinforcement_log)").all() as Array<{
      table: string;
      from: string;
    }>;
    const hasFk = fkList.some((fk) => fk.from === "fact_id" && fk.table === "facts");
    if (!hasFk) {
      createTransaction(this.liveDb, () => {
        this.liveDb.exec("ALTER TABLE reinforcement_log RENAME TO reinforcement_log_v1");
        this.liveDb.exec(`
          CREATE TABLE reinforcement_log (
            id TEXT PRIMARY KEY,
            fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
            signal TEXT NOT NULL DEFAULT 'positive',
            query_snippet TEXT,
            topic TEXT,
            tool_sequence TEXT,
            session_file TEXT,
            occurred_at INTEGER NOT NULL
          )
        `);
        // Copy only rows whose fact_id still exists (orphans are dropped).
        this.liveDb.exec(
          "INSERT INTO reinforcement_log SELECT * FROM reinforcement_log_v1 WHERE fact_id IN (SELECT id FROM facts)",
        );
        this.liveDb.exec("DROP TABLE reinforcement_log_v1");
        this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_rl_fact_id ON reinforcement_log(fact_id)");
        this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_rl_occurred ON reinforcement_log(occurred_at)");
      })();
    }
  }

  /** Change reinforced_count from INTEGER to REAL to support fractional boost amounts (#259, #260).
   *  The entire migration per table is wrapped in a transaction so a failure mid-step leaves the
   *  DB in a consistent state and the migration can be retried on the next startup.
   *  Requires SQLite >= 3.35 for ALTER TABLE … DROP COLUMN.
   */
  private migrateReinforcedCountToReal(): void {
    const factsCols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string; type: string }>;
    const factsReinforcedCol = factsCols.find((c) => c.name === "reinforced_count");
    if (factsReinforcedCol && factsReinforcedCol.type !== "REAL") {
      createTransaction(this.liveDb, () => {
        this.liveDb.exec("DROP INDEX IF EXISTS idx_facts_reinforced");
        this.liveDb.exec("ALTER TABLE facts ADD COLUMN reinforced_count_real REAL NOT NULL DEFAULT 0");
        this.liveDb.exec("UPDATE facts SET reinforced_count_real = CAST(reinforced_count AS REAL)");
        this.liveDb.exec("ALTER TABLE facts DROP COLUMN reinforced_count");
        this.liveDb.exec("ALTER TABLE facts RENAME COLUMN reinforced_count_real TO reinforced_count");
        this.liveDb.exec(
          "CREATE INDEX IF NOT EXISTS idx_facts_reinforced ON facts(reinforced_count) WHERE reinforced_count > 0",
        );
      })();
    }

    const proceduresCols = this.liveDb.prepare("PRAGMA table_info(procedures)").all() as Array<{
      name: string;
      type: string;
    }>;
    const proceduresReinforcedCol = proceduresCols.find((c) => c.name === "reinforced_count");
    if (proceduresReinforcedCol && proceduresReinforcedCol.type !== "REAL") {
      createTransaction(this.liveDb, () => {
        this.liveDb.exec("DROP INDEX IF EXISTS idx_procedures_reinforced");
        this.liveDb.exec("ALTER TABLE procedures ADD COLUMN reinforced_count_real REAL NOT NULL DEFAULT 0");
        this.liveDb.exec("UPDATE procedures SET reinforced_count_real = CAST(reinforced_count AS REAL)");
        this.liveDb.exec("ALTER TABLE procedures DROP COLUMN reinforced_count");
        this.liveDb.exec("ALTER TABLE procedures RENAME COLUMN reinforced_count_real TO reinforced_count");
        this.liveDb.exec(
          "CREATE INDEX IF NOT EXISTS idx_procedures_reinforced ON procedures(reinforced_count) WHERE reinforced_count > 0",
        );
      })();
    }
  }

  /** Create implicit_signals table for behavioral feedback signals (#262). */
  private migrateImplicitSignalsTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS implicit_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_file TEXT,
        signal_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        polarity TEXT NOT NULL,
        user_message TEXT,
        agent_message TEXT,
        preceding_turns INTEGER,
        source TEXT DEFAULT 'implicit',
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_is_created ON implicit_signals(created_at)");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_is_polarity ON implicit_signals(polarity)");
    this.liveDb.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_is_unique ON implicit_signals(session_file, signal_type, user_message, polarity)",
    );
  }

  /** Create feedback_trajectories table for multi-turn task sequence learning (#262). */
  private migrateFeedbackTrajectoriesTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS feedback_trajectories (
        id TEXT PRIMARY KEY,
        session_file TEXT,
        turns_json TEXT,
        outcome TEXT,
        outcome_signal TEXT,
        key_pivot INTEGER,
        lessons_json TEXT,
        topic TEXT,
        tools_used TEXT,
        turn_count INTEGER,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_ft_session ON feedback_trajectories(session_file)");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_ft_outcome ON feedback_trajectories(outcome)");
  }

  /** Create feedback_effectiveness table for closed-loop rule measurement (#262). */
  private migrateFeedbackEffectivenessTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS feedback_effectiveness (
        rule_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
        rule_text TEXT,
        created_at INTEGER,
        window_start INTEGER,
        window_end INTEGER,
        corrections_before INTEGER DEFAULT 0,
        corrections_after INTEGER DEFAULT 0,
        praise_before INTEGER DEFAULT 0,
        praise_after INTEGER DEFAULT 0,
        implicit_positive_before INTEGER DEFAULT 0,
        implicit_positive_after INTEGER DEFAULT 0,
        implicit_negative_before INTEGER DEFAULT 0,
        implicit_negative_after INTEGER DEFAULT 0,
        effect_score REAL DEFAULT 0.0,
        confidence REAL DEFAULT 0.0,
        sample_size INTEGER DEFAULT 0,
        measured_at INTEGER DEFAULT (unixepoch())
      )
    `);
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_fe_measured ON feedback_effectiveness(measured_at)");

    // Idempotent migration: add FK constraint to existing tables that pre-date this migration.
    const fkList = this.liveDb.prepare("PRAGMA foreign_key_list(feedback_effectiveness)").all() as Array<{
      table: string;
      from: string;
    }>;
    const hasFk = fkList.some((fk) => fk.from === "rule_id" && fk.table === "facts");
    if (!hasFk) {
      createTransaction(this.liveDb, () => {
        this.liveDb.exec("ALTER TABLE feedback_effectiveness RENAME TO feedback_effectiveness_v1");
        this.liveDb.exec(`
          CREATE TABLE feedback_effectiveness (
            rule_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
            rule_text TEXT,
            created_at INTEGER,
            window_start INTEGER,
            window_end INTEGER,
            corrections_before INTEGER DEFAULT 0,
            corrections_after INTEGER DEFAULT 0,
            praise_before INTEGER DEFAULT 0,
            praise_after INTEGER DEFAULT 0,
            implicit_positive_before INTEGER DEFAULT 0,
            implicit_positive_after INTEGER DEFAULT 0,
            implicit_negative_before INTEGER DEFAULT 0,
            implicit_negative_after INTEGER DEFAULT 0,
            effect_score REAL DEFAULT 0.0,
            confidence REAL DEFAULT 0.0,
            sample_size INTEGER DEFAULT 0,
            measured_at INTEGER DEFAULT (unixepoch())
          )
        `);
        // Copy only rows whose rule_id still references a valid fact (orphans are dropped).
        this.liveDb.exec(
          "INSERT INTO feedback_effectiveness SELECT * FROM feedback_effectiveness_v1 WHERE rule_id IN (SELECT id FROM facts)",
        );
        this.liveDb.exec("DROP TABLE feedback_effectiveness_v1");
        this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_fe_measured ON feedback_effectiveness(measured_at)");
      })();
    }
  }

  /** Create scan_cursors table for watermark-based incremental processing (#288). */
  private migrateScanCursorsTable(): void {
    migrateScanCursorsTableHelper(this.liveDb);
  }

  /** Add access_count and last_accessed_at columns for salience scoring (#237).
   *  access_count is backfilled from recall_count.
   *  last_accessed_at (ISO 8601 TEXT) is backfilled from last_accessed (epoch INTEGER).
   */
  private migrateAccessCountAndLastAccessedAt(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));

    if (!colNames.has("access_count")) {
      this.liveDb.exec("ALTER TABLE facts ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
      // Backfill from recall_count so existing access history is preserved
      this.liveDb.exec("UPDATE facts SET access_count = COALESCE(recall_count, 0)");
      this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_facts_access_count ON facts(access_count)");
    }

    if (!colNames.has("last_accessed_at")) {
      this.liveDb.exec("ALTER TABLE facts ADD COLUMN last_accessed_at TEXT");
      // Backfill from last_accessed (epoch seconds → ISO 8601)
      this.liveDb.exec(
        `UPDATE facts SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%SZ', last_accessed, 'unixepoch') WHERE last_accessed IS NOT NULL`,
      );
      // Partial index (#885): optimizes lookups for non-NULL last_accessed_at. Queries that need rows
      // WHERE last_accessed_at IS NULL cannot use this index and may use a different query plan.
      this.liveDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_facts_last_accessed_at ON facts(last_accessed_at) WHERE last_accessed_at IS NOT NULL",
      );
    }
  }

  /** Return the cursor for the given scan type, or null if never run. */
  getScanCursor(scanType: string): { lastSessionTs: number; lastRunAt: number; sessionsProcessed: number } | null {
    return getScanCursorHelper(this.liveDb, scanType);
  }

  /**
   * Upsert the cursor after a successful incremental scan.
   * @param lastSessionTs Timestamp of the newest session processed (file mtime). Pass `Date.now()`
   *   when no session watermark is available (e.g. self-correction). Pass `0` when no sessions
   *   were processed — `last_session_ts` will not be updated in that case.
   * @param sessionsProcessed Number of sessions processed in this run.
   */
  updateScanCursor(scanType: string, lastSessionTs: number, sessionsProcessed: number): void {
    updateScanCursorHelper(this.liveDb, scanType, lastSessionTs, sessionsProcessed);
  }

  /** Add reinforcement tracking columns (reinforced_count, last_reinforced_at, reinforced_quotes). */
  private migrateReinforcementColumns(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("reinforced_count")) return;
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN reinforced_count INTEGER NOT NULL DEFAULT 0");
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN last_reinforced_at INTEGER");
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN reinforced_quotes TEXT"); // JSON array of strings
    this.liveDb.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_reinforced ON facts(reinforced_count) WHERE reinforced_count > 0",
    );
  }

  /** Add tier column; default 'warm' for existing rows. */
  private migrateTierColumn(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "tier")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN tier TEXT DEFAULT 'warm'`);
    this.liveDb.exec(`UPDATE facts SET tier = 'warm' WHERE tier IS NULL`);
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_facts_tier ON facts(tier) WHERE tier IS NOT NULL");
  }

  /** Add scope and scope_target columns for memory scoping. */
  private migrateScopeColumns(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("scope")) return;
    this.liveDb.exec(`ALTER TABLE facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`);
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN scope_target TEXT");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope)");
    this.liveDb.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_scope_target ON facts(scope, scope_target) WHERE scope_target IS NOT NULL",
    );
  }

  /** Procedural memory: add procedure_type, success_count, last_validated, source_sessions to facts. */
  private migrateProcedureColumns(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("procedure_type")) return;
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN procedure_type TEXT");
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN success_count INTEGER DEFAULT 0");
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN last_validated INTEGER");
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN source_sessions TEXT");
    this.liveDb.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_procedure_type ON facts(procedure_type) WHERE procedure_type IS NOT NULL",
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
    const cols = this.liveDb.prepare("PRAGMA table_info(procedures)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("source_sessions")) {
      this.liveDb.exec("ALTER TABLE procedures ADD COLUMN source_sessions TEXT");
    }
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_procedures_type ON procedures(procedure_type)");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_procedures_validated ON procedures(last_validated)");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_procedures_confidence ON procedures(confidence)");
    this.liveDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS procedures_fts USING fts5(
        task_pattern,
        tokenize='porter unicode61'
      )
    `);
    this.liveDb.exec(`
      CREATE TRIGGER IF NOT EXISTS procedures_fts_ai AFTER INSERT ON procedures BEGIN
        INSERT INTO procedures_fts(rowid, task_pattern) VALUES (new.rowid, new.task_pattern);
      END;
      CREATE TRIGGER IF NOT EXISTS procedures_fts_ad AFTER DELETE ON procedures BEGIN
        DELETE FROM procedures_fts WHERE rowid = old.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS procedures_fts_au AFTER UPDATE ON procedures BEGIN
        DELETE FROM procedures_fts WHERE rowid = old.rowid;
        INSERT INTO procedures_fts(rowid, task_pattern) VALUES (new.rowid, new.task_pattern);
      END
    `);
  }

  /** Phase 2: Add reinforcement tracking columns to procedures table (same pattern as facts). */
  private migrateReinforcementColumnsProcedures(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(procedures)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("reinforced_count")) return;
    this.liveDb.exec("ALTER TABLE procedures ADD COLUMN reinforced_count INTEGER NOT NULL DEFAULT 0");
    this.liveDb.exec("ALTER TABLE procedures ADD COLUMN last_reinforced_at INTEGER");
    this.liveDb.exec("ALTER TABLE procedures ADD COLUMN reinforced_quotes TEXT"); // JSON array of strings
    this.liveDb.exec("ALTER TABLE procedures ADD COLUMN promoted_at INTEGER"); // When auto-promoted via reinforcement
    this.liveDb.exec(
      "CREATE INDEX IF NOT EXISTS idx_procedures_reinforced ON procedures(reinforced_count) WHERE reinforced_count > 0",
    );
  }

  /** Add scope and scope_target columns to procedures table (same pattern as facts). */
  private migrateProcedureScopeColumns(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(procedures)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    // Check both columns independently, not just scope
    if (!colNames.has("scope")) {
      this.liveDb.exec(`ALTER TABLE procedures ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`);
    }
    if (!colNames.has("scope_target")) {
      this.liveDb.exec("ALTER TABLE procedures ADD COLUMN scope_target TEXT");
    }
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_procedures_scope ON procedures(scope)");
    this.liveDb.exec(
      "CREATE INDEX IF NOT EXISTS idx_procedures_scope_target ON procedures(scope, scope_target) WHERE scope_target IS NOT NULL",
    );
  }

  /** Create contradictions table for tracking conflicting facts (Issue #157). */
  private migrateContradictionsTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS contradictions (
        id TEXT PRIMARY KEY,
        fact_id_new TEXT NOT NULL,
        fact_id_old TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolution TEXT,
        FOREIGN KEY (fact_id_new) REFERENCES facts(id) ON DELETE CASCADE,
        FOREIGN KEY (fact_id_old) REFERENCES facts(id) ON DELETE CASCADE
      )
    `);
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_contradictions_new ON contradictions(fact_id_new)");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_contradictions_old ON contradictions(fact_id_old)");
    this.liveDb.exec(
      "CREATE INDEX IF NOT EXISTS idx_contradictions_resolved ON contradictions(resolved) WHERE resolved = 0",
    );

    // Add old_fact_original_confidence column if it doesn't exist (for unbiased comparison)
    const cols = this.liveDb.prepare("PRAGMA table_info(contradictions)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "old_fact_original_confidence")) {
      this.liveDb.exec("ALTER TABLE contradictions ADD COLUMN old_fact_original_confidence REAL");
    }
  }

  /** Create recall_log table for memory_recall hit-rate tracking (Issue #148). */
  private migrateRecallLog(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS recall_log (
        id TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        hit INTEGER NOT NULL CHECK(hit IN (0, 1))
      )
    `);
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_recall_log_time ON recall_log(occurred_at)");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_recall_log_hit ON recall_log(hit)");
  }

  /** Add embedding_model column to facts for tracking vector provenance (Issue #153). */
  private migrateEmbeddingModelColumn(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "embedding_model")) return;
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN embedding_model TEXT");
    this.liveDb.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_embedding_model ON facts(embedding_model) WHERE embedding_model IS NOT NULL",
    );
  }

  /** Store active embedding provider+model metadata (Issue #153). */
  private migrateEmbeddingMetaTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  /** Add decay_freeze_until column for future-date freeze protection (#144). */
  private migrateDecayFreezeColumn(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "decay_freeze_until")) return;
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN decay_freeze_until INTEGER DEFAULT NULL");
    this.liveDb.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_freeze ON facts(decay_freeze_until) WHERE decay_freeze_until IS NOT NULL",
    );
  }

  /**
   * Create the fact_embeddings table for multi-model embedding storage (Issue #158).
   * Idempotent — safe to call on existing databases.
   */
  private migrateFactEmbeddingsTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS fact_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_id TEXT NOT NULL,
        model TEXT NOT NULL,
        variant TEXT NOT NULL DEFAULT 'canonical',
        embedding BLOB NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(fact_id, model, variant),
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
      )
    `);
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_fact_embeddings_fact_id ON fact_embeddings(fact_id)");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_fact_embeddings_model ON fact_embeddings(model)");
  }

  // ---------------------------------------------------------------------------
  // Contextual variants storage (Issue #159)
  // ---------------------------------------------------------------------------

  /**
   * Create the fact_variants table for contextual variant text storage (Issue #159).
   * Idempotent — safe to call on existing databases.
   */
  private migrateFactVariantsTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS fact_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_id TEXT NOT NULL,
        variant_type TEXT NOT NULL DEFAULT 'contextual',
        variant_text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
      )
    `);
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_fact_variants_fact_id ON fact_variants(fact_id)");
  }

  /** Add provenance columns to facts table (Issue #163). All nullable. Use provenance_session (not source_session) to avoid confusion with source_sessions. */
  private migrateProvenanceColumns(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("provenance_session")) {
      this.liveDb.exec("ALTER TABLE facts ADD COLUMN provenance_session TEXT");
      if (colNames.has("source_session")) {
        this.liveDb.exec("UPDATE facts SET provenance_session = source_session WHERE source_session IS NOT NULL");
      }
    }
    if (!colNames.has("source_turn")) {
      this.liveDb.exec("ALTER TABLE facts ADD COLUMN source_turn INTEGER");
    }
    if (!colNames.has("extraction_method")) {
      this.liveDb.exec("ALTER TABLE facts ADD COLUMN extraction_method TEXT");
    }
    if (!colNames.has("extraction_confidence")) {
      this.liveDb.exec("ALTER TABLE facts ADD COLUMN extraction_confidence REAL");
    }
  }

  /** Create verified_facts table for critical fact verification (Issue #162). */
  private migrateVerifiedFactsTable(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS verified_facts (
        id TEXT PRIMARY KEY,
        fact_id TEXT NOT NULL,
        canonical_text TEXT NOT NULL,
        checksum TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        verified_by TEXT NOT NULL,
        next_verification TEXT,
        version INTEGER DEFAULT 1,
        previous_version_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_verified_facts_fact_id ON verified_facts(fact_id);
      CREATE INDEX IF NOT EXISTS idx_verified_facts_next_verification ON verified_facts(next_verification);
    `);
    // Run FK back-fill for DBs created before the FK was added to the schema.
    // For new DBs (table just created above with FK) this is a no-op — the guard
    // inside migrateVerifiedFactsAddFk detects the FK and returns immediately.
    this.migrateVerifiedFactsAddFk();
  }

  /** Add FK to verified_facts for existing DBs created before FK was in schema. Idempotent. */
  private migrateVerifiedFactsAddFk(): void {
    const tableInfo = this.liveDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verified_facts'")
      .get();
    if (!tableInfo) return;
    const fkCheck = this.liveDb.prepare("PRAGMA foreign_key_list(verified_facts)").all() as Array<{ table: string }>;
    if (Array.isArray(fkCheck) && fkCheck.length > 0) return; // FK already present — nothing to do
    createTransaction(this.liveDb, () => {
      this.liveDb.exec(`
        CREATE TABLE verified_facts_new (
          id TEXT PRIMARY KEY,
          fact_id TEXT NOT NULL,
          canonical_text TEXT NOT NULL,
          checksum TEXT NOT NULL,
          verified_at TEXT NOT NULL,
          verified_by TEXT NOT NULL,
          next_verification TEXT,
          version INTEGER DEFAULT 1,
          previous_version_id TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
        );
        INSERT INTO verified_facts_new SELECT * FROM verified_facts;
        DROP TABLE verified_facts;
        ALTER TABLE verified_facts_new RENAME TO verified_facts;
        CREATE INDEX IF NOT EXISTS idx_verified_facts_fact_id ON verified_facts(fact_id);
        CREATE INDEX IF NOT EXISTS idx_verified_facts_next_verification ON verified_facts(next_verification);
      `);
    })();
  }

  /**
   * Store a contextual variant text for a fact.
   * Returns the new row id.
   */
  storeVariant(factId: string, variantType: string, variantText: string): number {
    const result = this.liveDb
      .prepare(
        `INSERT INTO fact_variants (fact_id, variant_type, variant_text)
         VALUES (?, ?, ?)`,
      )
      .run(factId, variantType, variantText);
    return result.lastInsertRowid as number;
  }

  /**
   * Retrieve all variants stored for a given fact.
   */
  getVariants(factId: string): Array<{ id: number; variantType: string; variantText: string; createdAt: string }> {
    return (
      this.liveDb
        .prepare("SELECT id, variant_type, variant_text, created_at FROM fact_variants WHERE fact_id = ?")
        .all(factId) as Array<{
        id: number;
        variant_type: string;
        variant_text: string;
        created_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      variantType: r.variant_type,
      variantText: r.variant_text,
      createdAt: r.created_at,
    }));
  }

  /**
   * Check whether a fact already has variants stored (to avoid re-processing).
   */
  hasVariants(factId: string): boolean {
    const row = this.liveDb.prepare("SELECT 1 FROM fact_variants WHERE fact_id = ? LIMIT 1").get(factId);
    return row !== undefined;
  }

  /**
   * Delete all variants for a fact (called when a fact is deleted).
   * Normally handled by ON DELETE CASCADE, but exposed for explicit use.
   */
  deleteVariants(factId: string): void {
    this.liveDb.prepare("DELETE FROM fact_variants WHERE fact_id = ?").run(factId);
  }

  // ---------------------------------------------------------------------------
  // Multi-model embedding storage (Issue #158)
  // ---------------------------------------------------------------------------

  /**
   * Store or replace an embedding vector for a fact+model+variant combination.
   * The embedding is stored as a BLOB (raw Float32Array bytes for portability).
   */
  storeEmbedding(factId: string, model: string, variant: string, embedding: Float32Array, dimensions: number): void {
    const blob = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.liveDb
      .prepare(
        `INSERT INTO fact_embeddings (fact_id, model, variant, embedding, dimensions)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fact_id, model, variant) DO UPDATE SET
           embedding = excluded.embedding,
           dimensions = excluded.dimensions,
           created_at = datetime('now')`,
      )
      .run(factId, model, variant, blob, dimensions);
  }

  /**
   * Copy a Buffer (which may have unaligned byteOffset) into a Float32Array.
   * Node.js Buffers from node:sqlite can share a pooled ArrayBuffer with
   * byteOffset not divisible by 4, which would make Float32Array constructor throw.
   */
  private static bufferToFloat32Array(buf: Buffer): Float32Array {
    const byteLen = buf.byteLength;
    const ab = new ArrayBuffer(byteLen);
    new Uint8Array(ab).set(new Uint8Array(buf.buffer, buf.byteOffset, byteLen));
    return new Float32Array(ab);
  }

  /**
   * Retrieve all embeddings stored for a given fact (all models/variants).
   */
  getEmbeddings(factId: string): Array<{ model: string; variant: string; embedding: Float32Array }> {
    const rows = this.liveDb
      .prepare("SELECT model, variant, embedding FROM fact_embeddings WHERE fact_id = ?")
      .all(factId) as Array<{ model: string; variant: string; embedding: Buffer }>;
    return rows.map((r) => ({
      model: r.model,
      variant: r.variant,
      embedding: FactsDB.bufferToFloat32Array(r.embedding),
    }));
  }

  /**
   * Retrieve embeddings for a specific model. When limit is set, returns the most recent
   * (by fact_embeddings.id DESC) to avoid excluding recent facts when capping for performance.
   */
  getEmbeddingsByModel(model: string, limit?: number): Array<{ factId: string; embedding: Float32Array }> {
    const sql =
      limit != null
        ? `SELECT fact_id, embedding FROM fact_embeddings WHERE model = ? AND variant = 'canonical' ORDER BY id DESC LIMIT ?`
        : `SELECT fact_id, embedding FROM fact_embeddings WHERE model = ? AND variant = 'canonical'`;
    const rows = (
      limit != null ? this.liveDb.prepare(sql).all(model, limit) : this.liveDb.prepare(sql).all(model)
    ) as Array<{ fact_id: string; embedding: Buffer }>;
    return rows.map((r) => ({
      factId: r.fact_id,
      embedding: FactsDB.bufferToFloat32Array(r.embedding),
    }));
  }

  /**
   * Delete all embeddings for a fact (called when a fact is deleted).
   * Normally handled by the ON DELETE CASCADE FK, but exposed for explicit use.
   */
  deleteEmbeddings(factId: string): void {
    this.liveDb.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?").run(factId);
  }

  /**
   * Migrate the FTS5 virtual table to include the `tags` column (Issue #151).
   * FTS5 virtual tables cannot be altered, so we drop and recreate if tags are absent.
   * The entire migration is wrapped in a transaction so a crash mid-migration leaves the
   * DB in a consistent state (either old schema intact, or new schema + backfill complete).
   */
  private migrateFtsTagsSupport(): void {
    const row = this.liveDb.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='facts_fts'`).get() as
      | { sql: string }
      | undefined;

    // If the CREATE statement already contains 'tags', nothing to do.
    if (row?.sql?.includes("tags")) return;

    // Wrap the entire migration in a transaction so any failure leaves the DB consistent.
    const migrate = createTransaction(this.liveDb, () => {
      // Drop old triggers first (they reference the old column list).
      this.liveDb.exec(`
        DROP TRIGGER IF EXISTS facts_ai;
        DROP TRIGGER IF EXISTS facts_ad;
        DROP TRIGGER IF EXISTS facts_au;
      `);

      // Drop and recreate FTS5 with tags included.
      this.liveDb.exec("DROP TABLE IF EXISTS facts_fts");
      this.liveDb.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
          text,
          category,
          entity,
          tags,
          key,
          value,
          tokenize='porter unicode61'
        )
      `);

      // Recreate triggers with tags column.
      this.liveDb.exec(`
        CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
          INSERT INTO facts_fts(rowid, text, category, entity, tags, key, value)
          VALUES (new.rowid, new.text, new.category, new.entity, new.tags, new.key, new.value);
        END;

        CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
          DELETE FROM facts_fts WHERE rowid = old.rowid;
        END;

        CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
          DELETE FROM facts_fts WHERE rowid = old.rowid;
          INSERT INTO facts_fts(rowid, text, category, entity, tags, key, value)
          VALUES (new.rowid, new.text, new.category, new.entity, new.tags, new.key, new.value);
        END
      `);

      // Backfill existing facts into the new FTS index.
      this.liveDb.exec(`
        INSERT INTO facts_fts(rowid, text, category, entity, tags, key, value)
        SELECT rowid, text, category, entity, tags, key, value FROM facts
      `);
    });
    migrate();
  }

  /**
   * Build SQL fragment for scope filtering. Uses named params @scopeUserId, @scopeAgentId, @scopeSessionId.
   * ⚠️ SECURITY: Callers MUST derive scope filter values from trusted runtime identity (authenticated user/agent/session).
   * Do NOT pass arbitrary caller-controlled tool/CLI parameters here — that enables cross-tenant data leakage
   * (attacker can pass userId: "alice" to access alice's private memories). Use autoRecall.scopeFilter from config
   * (set by integration layer) rather than user-supplied parameters. See docs/MEMORY-SCOPING.md.
   */
  private scopeFilterClause(filter: ScopeFilter | null | undefined): {
    clause: string;
    params: Record<string, unknown>;
  } {
    if (!filter || (!filter.userId && !filter.agentId && !filter.sessionId)) {
      return { clause: "", params: {} };
    }
    const parts: string[] = ["("];
    parts.push("scope = 'global'");
    const params: Record<string, unknown> = {};
    if (filter.userId) {
      parts.push("OR (scope = 'user' AND scope_target = @scopeUserId)");
      params["@scopeUserId"] = filter.userId;
    }
    if (filter.agentId) {
      parts.push("OR (scope = 'agent' AND scope_target = @scopeAgentId)");
      params["@scopeAgentId"] = filter.agentId;
    }
    if (filter.sessionId) {
      parts.push("OR (scope = 'session' AND scope_target = @scopeSessionId)");
      params["@scopeSessionId"] = filter.sessionId;
    }
    parts.push(")");
    return { clause: `AND ${parts.join(" ")}`, params };
  }

  /**
   * Build SQL fragment for scope filtering with positional params (for lookup/getAll).
   * Same security constraints as scopeFilterClause — derive from trusted identity only.
   */
  private scopeFilterClausePositional(filter: ScopeFilter | null | undefined): {
    clause: string;
    params: SQLInputValue[];
  } {
    if (!filter || (!filter.userId && !filter.agentId && !filter.sessionId)) {
      return { clause: "", params: [] };
    }
    const parts: string[] = ["("];
    parts.push("scope = 'global'");
    const params: SQLInputValue[] = [];
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
    return { clause: ` AND ${parts.join(" ")}`, params };
  }

  private migrateTagsColumn(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "tags")) return;
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN tags TEXT");
    this.liveDb.exec(`CREATE INDEX IF NOT EXISTS idx_facts_tags ON facts(tags) WHERE tags IS NOT NULL AND tags != ''`);
  }

  /** Add recall_count and last_accessed for dynamic salience scoring. */
  private migrateAccessTracking(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("recall_count")) return;
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0");
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN last_accessed INTEGER");
    this.liveDb.exec("UPDATE facts SET last_accessed = last_confirmed_at WHERE last_accessed IS NULL");
    this.liveDb.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_last_accessed ON facts(last_accessed) WHERE last_accessed IS NOT NULL",
    );
  }

  /** Add superseded_at and superseded_by for contradiction resolution. */
  private migrateSupersessionColumns(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("superseded_at")) return;
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN superseded_at INTEGER");
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN superseded_by TEXT");
    this.liveDb.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_superseded ON facts(superseded_at) WHERE superseded_at IS NOT NULL",
    );
  }

  /** Bi-temporal columns valid_from, valid_until, supersedes_id for point-in-time queries. */
  private migrateBiTemporalColumns(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("valid_from")) return;
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN valid_from INTEGER");
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN valid_until INTEGER");
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN supersedes_id TEXT");
    this.liveDb.exec(
      "UPDATE facts SET valid_from = COALESCE(source_date, created_at), valid_until = NULL, supersedes_id = NULL WHERE valid_from IS NULL",
    );
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_facts_valid_range ON facts(valid_from, valid_until)");
  }

  /** Create memory_links table for graph-based spreading activation. */
  private migrateMemoryLinksTable(): void {
    const tableExists = this.liveDb
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_links'`)
      .get();

    if (tableExists) {
      // Use PRAGMA foreign_key_list to check for a CASCADE FK on target_fact_id.
      // This is immune to DDL formatting variations across plugin versions.
      const fkList = this.liveDb.prepare("PRAGMA foreign_key_list(memory_links)").all() as Array<{
        table: string;
        from: string;
        on_delete: string;
      }>;
      const hasTargetCascade = fkList.some(
        (fk) => fk.from === "target_fact_id" && fk.on_delete.toUpperCase() === "CASCADE",
      );

      if (hasTargetCascade) {
        // Table exists with old CASCADE FK on target_fact_id — recreate without it.
        const recreate = createTransaction(this.liveDb, () => {
          this.liveDb.exec(`
            CREATE TABLE memory_links_new (
              id TEXT PRIMARY KEY,
              source_fact_id TEXT NOT NULL,
              target_fact_id TEXT NOT NULL,
              link_type TEXT NOT NULL,
              strength REAL NOT NULL DEFAULT 1.0,
              created_at INTEGER NOT NULL,
              FOREIGN KEY (source_fact_id) REFERENCES facts(id) ON DELETE CASCADE
            )
          `);
          this.liveDb.exec("INSERT INTO memory_links_new SELECT * FROM memory_links");
          this.liveDb.exec("DROP TABLE memory_links");
          this.liveDb.exec("ALTER TABLE memory_links_new RENAME TO memory_links");
        });
        recreate();
      }
      // If table exists without CASCADE on target, no migration needed.
    } else {
      // Table doesn't exist — create it fresh.
      this.liveDb.exec(`
        CREATE TABLE memory_links (
          id TEXT PRIMARY KEY,
          source_fact_id TEXT NOT NULL,
          target_fact_id TEXT NOT NULL,
          link_type TEXT NOT NULL,
          strength REAL NOT NULL DEFAULT 1.0,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (source_fact_id) REFERENCES facts(id) ON DELETE CASCADE
        )
      `);
    }

    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_links_source ON memory_links(source_fact_id)");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_links_target ON memory_links(target_fact_id)");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_links_type ON memory_links(link_type)");
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_links_source_type ON memory_links(source_fact_id, link_type)");
  }

  private migrateSourceDateColumn(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "source_date")) return;
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN source_date INTEGER");
    this.liveDb.exec("UPDATE facts SET source_date = created_at WHERE source_date IS NULL");
    this.liveDb.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_source_date ON facts(source_date) WHERE source_date IS NOT NULL",
    );
  }

  private migrateNormalizedHash(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "normalized_hash")) {
      this.liveDb.exec("ALTER TABLE facts ADD COLUMN normalized_hash TEXT");
      this.liveDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_facts_normalized_hash ON facts(normalized_hash) WHERE normalized_hash IS NOT NULL",
      );
    }
    const rows = this.liveDb.prepare("SELECT id, text FROM facts WHERE normalized_hash IS NULL").all() as Array<{
      id: string;
      text: string;
    }>;
    if (rows.length === 0) return;
    const stmt = this.liveDb.prepare("UPDATE facts SET normalized_hash = ? WHERE id = ?");
    for (const row of rows) {
      stmt.run(normalizedHash(row.text), row.id);
    }
  }

  private migrateSummaryColumn(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === "summary")) return;
    this.liveDb.exec("ALTER TABLE facts ADD COLUMN summary TEXT");
  }

  /** Re-apply connection pragmas (used on initial open and auto-reopen). */
  protected getSubsystemName(): string {
    return "facts-db";
  }

  private migrateDecayColumns(): void {
    const cols = this.liveDb.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("decay_class")) {
      this.liveDb.exec(`ALTER TABLE facts ADD COLUMN decay_class TEXT NOT NULL DEFAULT 'stable'`);
    }
    if (!colNames.has("expires_at")) {
      this.liveDb.exec("ALTER TABLE facts ADD COLUMN expires_at INTEGER");
    }
    if (!colNames.has("last_confirmed_at")) {
      this.liveDb.exec("ALTER TABLE facts ADD COLUMN last_confirmed_at INTEGER");
      this.liveDb.exec("UPDATE facts SET last_confirmed_at = created_at WHERE last_confirmed_at IS NULL");
    }
    if (!colNames.has("confidence")) {
      this.liveDb.exec("ALTER TABLE facts ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0");
    }
    this.liveDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_facts_expires ON facts(expires_at)
        WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class);
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

    const { cnt } = this.liveDb.prepare("SELECT COUNT(*) as cnt FROM facts WHERE created_at > ?").get(MS_THRESHOLD) as {
      cnt: number;
    };

    if (cnt === 0) return;

    this.liveDb
      .prepare(
        `UPDATE facts
         SET created_at = created_at / 1000
         WHERE created_at > ?`,
      )
      .run(MS_THRESHOLD);

    // last_confirmed_at may have been seeded from ms-based created_at
    // by the migrateDecayColumns migration (created_at → last_confirmed_at).
    this.liveDb
      .prepare(
        `UPDATE facts
         SET last_confirmed_at = last_confirmed_at / 1000
         WHERE last_confirmed_at IS NOT NULL
           AND last_confirmed_at > ?`,
      )
      .run(MS_THRESHOLD);
  }

  /** Count of canonical embedding rows (for vector/SQLite reconciliation checks). */
  countCanonicalEmbeddings(): number {
    const row = this.liveDb.prepare("SELECT COUNT(*) AS c FROM fact_embeddings WHERE variant = 'canonical'").get() as {
      c: number;
    };
    return Number(row?.c ?? 0);
  }

  /** Estimate storage bytes for SQLite database and WAL files. */
  estimateStorageBytes(): { sqliteBytes: number; walBytes: number; shmBytes: number } {
    let sqliteBytes = 0;
    let walBytes = 0;
    let shmBytes = 0;

    try {
      if (existsSync(this.dbPath)) {
        sqliteBytes = statSync(this.dbPath).size;
      }
    } catch {
      // Ignore errors reading main db file
    }

    try {
      const walPath = `${this.dbPath}-wal`;
      if (existsSync(walPath)) {
        walBytes = statSync(walPath).size;
      }
    } catch {
      // Ignore errors reading WAL file
    }

    try {
      const shmPath = `${this.dbPath}-shm`;
      if (existsSync(shmPath)) {
        shmBytes = statSync(shmPath).size;
      }
    } catch {
      // Ignore errors reading SHM file
    }

    return { sqliteBytes, walBytes, shmBytes };
  }

  private validateStoreEntryInput(
    entry: Omit<MemoryEntry, "id" | "createdAt" | "decayClass" | "expiresAt" | "lastConfirmedAt" | "confidence"> & {
      category?: MemoryCategory;
      importance?: number;
    },
  ): void {
    const text = (entry.text ?? "").trim();
    if (text.length === 0) {
      throw new Error("memory-hybrid: cannot store empty fact text");
    }
    const imp = entry.importance ?? 0.5;
    if (!Number.isFinite(imp) || imp < 0 || imp > 1) {
      throw new Error("memory-hybrid: importance must be a number in [0, 1]");
    }
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
      /** Embedding model used to generate this fact's vector (if any). */
      embeddingModel?: string | null;
      /** Memory scope — global, user, agent, or session. Default global. */
      scope?: "global" | "user" | "agent" | "session";
      /** Scope target (userId, agentId, or sessionId). Required when scope is user/agent/session. */
      scopeTarget?: string | null;
      /** Future-date freeze: epoch seconds until which confidence decay is paused (#144). */
      decayFreezeUntil?: number | null;
      /** Provenance: session id associated with extraction or store. */
      provenanceSession?: string | null;
      /** Provenance: conversation turn number (if known). */
      sourceTurn?: number | null;
      /** Provenance: extraction method (active/passive/consolidation/reflection). */
      extractionMethod?: string | null;
      /** Provenance: extraction confidence (0-1). */
      extractionConfidence?: number | null;
      /** Force-preservation: epoch seconds until which this fact MUST NOT be trimmed. */
      preserveUntil?: number | null;
      /** Force-preservation tags that block trimming regardless of importance tier. */
      preserveTags?: string[] | null;
    },
  ): MemoryEntry {
    this.validateStoreEntryInput(entry);
    if (this.fuzzyDedupe) {
      const existingId = this.getDuplicateIdByNormalizedHash(entry.text);
      if (existingId) {
        const existing = this.getById(existingId);
        if (existing) return existing;
      }
    }

    const id = randomUUID();
    const nowSec = Math.floor(Date.now() / 1000);

    const decayClass = entry.decayClass || classifyDecay(entry.entity, entry.key, entry.value, entry.text);
    const expiresAt = entry.expiresAt !== undefined ? entry.expiresAt : calculateExpiry(decayClass, nowSec);
    const importance = entry.importance ?? 0.5;
    const why = entry.why ?? null;
    const confidence = entry.confidence ?? 1.0;
    const summary = entry.summary ?? null;
    const embeddingModel = entry.embeddingModel ?? null;
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
    const provenanceSession = entry.provenanceSession ?? null;
    const sourceTurn = entry.sourceTurn ?? null;
    const extractionMethod = entry.extractionMethod ?? null;
    const extractionConfidence = entry.extractionConfidence !== undefined ? entry.extractionConfidence : null;
    const preserveUntil = entry.preserveUntil ?? null;
    const preserveTags = entry.preserveTags ?? null;
    const preserveTagsStr = preserveTags ? JSON.stringify(preserveTags) : null;

    const tier: MemoryTier = (entry as { tier?: MemoryTier }).tier ?? "warm";
    // Fix #2: guard against NaN/non-finite values passed in from external callers
    const rawFreeze = (entry as { decayFreezeUntil?: number | null }).decayFreezeUntil ?? null;
    const decayFreezeUntil = rawFreeze !== null && Number.isFinite(rawFreeze) ? rawFreeze : null;
    // Fix #1: ensure expires_at covers the full freeze period so the fact is not pruned
    // before the freeze expires
    const adjustedExpiresAt =
      decayFreezeUntil !== null && expiresAt !== null && expiresAt < decayFreezeUntil ? decayFreezeUntil : expiresAt;
    const tx = createTransaction(this.liveDb, () => {
      this.liveDb
        .prepare(
          `INSERT INTO facts (id, text, why, category, importance, entity, key, value, source, created_at, decay_class, expires_at, last_confirmed_at, confidence, summary, embedding_model, normalized_hash, source_date, tags, valid_from, valid_until, supersedes_id, tier, scope, scope_target, procedure_type, success_count, last_validated, source_sessions, decay_freeze_until, provenance_session, source_turn, extraction_method, extraction_confidence, preserve_until, preserve_tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          entry.text,
          why,
          entry.category,
          importance,
          entry.entity,
          entry.key,
          entry.value,
          entry.source,
          nowSec,
          decayClass,
          adjustedExpiresAt,
          nowSec,
          confidence,
          summary,
          embeddingModel,
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
          decayFreezeUntil,
          provenanceSession,
          sourceTurn,
          extractionMethod,
          extractionConfidence,
          preserveUntil,
          preserveTagsStr,
        );
    });
    tx();
    if (supersedesId) {
      this.invalidateSupersededCache();
    }
    const loaded = this.getById(id);
    if (!loaded) {
      throw new Error(`memory-hybrid: store() failed to read back inserted fact ${id}`);
    }
    return loaded;
  }

  /** Update recall_count and last_accessed for facts (public for progressive disclosure). Bulk UPDATE to avoid N+1. */
  refreshAccessedFacts(ids: string[]): void {
    if (ids.length === 0) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const BATCH_SIZE = 500; // SQLite variable limit

    const tx = createTransaction(this.liveDb, () => {
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => "?").join(",");

        // Extend TTL for stable/active/durable/normal facts that were just accessed
        this.liveDb
          .prepare(
            `UPDATE facts SET last_confirmed_at = ?, expires_at = CASE decay_class WHEN 'stable' THEN ? + ? WHEN 'active' THEN ? + ? WHEN 'durable' THEN ? + ? WHEN 'normal' THEN ? + ? ELSE expires_at END WHERE id IN (${placeholders}) AND decay_class IN ('stable', 'active', 'durable', 'normal')`,
          )
          .run(
            nowSec,
            nowSec,
            TTL_DEFAULTS.stable,
            nowSec,
            TTL_DEFAULTS.active,
            nowSec,
            TTL_DEFAULTS.durable,
            nowSec,
            TTL_DEFAULTS.normal,
            ...batch,
          );

        // Bump recall_count, last_accessed, access_count, and last_accessed_at for all
        this.liveDb
          .prepare(
            `UPDATE facts SET recall_count = recall_count + 1, last_accessed = ?, access_count = access_count + 1, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%SZ', ?, 'unixepoch') WHERE id IN (${placeholders})`,
          )
          .run(nowSec, nowSec, ...batch);
      }
    });
    tx();
  }

  /** Record a memory_recall invocation outcome for hit-rate tracking (Issue #148). */
  logRecall(hit: boolean, occurredAtSec?: number): void {
    const id = randomUUID();
    const nowSec = occurredAtSec ?? Math.floor(Date.now() / 1000);
    this.liveDb.prepare("INSERT INTO recall_log (id, occurred_at, hit) VALUES (?, ?, ?)").run(id, nowSec, hit ? 1 : 0);
  }

  /** Prune recall_log entries older than N days to prevent unbounded growth (Issue #148). */
  pruneRecallLog(olderThanDays = 30): number {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 24 * 3600;
    return Number(this.liveDb.prepare("DELETE FROM recall_log WHERE occurred_at < ?").run(cutoff).changes ?? 0);
  }

  /** Read the last stored embedding provider+model metadata (Issue #153). */
  getEmbeddingMeta(): { provider: string; model: string } | null {
    const row = this.liveDb.prepare("SELECT provider, model FROM embedding_meta WHERE id = 1").get() as
      | { provider: string; model: string }
      | undefined;
    if (!row) return null;
    return { provider: row.provider, model: row.model };
  }

  /** Persist the active embedding provider+model metadata (Issue #153). */
  setEmbeddingMeta(provider: string, model: string): void {
    const nowSec = Math.floor(Date.now() / 1000);
    this.liveDb
      .prepare(
        `INSERT INTO embedding_meta (id, provider, model, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model = excluded.model, updated_at = excluded.updated_at`,
      )
      .run(provider, model, nowSec);
  }

  /** Record which embedding model generated the stored vector for a fact (Issue #153). */
  setEmbeddingModel(id: string, model: string | null): void {
    this.liveDb.prepare("UPDATE facts SET embedding_model = ? WHERE id = ?").run(model, id);
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
    const result = this.liveDb.prepare("UPDATE facts SET tier = ? WHERE id = ?").run(tier, id);
    return result.changes > 0;
  }

  /** Compaction — migrate facts between tiers. Completed tasks -> COLD, inactive preferences -> WARM, active blockers -> HOT. */
  runCompaction(opts: { inactivePreferenceDays: number; hotMaxTokens: number; hotMaxFacts: number }): {
    hot: number;
    warm: number;
    cold: number;
  } {
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

  /**
   * Token-budget tiered trimming for context compaction (Issue #792).
   *
   * Retention tiers (never trimmed = P0):
   *  - Edict-tagged facts (tag 'edict')
   *  - Verified facts (present in verified_facts table)
   *  - Facts with active preserveUntil (epoch seconds in future)
   *  - Facts with non-empty preserveTags
   *
   * Remaining facts sorted by trim priority:
   *  - P1: importance > 0.8 AND created within the last hour
   *  - P2: importance 0.5 – 0.8
   *  - P3: importance < 0.5
   *
   * Trimming proceeds P3 → P2 → P1 until within budget.
   * Token estimate: Math.ceil(chars / 3.8)
   *
   * Returns a summary of what would be / was trimmed.
   */
  trimToBudget(
    tokenBudget: number,
    simulate = false,
  ): {
    simulate: boolean;
    budget: number;
    beforeTokens: number;
    afterTokens: number;
    trimmed: Array<{ id: string; textPreview: string; tier: string; importance: number; tokenCost: number }>;
    preserved: Array<{ id: string; reason: string }>;
    error?: string;
  } {
    const nowSec = Math.floor(Date.now() / 1000);
    const HOUR_SEC = 3600;
    const p1Cutoff = nowSec - HOUR_SEC;
    const tokenEstimate = (text: string): number => Math.ceil(text.length / 3.8);

    // Fetch all non-superseded, non-expired facts with their verified status.
    const rows = this.liveDb
      .prepare(
        `SELECT f.id, f.text, f.importance, f.created_at, f.preserve_until, f.preserve_tags,
                f.confidence, f.tags,
                vf.fact_id IS NOT NULL AS is_verified
         FROM facts f
         LEFT JOIN verified_facts vf ON vf.fact_id = f.id
         WHERE f.superseded_at IS NULL
           AND (f.expires_at IS NULL OR f.expires_at > ?)`,
      )
      .all(nowSec) as Array<{
      id: string;
      text: string;
      importance: number;
      created_at: number;
      preserve_until: number | null;
      preserve_tags: string | null;
      confidence: number;
      tags: string | null;
      is_verified: number;
    }>;

    const parsePreserveTags = (raw: string | null): string[] => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : [];
      } catch {
        return [];
      }
    };

    const hasTag = (tagsStr: string | null, tag: string): boolean => {
      return parseTags(tagsStr).includes(tag.toLowerCase().trim());
    };

    const p0: Array<{ id: string; text: string }> = [];
    const preserved: Array<{ id: string; reason: string }> = [];

    for (const row of rows) {
      const preserveTags = parsePreserveTags(row.preserve_tags);
      const tagsStr = row.tags;
      const isEdict = hasTag(tagsStr, "edict");
      const isVerified = row.is_verified === 1;
      const hasPreserveUntil = row.preserve_until != null && row.preserve_until > nowSec;
      const hasPreserveTags = preserveTags.length > 0;

      if (isEdict || isVerified || hasPreserveUntil || hasPreserveTags) {
        p0.push({ id: row.id, text: row.text });
        const reasons: string[] = [];
        if (isEdict) reasons.push("edict");
        if (isVerified) reasons.push("verified");
        if (hasPreserveUntil) reasons.push(`preserveUntil=${row.preserve_until}`);
        if (hasPreserveTags) reasons.push(`preserveTags=${preserveTags.join(",")}`);
        preserved.push({ id: row.id, reason: reasons.join("|") });
      }
    }

    // Trim candidates in DB sort order (P3 → P2 → P1, then importance, then recency — Issue #838).
    const trimOrderStmt = this.liveDb.prepare(
      `SELECT f.id, f.text, f.importance,
              CASE
                WHEN f.importance < 0.5 THEN 0
                WHEN f.importance > 0.8 AND f.created_at >= ? THEN 2
                ELSE 1
              END AS trim_tier
       FROM facts f
       LEFT JOIN verified_facts vf ON vf.fact_id = f.id
       WHERE f.superseded_at IS NULL
         AND (f.expires_at IS NULL OR f.expires_at > ?)
         AND NOT (
           (',' || COALESCE(f.tags,'') || ',') LIKE '%,edict,%'
           OR vf.fact_id IS NOT NULL
           OR (f.preserve_until IS NOT NULL AND f.preserve_until > ?)
           OR (f.preserve_tags IS NOT NULL AND TRIM(f.preserve_tags) != '' AND f.preserve_tags != '[]')
         )
       ORDER BY trim_tier ASC, f.importance ASC, COALESCE(f.last_accessed, f.created_at) ASC, f.id ASC`,
    );
    const trimRows = trimOrderStmt.all(p1Cutoff, nowSec, nowSec) as Array<{
      id: string;
      text: string;
      importance: number;
      trim_tier: number;
    }>;

    const p0Tokens = p0.reduce((sum, f) => sum + tokenEstimate(f.text), 0);
    const trimPoolTokens = trimRows.reduce((sum, r) => sum + tokenEstimate(r.text), 0);
    const currentTokens = p0Tokens + trimPoolTokens;

    if (currentTokens <= tokenBudget) {
      const trimmed: Array<{ id: string; textPreview: string; tier: string; importance: number; tokenCost: number }> =
        [];
      return {
        simulate,
        budget: tokenBudget,
        beforeTokens: currentTokens,
        afterTokens: simulate ? currentTokens : currentTokens,
        trimmed,
        preserved,
      };
    }

    // Trim from P3 → P2 → P1 until within budget (order from SQL above).
    let remainingTokens = currentTokens;
    const toTrim: Array<{ id: string; text: string; tier: string; importance: number }> = trimRows.map((r) => ({
      id: r.id,
      text: r.text,
      importance: r.importance,
      tier: r.trim_tier === 0 ? "P3" : r.trim_tier === 1 ? "P2" : "P1",
    }));

    const trimmed: Array<{ id: string; textPreview: string; tier: string; importance: number; tokenCost: number }> = [];
    for (const fact of toTrim) {
      if (remainingTokens <= tokenBudget) break;
      const cost = tokenEstimate(fact.text);
      remainingTokens -= cost;
      const preview = fact.text.length > 80 ? `${fact.text.slice(0, 80)}…` : fact.text;
      trimmed.push({
        id: fact.id,
        textPreview: preview,
        tier: fact.tier,
        importance: fact.importance,
        tokenCost: cost,
      });
      if (!simulate) {
        this.liveDb.prepare("UPDATE facts SET superseded_at = ? WHERE id = ?").run(nowSec, fact.id);
        this.liveDb
          .prepare(
            `INSERT INTO trim_metrics (trimmed_at, fact_id, fact_text_preview, tier, importance, preserve_until, token_cost, budget_before, budget_after)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            nowSec,
            fact.id,
            fact.text.slice(0, 200),
            fact.tier,
            fact.importance,
            null,
            cost,
            currentTokens,
            tokenBudget,
          );
      }
    }

    return {
      simulate,
      budget: tokenBudget,
      beforeTokens: currentTokens,
      afterTokens: remainingTokens,
      trimmed,
      preserved,
    };
  }

  /**
   * Set or clear preserve_until on a fact.
   * If untilSec is null, clears any existing preserve_until.
   * Returns the updated MemoryEntry or null if not found.
   */
  setPreserveUntil(id: string, untilSec: number | null): MemoryEntry | null {
    const nowSec = Math.floor(Date.now() / 1000);
    if (untilSec !== null && untilSec <= nowSec) {
      throw new Error(`preserve_until must be in the future or null. Got: ${untilSec}`);
    }
    this.liveDb.prepare("UPDATE facts SET preserve_until = ? WHERE id = ?").run(untilSec, id);
    return this.getById(id);
  }

  /**
   * Add or remove preserve_tags on a fact.
   * mode 'set': replaces all tags with the given array.
   * mode 'add': adds the given tags (deduped).
   * mode 'remove': removes the given tags.
   * Returns the updated MemoryEntry or null if not found.
   */
  setPreserveTags(id: string, tags: string[], mode: "set" | "add" | "remove"): MemoryEntry | null {
    const fact = this.getById(id);
    if (!fact) return null;
    const existing = fact.preserveTags ?? [];
    let next: string[];
    if (mode === "set") {
      next = [...new Set(tags.map((t) => t.toLowerCase().trim()))];
    } else if (mode === "add") {
      const s = new Set(existing);
      for (const t of tags) s.add(t.toLowerCase().trim());
      next = [...s];
    } else {
      const s = new Set(existing);
      for (const t of tags) s.delete(t.toLowerCase().trim());
      next = [...s];
    }
    const preserveTagsStr = next.length > 0 ? JSON.stringify(next) : null;
    this.liveDb.prepare("UPDATE facts SET preserve_tags = ? WHERE id = ?").run(preserveTagsStr, id);
    return this.getById(id);
  }

  /**
   * Compute current token estimate for all non-superseded, non-expired facts.
   * Returns { totalTokens, byTier: { p0, p1, p2, p3 }, factCount: { p0, p1, p2, p3 } }.
   */
  getTokenBudgetStatus(): {
    totalTokens: number;
    budget: number;
    overflow: number;
    byTier: { p0: number; p1: number; p2: number; p3: number };
    factCount: { p0: number; p1: number; p2: number; p3: number };
  } {
    const nowSec = Math.floor(Date.now() / 1000);
    const HOUR_SEC = 3600;
    const p1Cutoff = nowSec - HOUR_SEC;
    const tokenEstimate = (text: string): number => Math.ceil(text.length / 3.8);
    const DEFAULT_BUDGET = Math.ceil((32_000 * 0.8) / 3.8);
    const budget = DEFAULT_BUDGET;

    const rows = this.liveDb
      .prepare(
        `SELECT f.id, f.text, f.importance, f.created_at, f.preserve_until, f.preserve_tags,
                f.confidence, f.tags,
                vf.fact_id IS NOT NULL AS is_verified
         FROM facts f
         LEFT JOIN verified_facts vf ON vf.fact_id = f.id
         WHERE f.superseded_at IS NULL
           AND (f.expires_at IS NULL OR f.expires_at > ?)`,
      )
      .all(nowSec) as Array<{
      id: string;
      text: string;
      importance: number;
      created_at: number;
      preserve_until: number | null;
      preserve_tags: string | null;
      confidence: number;
      tags: string | null;
      is_verified: number;
    }>;

    const parsePreserveTags = (raw: string | null): string[] => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : [];
      } catch {
        return [];
      }
    };

    const hasTag = (tagsStr: string | null, tag: string): boolean => {
      return parseTags(tagsStr).includes(tag.toLowerCase().trim());
    };

    const byTier = { p0: 0, p1: 0, p2: 0, p3: 0 };
    const factCount = { p0: 0, p1: 0, p2: 0, p3: 0 };

    for (const row of rows) {
      const preserveTags = parsePreserveTags(row.preserve_tags);
      const tagsStr = row.tags;
      const isEdict = hasTag(tagsStr, "edict");
      const isVerified = row.is_verified === 1;
      const hasPreserveUntil = row.preserve_until != null && row.preserve_until > nowSec;
      const hasPreserveTags = preserveTags.length > 0;

      const tokens = tokenEstimate(row.text);

      if (isEdict || isVerified || hasPreserveUntil || hasPreserveTags) {
        byTier.p0 += tokens;
        factCount.p0++;
      } else if (row.importance > 0.8 && row.created_at >= p1Cutoff) {
        byTier.p1 += tokens;
        factCount.p1++;
      } else if (row.importance >= 0.5) {
        byTier.p2 += tokens;
        factCount.p2++;
      } else {
        byTier.p3 += tokens;
        factCount.p3++;
      }
    }

    const totalTokens = byTier.p0 + byTier.p1 + byTier.p2 + byTier.p3;
    return { totalTokens, budget, overflow: Math.max(0, totalTokens - budget), byTier, factCount };
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
      /** Weight applied to diversity score when calculating effective boost (default: 1.0). */
      diversityWeight?: number;
      /**
       * Interactive auto-recall hot path: cap FTS OR-term explosion and avoid loading full fact rows
       * until top matches are chosen (reduces WhatsApp/gateway stalls from huge MATCH + wide SELECT f.*).
       */
      interactiveFtsFastPath?: boolean;
    } = {},
  ): SearchResult[] {
    const {
      includeExpired = false,
      tag,
      includeSuperseded = false,
      asOf,
      tierFilter = "warm",
      scopeFilter,
      reinforcementBoost = 0.1,
      diversityWeight = 1.0,
      interactiveFtsFastPath = false,
    } = options;

    const safeQuery = interactiveFtsFastPath
      ? buildFactsSearchFtsOrClause(query, { maxOrTerms: INTERACTIVE_FTS_MAX_OR_TERMS })
      : buildFactsSearchFtsOrClause(query);
    if (!safeQuery) return [];

    const nowSec = Math.floor(Date.now() / 1000);
    const expiryFilter = includeExpired ? "" : "AND (f.expires_at IS NULL OR f.expires_at > @now)";
    const temporalFilter =
      asOf != null
        ? "AND f.valid_from <= @asOf AND (f.valid_until IS NULL OR f.valid_until > @asOf)"
        : includeSuperseded
          ? ""
          : "AND f.superseded_at IS NULL";
    const tagFilter = tag?.trim() ? "AND (',' || COALESCE(f.tags,'') || ',') LIKE @tagPattern" : "";
    const tagPattern = tag?.trim() ? `%,${tag.toLowerCase().trim()},%` : null;
    const tierFilterClause = tierFilter === "warm" ? "AND (f.tier IS NULL OR f.tier = 'warm' OR f.tier = 'hot')" : "";
    const { clause: scopeFilterClauseStr, params: scopeParams } = this.scopeFilterClause(scopeFilter);

    const decayWindowSec = 7 * 24 * 3600;
    const paramBag: Record<string, SQLInputValue> = {
      "@query": safeQuery,
      "@now": nowSec,
      ...(asOf != null ? { "@asOf": asOf } : {}),
      "@limit": limit * 2,
      "@decay_window": decayWindowSec,
      ...(tagPattern ? { "@tagPattern": tagPattern } : {}),
      ...scopeParams,
    };

    let rows: Array<Record<string, unknown>>;

    if (interactiveFtsFastPath) {
      // node:sqlite rejects named parameters not referenced by the prepared SQL — omit @decay_window for the narrow query.
      const narrowParamBag: Record<string, SQLInputValue> = {
        "@query": safeQuery,
        "@now": nowSec,
        ...(asOf != null ? { "@asOf": asOf } : {}),
        "@limit": limit * 2,
        ...(tagPattern ? { "@tagPattern": tagPattern } : {}),
        ...scopeParams,
      };
      const narrowSql = `SELECT f.id AS id, fts.rank AS fts_score
         FROM facts f
         JOIN facts_fts fts ON f.rowid = fts.rowid
         WHERE facts_fts MATCH @query
           ${expiryFilter}
           ${temporalFilter}
           ${tagFilter}
           ${tierFilterClause}
           ${scopeFilterClauseStr}
         ORDER BY fts.rank
         LIMIT @limit`;
      const narrowRows = this.liveDb.prepare(narrowSql).all(narrowParamBag) as Array<{ id: string; fts_score: number }>;
      if (narrowRows.length === 0) return [];
      const ids = narrowRows.map((r) => r.id);
      const ftsById = new Map(narrowRows.map((r) => [r.id, r.fts_score]));
      const placeholders = ids.map(() => "?").join(",");
      const fullRows = this.liveDb.prepare(`SELECT * FROM facts WHERE id IN (${placeholders})`).all(...ids) as Array<
        Record<string, unknown>
      >;
      const byId = new Map(fullRows.map((r) => [r.id as string, r]));
      const decayWindow = decayWindowSec;
      rows = [];
      for (const id of ids) {
        const row = byId.get(id);
        if (!row) continue;
        const expiresAt = row.expires_at as number | null | undefined;
        let freshness: number;
        if (expiresAt == null) freshness = 1.0;
        else if (expiresAt <= nowSec) freshness = 0.0;
        else freshness = Math.min(1.0, (expiresAt - nowSec) / decayWindow);
        rows.push({
          ...row,
          fts_score: ftsById.get(id) as number,
          freshness,
        });
      }
      if (rows.length === 0) return [];
    } else {
      rows = this.liveDb
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
        .all(paramBag) as Array<Record<string, unknown>>;
    }

    if (rows.length === 0) return [];

    const minScore = Math.min(...rows.map((r) => r.fts_score as number));
    const maxScore = Math.max(...rows.map((r) => r.fts_score as number));
    const range = maxScore - minScore || 1;

    // Batch-fetch reinforcement events for all reinforced facts to avoid N+1 queries
    const reinforcedFactIds = rows
      .filter((row) => ((row.reinforced_count as number) || 0) > 0)
      .map((row) => row.id as string);
    const eventsByFactId = this.batchGetReinforcementEvents(reinforcedFactIds);

    const results = rows.map((row) => {
      const rawScore = 1 - ((row.fts_score as number) - minScore) / range;
      const bm25Score = Number.isNaN(rawScore) ? 0.8 : rawScore;
      const freshness = (row.freshness as number) || 1.0;
      const confidence = (row.confidence as number) || 1.0;
      const reinforcedCount = (row.reinforced_count as number) || 0;
      // Add reinforcement boost when fact has been praised, weighted by diversity
      let reinforcement = 0;
      if (reinforcedCount > 0) {
        const events = eventsByFactId.get(row.id as string) || [];
        if (events.length === 0) {
          // No events tracked (trackContext was false or events evicted): use full boost
          reinforcement = reinforcementBoost;
        } else {
          // Calculate diversity score and weight boost: high diversity = higher boost
          const diversityScore = FactsDB.computeDiversityFromEvents(events);
          reinforcement = reinforcementBoost * (1 - diversityWeight + diversityWeight * diversityScore);
        }
      }
      const composite = Math.min(1.0, bm25Score * 0.6 + freshness * 0.25 + confidence * 0.15 + reinforcement);
      const entry = this.rowToEntry(row);
      // Apply dynamic salience (access boost + time decay)
      const salienceScore = computeDynamicSalience(composite, entry);
      const controlledScore = applyConsolidationRetrievalControls(salienceScore, entry);

      return {
        entry,
        score: controlledScore,
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
    options?: { includeSuperseded?: boolean; asOf?: number; scopeFilter?: ScopeFilter | null; limit?: number },
  ): SearchResult[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const { includeSuperseded = false, asOf, scopeFilter } = options ?? {};
    const limit = typeof options?.limit === "number" && options.limit > 0 ? Math.floor(options.limit) : null;
    const temporalFilter =
      asOf != null
        ? " AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)"
        : includeSuperseded
          ? ""
          : " AND superseded_at IS NULL";
    const tagFilter = tag?.trim() ? " AND (',' || COALESCE(tags,'') || ',') LIKE ?" : "";
    const tagParam = tag?.trim() ? `%,${tag.toLowerCase().trim()},%` : null;
    const { clause: scopeClause, params: scopeParamsArr } = this.scopeFilterClausePositional(scopeFilter);
    const limitClause = limit ? " LIMIT ?" : "";

    const base = key
      ? `SELECT * FROM facts WHERE lower(entity) = lower(?) AND lower(key) = lower(?) AND (expires_at IS NULL OR expires_at > ?)${temporalFilter}${tagFilter}${scopeClause} ORDER BY confidence DESC, COALESCE(source_date, created_at) DESC${limitClause}`
      : `SELECT * FROM facts WHERE lower(entity) = lower(?) AND (expires_at IS NULL OR expires_at > ?)${temporalFilter}${tagFilter}${scopeClause} ORDER BY confidence DESC, COALESCE(source_date, created_at) DESC${limitClause}`;

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
    const finalParams = limit ? [...params, limit] : params;
    const rows = this.liveDb.prepare(base).all(...finalParams) as Array<Record<string, unknown>>;

    const results = rows.map((row) => {
      const entry = this.rowToEntry(row);
      const baseScore = (row.confidence as number) || 1.0;
      // Apply dynamic salience (access boost + time decay)
      const salienceScore = computeDynamicSalience(baseScore, entry);
      const controlledScore = applyConsolidationRetrievalControls(salienceScore, entry);
      return {
        entry,
        score: controlledScore,
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
    const rows = this.liveDb.prepare(`SELECT id FROM facts WHERE id LIKE ? || '%' LIMIT 3`).all(pattern) as Array<{
      id: string;
    }>;
    if (rows.length === 0) return null;
    if (rows.length === 1) return { id: rows[0].id };
    return { ambiguous: true, count: rows.length >= 3 ? 3 : rows.length };
  }

  delete(id: string): boolean {
    // Explicitly clean up contradictions (defense-in-depth; ON DELETE CASCADE on facts also handles this,
    // but explicit cleanup ensures correctness regardless of FK enforcement state at the call site).
    this.liveDb.prepare("DELETE FROM contradictions WHERE fact_id_new = ? OR fact_id_old = ?").run(id, id);
    // Manually clean up links where this fact is the target, except DERIVED_FROM links
    // (DERIVED_FROM links are preserved for provenance tracking even after source facts are deleted)
    this.liveDb.prepare(`DELETE FROM memory_links WHERE target_fact_id = ? AND link_type != 'DERIVED_FROM'`).run(id);

    const result = this.liveDb.prepare("DELETE FROM facts WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** Exact or (if fuzzyDedupe) normalized-text duplicate. */
  hasDuplicate(text: string): boolean {
    const exact = this.liveDb.prepare("SELECT id FROM facts WHERE text = ? LIMIT 1").get(text);
    if (exact) return true;
    if (this.fuzzyDedupe && this.getDuplicateIdByNormalizedHash(text) !== null) return true;
    return false;
  }

  /** Id of an existing fact with same normalized text, or null. Used when store.fuzzyDedupe is true. */
  private getDuplicateIdByNormalizedHash(text: string): string | null {
    const hash = normalizedHash(text);
    const row = this.liveDb.prepare("SELECT id FROM facts WHERE normalized_hash = ? LIMIT 1").get(hash) as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  /** Mark a fact as superseded by a new fact. Sets superseded_at, superseded_by, and valid_until (bi-temporal). */
  supersede(oldId: string, newId: string | null): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = this.liveDb
      .prepare(
        "UPDATE facts SET superseded_at = ?, superseded_by = ?, valid_until = ? WHERE id = ? AND superseded_at IS NULL",
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
          "SELECT * FROM facts WHERE lower(entity) = lower(?) AND lower(key) = lower(?) AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT ?",
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
          "SELECT * FROM facts WHERE lower(entity) = lower(?) AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT ?",
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
      const words = buildClassificationFtsOrClause(text);
      if (words) {
        try {
          const rows = this.liveDb
            .prepare(
              "SELECT f.* FROM facts f JOIN facts_fts fts ON f.rowid = fts.rowid WHERE facts_fts MATCH ? AND f.superseded_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > ?) LIMIT ?",
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
            operation: "fts-query",
            severity: "info",
            subsystem: "facts",
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
      why: (row.why as string) ?? null,
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
      accessCount: (row.access_count as number) || 0,
      lastAccessedAt: (row.last_accessed_at as string) || null,
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
      embeddingModel: (row.embedding_model as string) ?? null,
      provenanceSession: (row.provenance_session as string) ?? null,
      sourceTurn: (row.source_turn as number) ?? null,
      extractionMethod: (row.extraction_method as string) ?? null,
      extractionConfidence: (row.extraction_confidence as number) ?? null,
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
            operation: "json-parse-quotes",
            severity: "info",
            subsystem: "facts",
          });
          return null;
        }
      })(),
      decayFreezeUntil: (row.decay_freeze_until as number) ?? null,
      preserveUntil: (row.preserve_until as number) ?? null,
      preserveTags: (() => {
        const raw = row.preserve_tags as string | null;
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : null;
        } catch {
          return null;
        }
      })(),
    };
  }

  /** For consolidation (2.4): fetch facts with id, text, category, entity, key. Order by created_at DESC. Excludes superseded. */
  getFactsForConsolidation(
    limit: number,
  ): Array<{ id: string; text: string; category: string; entity: string | null; key: string | null }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = this.liveDb
      .prepare(
        `SELECT id, text, category, entity, key FROM facts
         WHERE (expires_at IS NULL OR expires_at > ?)
           AND superseded_at IS NULL
           AND lower(COALESCE(source, '')) NOT IN ('consolidation', 'dream-cycle')
           AND lower(COALESCE(key, '')) != 'consolidated'
           AND (',' || lower(COALESCE(tags, '')) || ',') NOT LIKE '%,consolidated,%'
         ORDER BY created_at DESC LIMIT ?`,
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

  private applyLookupFilters(
    entry: MemoryEntry,
    options?: { asOf?: number; scopeFilter?: ScopeFilter | null },
  ): MemoryEntry | null {
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

  /** Get one fact by id (for merge category). Returns null if not found. When asOf is set, returns null if the fact was not valid at that time. When scopeFilter is set, returns null if the fact is not in scope. */
  getById(id: string, options?: { asOf?: number; scopeFilter?: ScopeFilter | null }): MemoryEntry | null {
    const row = this.liveDb.prepare("SELECT * FROM facts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return this.applyLookupFilters(entry, options);
  }

  /** Batch get facts by id. Returns a Map of id → entry after asOf/scope filtering. */
  getByIds(ids: string[], options?: { asOf?: number; scopeFilter?: ScopeFilter | null }): Map<string, MemoryEntry> {
    const result = new Map<string, MemoryEntry>();
    if (ids.length === 0) return result;
    const uniqueIds = Array.from(new Set(ids));
    // SQLite has a SQLITE_LIMIT_VARIABLE_NUMBER limit (default 999, often 32766).
    // Batch in chunks of 500 to stay well within that limit for any configuration.
    const CHUNK_SIZE = 500;
    for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.liveDb.prepare(`SELECT * FROM facts WHERE id IN (${placeholders})`).all(...chunk) as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        const entry = this.rowToEntry(row);
        const filtered = this.applyLookupFilters(entry, options);
        if (filtered) result.set(filtered.id, filtered);
      }
    }
    return result;
  }

  /** Create a typed link between two facts. Returns link id. */
  createLink(sourceFactId: string, targetFactId: string, linkType: MemoryLinkType, strength = 1.0): string {
    return createLinkHelper(this.liveDb, sourceFactId, targetFactId, linkType, strength);
  }

  /** Hebbian: Create or strengthen RELATED_TO link between two facts recalled together. */
  createOrStrengthenRelatedLink(factIdA: string, factIdB: string, deltaStrength = 0.1): void {
    createOrStrengthenRelatedLinkHelper(this.liveDb, factIdA, factIdB, deltaStrength);
  }

  /**
   * Hebbian batch: strengthen RELATED_TO links for all pairs in a single SQLite transaction.
   * Reduces O(n²) individual round-trips to 1 transaction regardless of pair count.
   */
  strengthenRelatedLinksBatch(pairs: [string, string][], deltaStrength = 0.1): void {
    strengthenRelatedLinksBatchHelper(this.liveDb, pairs, deltaStrength);
  }

  /** Get links from a fact (outgoing). */
  getLinksFrom(factId: string): Array<{ id: string; targetFactId: string; linkType: string; strength: number }> {
    return getLinksFromHelper(this.liveDb, factId);
  }

  /** Get links to a fact (incoming). */
  getLinksTo(factId: string): Array<{ id: string; sourceFactId: string; linkType: string; strength: number }> {
    return getLinksToHelper(this.liveDb, factId);
  }

  /** BFS from given fact IDs up to maxDepth hops. Returns all connected fact IDs (including the seed set).
   * CONTRADICTS links are excluded from traversal — they would otherwise pollute graph-based recall
   * with unrelated contradicted facts and cause traversal explosion when a fact has many contradictions.
   */
  getConnectedFactIds(factIds: string[], maxDepth: number): string[] {
    return getConnectedFactIdsHelper(this.liveDb, factIds, maxDepth);
  }

  /**
   * Perform graph expansion using a recursive CTE, returning expanded nodes with hop count and path info.
   * This is used by graph-retrieval.ts to avoid N+1 query patterns.
   *
   * @param seedFactIds - Array of seed fact IDs to start expansion from
   * @param maxDepth - Maximum traversal depth
   * @returns Array of expanded nodes with factId, seedId, hopCount, and path (JSON array of link steps)
   */
  expandGraphWithCTE(
    seedFactIds: string[],
    maxDepth: number,
    options?: { asOf?: number; scopeFilter?: { userId?: string; agentId?: string; sessionId?: string } },
  ): Array<{
    factId: string;
    seedId: string;
    hopCount: number;
    path: string;
  }> {
    return expandGraphWithCTEHelper(this.liveDb, seedFactIds, maxDepth, options);
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

  /**
   * Count non-expired facts (for migration progress). Same filter as getAll with includeSuperseded.
   */
  getCount(options?: { includeSuperseded?: boolean }): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const { includeSuperseded = false } = options ?? {};
    const temporalFilter = includeSuperseded ? "" : " AND superseded_at IS NULL";
    const row = this.liveDb
      .prepare(`SELECT COUNT(*) AS count FROM facts WHERE (expires_at IS NULL OR expires_at > ?)${temporalFilter}`)
      .get(nowSec) as { count: number };
    return row?.count ?? 0;
  }

  /**
   * Return all active fact IDs.
   * Active = not expired and not superseded (same filter as getAll() default).
   * Keeping this filter in sync with getAll() ensures that the set of IDs
   * returned here is consistent with what callers expect to be "live" facts.
   * Used by the reconcile command to detect orphan entries.
   * IDs are normalized to lowercase to match VectorDB.getAllIds() normalization.
   */
  getAllIds(): string[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = this.liveDb
      .prepare("SELECT id FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
      .all(nowSec) as Array<{ id: string }>;
    return rows.map((row) => row.id.toLowerCase());
  }

  /**
   * Get a batch of non-expired facts (for migration without loading all into memory).
   * Same ordering and filter as getAll; offset/limit applied.
   */
  getBatch(offset: number, limit: number, options?: { includeSuperseded?: boolean }): MemoryEntry[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const { includeSuperseded = false } = options ?? {};
    const temporalFilter = includeSuperseded ? "" : " AND superseded_at IS NULL";
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM facts WHERE (expires_at IS NULL OR expires_at > ?)${temporalFilter} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(nowSec, limit, offset) as Array<Record<string, unknown>>;
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
    if (
      (filters?.category != null && filters.category !== "" && !isValidCategory(filters.category)) ||
      (filters?.tier != null && filters.tier !== "" && !DASHBOARD_TIER_FILTER.has(filters.tier))
    ) {
      return [];
    }
    const parts: string[] = ["(expires_at IS NULL OR expires_at > ?)", "superseded_at IS NULL"];
    const params: SQLInputValue[] = [nowSec];
    if (filters?.category != null && isValidCategory(filters.category)) {
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
    if (filters?.tier != null && DASHBOARD_TIER_FILTER.has(filters.tier)) {
      parts.push("COALESCE(tier, 'warm') = ?");
      params.push(filters.tier);
    }
    const where = parts.join(" AND ");
    params.push(limit);
    const rows = this.liveDb
      .prepare(`SELECT * FROM facts WHERE ${where} ORDER BY COALESCE(source_date, created_at) DESC LIMIT ?`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEntry(row));
  }

  /** Get texts of superseded facts (for filtering LanceDB results). Cached to avoid repeated full scans. */
  getSupersededTexts(): Set<string> {
    const now = Date.now();
    return this.supersededTextsCacheMgr.getSnapshot(now, () => fetchSupersededFactTextsLower(this.liveDb));
  }

  /** Invalidate superseded texts cache (called after supersede operations). */
  private invalidateSupersededCache(): void {
    this.supersededTextsCacheMgr.invalidate();
  }

  count(): number {
    const row = this.liveDb.prepare("SELECT COUNT(*) as cnt FROM facts").get() as Record<string, number>;
    return row.cnt;
  }

  pruneExpired(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    // Clean up links where deleted facts are targets (except DERIVED_FROM)
    this.liveDb
      .prepare(
        `DELETE FROM memory_links
         WHERE target_fact_id IN (
           SELECT id FROM facts WHERE expires_at IS NOT NULL AND expires_at < @now
             AND (decay_freeze_until IS NULL OR decay_freeze_until <= @now)
             AND id NOT IN (SELECT fact_id FROM verified_facts)
         )
         AND link_type != 'DERIVED_FROM'`,
      )
      .run({ "@now": nowSec });
    const result = this.liveDb
      .prepare(
        `DELETE FROM facts WHERE expires_at IS NOT NULL AND expires_at < @now
                AND (decay_freeze_until IS NULL OR decay_freeze_until <= @now)
                AND id NOT IN (SELECT fact_id FROM verified_facts)`,
      )
      .run({ "@now": nowSec });
    return Number(result.changes ?? 0);
  }

  /** Prune session-scoped memories for a given session (cleared on session end). Returns count deleted. */
  pruneSessionScope(sessionId: string): number {
    // Clean up links where deleted facts are targets (except DERIVED_FROM)
    this.liveDb
      .prepare(
        `DELETE FROM memory_links
         WHERE target_fact_id IN (
           SELECT id FROM facts WHERE scope = 'session' AND scope_target = ?
             AND id NOT IN (SELECT fact_id FROM verified_facts)
         )
         AND link_type != 'DERIVED_FROM'`,
      )
      .run(sessionId);
    const result = this.liveDb
      .prepare(
        `DELETE FROM facts WHERE scope = 'session' AND scope_target = ?
                AND id NOT IN (SELECT fact_id FROM verified_facts)`,
      )
      .run(sessionId);
    return Number(result.changes ?? 0);
  }

  /** Promote a fact's scope (e.g. session → global or agent). Returns true if updated. */
  promoteScope(
    factId: string,
    newScope: "global" | "user" | "agent" | "session",
    newScopeTarget: string | null,
  ): boolean {
    const scopeTarget = newScope === "global" ? null : newScopeTarget;
    const result = this.liveDb
      .prepare("UPDATE facts SET scope = ?, scope_target = ? WHERE id = ?")
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
           AND confidence > 0.1
           AND (decay_freeze_until IS NULL OR decay_freeze_until <= @now)
           AND id NOT IN (SELECT fact_id FROM verified_facts)`,
      )
      .run({ "@now": nowSec });

    // Clean up links where deleted facts are targets (except DERIVED_FROM)
    this.liveDb
      .prepare(
        `DELETE FROM memory_links
         WHERE target_fact_id IN (
           SELECT id FROM facts WHERE confidence < 0.1
             AND (decay_freeze_until IS NULL OR decay_freeze_until <= @now)
             AND id NOT IN (SELECT fact_id FROM verified_facts)
         )
         AND link_type != 'DERIVED_FROM'`,
      )
      .run({ "@now": nowSec });
    const result = this.liveDb
      .prepare(
        `DELETE FROM facts WHERE confidence < 0.1
                AND (decay_freeze_until IS NULL OR decay_freeze_until <= @now)
                AND id NOT IN (SELECT fact_id FROM verified_facts)`,
      )
      .run({ "@now": nowSec });
    return Number(result.changes ?? 0);
  }

  confirmFact(id: string): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    const row = this.liveDb.prepare("SELECT decay_class FROM facts WHERE id = ?").get(id) as
      | { decay_class: DecayClass }
      | undefined;
    if (!row) return false;

    const newExpiry = calculateExpiry(row.decay_class, nowSec);
    this.liveDb
      .prepare("UPDATE facts SET confidence = 1.0, last_confirmed_at = ?, expires_at = ? WHERE id = ?")
      .run(nowSec, newExpiry, id);
    return true;
  }

  /**
   * Boost the confidence of a fact by a delta, clamped at maxConfidence.
   * Also increments reinforced_count and updates last_reinforced_at.
   * Returns true if the fact was found and updated.
   */
  boostConfidence(id: string, delta: number, maxConfidence = 1.0): boolean {
    return boostConfidenceHelper(this.liveDb, id, delta, maxConfidence);
  }

  /**
   * Annotate a fact with reinforcement from user praise.
   * Increments reinforced_count, updates last_reinforced_at, appends quote (max 10 quotes kept).
   * Optionally records a rich context event in reinforcement_log (#259).
   * Wraps read-modify-write in a transaction to prevent race conditions.
   * Returns true if fact was updated.
   */
  reinforceFact(
    id: string,
    quoteSnippet: string,
    context?: ReinforcementContext,
    opts?: { trackContext?: boolean; maxEventsPerFact?: number; boostAmount?: number },
  ): boolean {
    return reinforceFactHelper(this.liveDb, id, quoteSnippet, context, opts);
  }

  /**
   * Get all reinforcement events for a fact from reinforcement_log (#259).
   */
  getReinforcementEvents(factId: string): ReinforcementEvent[] {
    return getReinforcementEventsHelper(this.liveDb, factId);
  }

  /**
   * Compute diversity score from reinforcement events.
   * Filters out null/empty query snippets (treats them as fully diverse).
   * Returns 1.0 if no valid snippets exist, otherwise unique stems / valid snippet count.
   */
  private static computeDiversityFromEvents(events: ReinforcementEvent[]): number {
    return computeDiversityFromEventsHelper(events);
  }

  /**
   * Batch-fetch reinforcement events for multiple facts in a single query.
   * Returns a Map<factId, ReinforcementEvent[]> for efficient lookup.
   */
  private batchGetReinforcementEvents(factIds: string[]): Map<string, ReinforcementEvent[]> {
    return batchGetReinforcementEventsHelper(this.liveDb, factIds);
  }

  /**
   * Calculate diversity score for a fact: unique query stems / total events.
   * Score 1.0 = all events from different queries; 0.0 = all from same query (#259).
   */
  calculateDiversityScore(factId: string): number {
    return calculateDiversityScoreHelper(this.liveDb, factId);
  }

  /**
   * Phase 2: Annotate a procedure with reinforcement from user praise.
   * Increments reinforced_count, updates last_reinforced_at, appends quote (max 10 quotes kept).
   * Checks if reinforced_count reaches promotion threshold and auto-promotes if needed.
   * Wraps read-modify-write in a transaction to prevent race conditions.
   * Returns true if procedure was updated.
   */
  reinforceProcedure(id: string, quoteSnippet: string, promotionThreshold = 2): boolean {
    return reinforceProcedureHelper(this.liveDb, id, quoteSnippet, promotionThreshold);
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
        operation: "json-parse-checkpoint",
        severity: "info",
        subsystem: "facts",
      });
      return null;
    }
  }

  statsBreakdown(): Record<string, number> {
    const rows = this.liveDb
      .prepare("SELECT decay_class, COUNT(*) as cnt FROM facts GROUP BY decay_class")
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
      .prepare("SELECT source, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY source")
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
      .prepare("SELECT category, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY category")
      .all() as Array<{ category: string; cnt: number }>;
    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row.category || "other"] = row.cnt;
    }
    return stats;
  }

  /** Decay class breakdown for non-superseded facts (for dashboard stats). */
  statsBreakdownByDecayClass(): Record<string, number> {
    const rows = this.liveDb
      .prepare(
        `SELECT COALESCE(decay_class, 'stable') as decay_class, COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL GROUP BY decay_class`,
      )
      .all() as Array<{ decay_class: string; cnt: number }>;
    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row.decay_class || "stable"] = row.cnt;
    }
    return stats;
  }

  /**
   * List facts for dashboard/API: paginated, filterable by category/tier/entity, optional FTS search.
   * Returns entries in dashboard shape (snake_case for JSON) and total count.
   */
  listForDashboard(opts: {
    limit: number;
    offset: number;
    category?: string;
    tier?: string;
    decayClass?: string;
    entity?: string;
    search?: string;
  }): { facts: Array<Record<string, unknown>>; total: number } {
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      (opts.category != null && opts.category !== "" && !isValidCategory(opts.category)) ||
      (opts.tier != null && opts.tier !== "" && !DASHBOARD_TIER_FILTER.has(opts.tier)) ||
      (opts.decayClass != null && opts.decayClass !== "" && !DECAY_CLASS_FILTER.has(opts.decayClass))
    ) {
      return { facts: [], total: 0 };
    }

    let where = "superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
    const params: SQLInputValue[] = [nowSec];

    if (opts.category && isValidCategory(opts.category)) {
      where += " AND category = ?";
      params.push(opts.category);
    }
    if (opts.tier && DASHBOARD_TIER_FILTER.has(opts.tier)) {
      where += " AND COALESCE(tier, 'warm') = ?";
      params.push(opts.tier);
    }
    if (opts.decayClass && DECAY_CLASS_FILTER.has(opts.decayClass)) {
      where += " AND COALESCE(decay_class, 'stable') = ?";
      params.push(opts.decayClass);
    }
    if (opts.entity) {
      where += " AND entity = ?";
      params.push(opts.entity);
    }

    const toDashboardRow = (row: Record<string, unknown>) => ({
      id: row.id,
      text: row.text,
      category: row.category,
      importance: row.importance,
      entity: row.entity ?? null,
      key: row.key ?? null,
      value: row.value ?? null,
      tags:
        typeof row.tags === "string"
          ? (row.tags || "")
              .split(",")
              .map((t: string) => t.trim())
              .filter(Boolean)
              .join(",")
          : "",
      tier: (row.tier as string) || "warm",
      decay_class: (row.decay_class as string) || "stable",
      scope: (row.scope as string) || "global",
      confidence: row.confidence ?? 1,
      created_at: row.created_at,
      recall_count: row.recall_count ?? 0,
    });

    if (opts.search?.trim()) {
      const ftsResults = searchFts(this.liveDb, opts.search.trim(), { limit: 2000 });
      const allFtsIds = ftsResults.map((r) => r.factId);
      if (allFtsIds.length === 0) return { facts: [], total: 0 };
      // Apply category/tier/decayClass/entity filters on top of FTS results to maintain consistency
      // Chunk IDs to avoid exceeding SQLite's SQLITE_LIMIT_VARIABLE_NUMBER (default 999, often 32766)
      const CHUNK_SIZE = 500;
      const filteredIdRows: Array<{ id: string }> = [];
      for (let i = 0; i < allFtsIds.length; i += CHUNK_SIZE) {
        const chunk = allFtsIds.slice(i, i + CHUNK_SIZE);
        const idPlaceholders = chunk.map(() => "?").join(",");
        const chunkRows = this.liveDb
          .prepare(`SELECT id FROM facts WHERE id IN (${idPlaceholders}) AND ${where}`)
          .all(...chunk, ...params) as Array<{ id: string }>;
        filteredIdRows.push(...chunkRows);
      }
      const filteredSet = new Set(filteredIdRows.map((r) => r.id));
      const filteredIds = allFtsIds.filter((id) => filteredSet.has(id));
      const searchTotal = filteredIds.length;
      const pageIds = filteredIds.slice(opts.offset, opts.offset + opts.limit);
      if (pageIds.length === 0) return { facts: [], total: searchTotal };
      const placeholders = pageIds.map(() => "?").join(",");
      const pageRows = this.liveDb
        .prepare(
          `SELECT id, text, category, importance, entity, key, value, tags, COALESCE(tier, 'warm') as tier,
           COALESCE(decay_class, 'stable') as decay_class, COALESCE(scope, 'global') as scope, confidence,
           created_at, recall_count FROM facts WHERE id IN (${placeholders})`,
        )
        .all(...pageIds) as Array<Record<string, unknown>>;
      const byId = new Map<string, Record<string, unknown>>();
      for (const r of pageRows) byId.set(r.id as string, r);
      const facts = pageIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((r) => toDashboardRow(r!));
      return { facts, total: searchTotal };
    }

    const countRow = this.liveDb.prepare(`SELECT COUNT(*) as cnt FROM facts WHERE ${where}`).get(...params) as {
      cnt: number;
    };
    const total = countRow?.cnt ?? 0;

    const rows = this.liveDb
      .prepare(
        `SELECT id, text, category, importance, entity, key, value, tags, COALESCE(tier, 'warm') as tier,
         COALESCE(decay_class, 'stable') as decay_class, COALESCE(scope, 'global') as scope, confidence,
         created_at, recall_count FROM facts WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset) as Array<Record<string, unknown>>;

    const facts = rows.map((r) => toDashboardRow(r));
    return { facts, total };
  }

  /** Distinct memory categories present in non-superseded facts (for CLI stats/categories). */
  uniqueMemoryCategories(): string[] {
    const rows = this.liveDb
      .prepare("SELECT DISTINCT category FROM facts WHERE superseded_at IS NULL ORDER BY category")
      .all() as Array<{ category: string }>;
    return rows.map((r) => r.category || "other");
  }

  /** Snapshot of top procedures for context-audit (sorted by confidence). */
  getProceduresForAudit(
    limit = 5,
  ): Array<{ taskPattern: string; recipeJson: string; procedureType: "positive" | "negative"; confidence: number }> {
    try {
      const rows = this.liveDb
        .prepare(
          `SELECT task_pattern, recipe_json, procedure_type, confidence
           FROM procedures
           ORDER BY confidence DESC, COALESCE(last_validated, created_at) DESC
           LIMIT ?`,
        )
        .all(limit) as Array<{
        task_pattern: string;
        recipe_json: string;
        procedure_type: "positive" | "negative";
        confidence: number;
      }>;
      return rows.map((r) => ({
        taskPattern: r.task_pattern,
        recipeJson: r.recipe_json,
        procedureType: r.procedure_type,
        confidence: r.confidence,
      }));
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "procedures-audit",
        severity: "info",
        subsystem: "facts",
      });
      return [];
    }
  }

  /** Count of procedures (from procedures table). Returns 0 if table does not exist. */
  proceduresCount(): number {
    try {
      const row = this.liveDb.prepare("SELECT COUNT(*) as cnt FROM procedures").get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "count-procedures",
        severity: "info",
        subsystem: "facts",
      });
      return 0;
    }
  }

  /** Count of procedures with last_validated set (validated at least once). */
  proceduresValidatedCount(): number {
    try {
      const row = this.liveDb
        .prepare("SELECT COUNT(*) as cnt FROM procedures WHERE last_validated IS NOT NULL")
        .get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "count-procedures-validated",
        severity: "info",
        subsystem: "facts",
      });
      return 0;
    }
  }

  /** Count of procedures promoted to skill (promoted_to_skill = 1). */
  proceduresPromotedCount(): number {
    try {
      const row = this.liveDb.prepare("SELECT COUNT(*) as cnt FROM procedures WHERE promoted_to_skill = 1").get() as {
        cnt: number;
      };
      return row?.cnt ?? 0;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "count-procedures-promoted",
        severity: "info",
        subsystem: "facts",
      });
      return 0;
    }
  }

  /** Count of rows in memory_links (graph connections). Returns 0 if table does not exist. */
  linksCount(): number {
    try {
      const row = this.liveDb.prepare("SELECT COUNT(*) as cnt FROM memory_links").get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "count-links",
        severity: "info",
        subsystem: "facts",
      });
      return 0;
    }
  }

  /** Count of facts with source LIKE 'directive:%' (extracted directives). */
  directivesCount(): number {
    const row = this.liveDb
      .prepare(`SELECT COUNT(*) as cnt FROM facts WHERE superseded_at IS NULL AND source LIKE 'directive:%'`)
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
        operation: "count-meta-patterns",
        severity: "info",
        subsystem: "facts",
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
    const rows = this.liveDb.prepare("SELECT summary, text FROM facts WHERE superseded_at IS NULL").all() as Array<{
      summary: string | null;
      text: string;
    }>;
    return rows.reduce((sum, r) => sum + estimateTokensForDisplay(r.summary || r.text), 0);
  }

  /** Estimated tokens by tier (hot/warm/cold) for non-superseded facts. */
  estimateStoredTokensByTier(): { hot: number; warm: number; cold: number } {
    const rows = this.liveDb
      .prepare(`SELECT COALESCE(tier, 'warm') as tier, summary, text FROM facts WHERE superseded_at IS NULL`)
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
      .prepare("SELECT COUNT(*) as cnt FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?")
      .get(nowSec) as { cnt: number };
    return row.cnt;
  }

  backfillDecayClasses(): Record<string, number> {
    const rows = this.liveDb
      .prepare(`SELECT rowid, entity, key, value, text FROM facts WHERE decay_class = 'stable'`)
      .all() as Array<{ rowid: number; entity: string; key: string; value: string; text: string }>;

    const nowSec = Math.floor(Date.now() / 1000);
    const update = this.liveDb.prepare("UPDATE facts SET decay_class = ?, expires_at = ? WHERE rowid = ?");

    const counts: Record<string, number> = {};
    const tx = createTransaction(this.liveDb, () => {
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
        "SELECT * FROM facts WHERE category = ? AND (superseded_at IS NULL) ORDER BY COALESCE(source_date, created_at) DESC LIMIT ?",
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
    const result = this.liveDb.prepare("UPDATE facts SET category = ? WHERE id = ?").run(category, id);
    return result.changes > 0;
  }

  /** Get the live DB handle, reopening if closed after a SIGUSR1 restart. */
  /**
   * Expose the underlying node:sqlite DatabaseSync for services that require direct
   * SQL access (e.g. the FTS5 search service used by the RRF retrieval pipeline).
   * Returned instance is the same live handle used internally (with auto-reopen).
   */
  getRawDb(): DatabaseSync {
    return this.liveDb;
  }

  // ---------- Procedural memory: procedures table CRUD ----------

  /**
   * Load version-level feedback data for a procedure and merge into ProcedureEntry.
   * Called after the base row is mapped so we keep procedureRowToEntry pure.
   */
  private enrichProcedureWithFeedback(base: ProcedureEntry): ProcedureEntry {
    try {
      // Always compute lastOutcome from procedure's own timestamps (available even without version records)
      let lastOutcome: "success" | "failure" | "unknown" = "unknown";
      if (base.lastFailed !== null && base.lastValidated !== null) {
        lastOutcome = base.lastFailed > base.lastValidated ? "failure" : "success";
      } else if (base.lastFailed !== null) {
        lastOutcome = "failure";
      } else if (base.lastValidated !== null) {
        lastOutcome = "success";
      }

      const versionRow = this.liveDb
        .prepare(
          `SELECT pv.version_number, pv.success_count, pv.failure_count, pv.avoidance_notes
           FROM procedure_versions pv
           WHERE pv.procedure_id = ?
           ORDER BY pv.version_number DESC
           LIMIT 1`,
        )
        .get(base.id) as
        | {
            version_number: number;
            success_count: number;
            failure_count: number;
            avoidance_notes: string | null;
          }
        | undefined;

      if (!versionRow) {
        // No version records yet — return base with lastOutcome computed from procedure timestamps
        return { ...base, lastOutcome };
      }

      // Aggregate all successes and failures across ALL version records to compute overall successRate.
      // procedure_versions tracks per-version outcomes; procedure table tracks what was
      // validated/failed before version tracking started.
      const versionCounts = this.liveDb
        .prepare(
          `SELECT COALESCE(SUM(success_count), 0) as total_succ,
                  COALESCE(SUM(failure_count), 0) as total_fail
             FROM procedure_versions
             WHERE procedure_id = ?`,
        )
        .get(base.id) as { total_succ: number; total_fail: number };

      const totalSuccess = versionCounts.total_succ;
      const totalFailure = versionCounts.total_fail;
      const total = totalSuccess + totalFailure;
      const successRate = total > 0 ? totalSuccess / total : 0;

      // Merge avoidance notes across all versions
      const allNotes = new Set<string>(base.avoidanceNotes ?? []);
      if (versionRow.avoidance_notes) {
        try {
          const notes = JSON.parse(versionRow.avoidance_notes) as string[];
          notes.forEach((n) => allNotes.add(n));
        } catch {
          // ignore parse errors
        }
      }

      return {
        ...base,
        successCount: base.successCount + totalSuccess,
        failureCount: base.failureCount + totalFailure,
        version: versionRow.version_number,
        successRate,
        avoidanceNotes: allNotes.size > 0 ? Array.from(allNotes) : undefined,
        lastOutcome,
      };
    } catch {
      return base;
    }
  }

  private procedureRowToEntry(row: Record<string, unknown>): ProcedureEntry {
    const base: ProcedureEntry = {
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
            operation: "json-parse-quotes",
            severity: "info",
            subsystem: "facts",
          });
          return null;
        }
      })(),
      promotedAt: (row.promoted_at as number) ?? null,
      scope: (row.scope as string) ?? "global",
      scopeTarget: (row.scope_target as string) ?? null,
    };
    return this.enrichProcedureWithFeedback(base);
  }

  // ---------- Procedure feedback loop (#782) ----------

  /**
   * Record feedback (success or failure) for a procedure.
   *
   * On failure:
   *   - Inserts a failure record in `procedure_failures`.
   *   - Upserts a new or existing row in `procedure_versions` (increments version).
   *   - Creates an episode record via `recordEpisode()`.
   *   - Updates `last_failed` on the procedure.
   *
   * On success:
   *   - Upserts a new or existing row in `procedure_versions` (increments success count).
   *   - Updates `last_validated` on the procedure.
   *   - Updates procedure_type to 'positive'.
   *
   * Returns the procedure entry with enriched feedback fields, or null if the procedure
   * does not exist.
   */
  procedureFeedback(input: {
    procedureId: string;
    success: boolean;
    context?: string;
    failedAtStep?: number;
    tags?: string[];
    duration?: number;
    scope?: "global" | "user" | "agent" | "session";
    scopeTarget?: string | null;
    agentId?: string;
    userId?: string;
    sessionId?: string;
  }): ProcedureEntry | null {
    const nowSec = Math.floor(Date.now() / 1000);
    const proc = this.getProcedureById(input.procedureId);
    if (!proc) return null;

    if (input.success) {
      // Upsert version record with +1 success
      const existingVer = this.liveDb
        .prepare(
          "SELECT id, success_count FROM procedure_versions WHERE procedure_id = ? ORDER BY version_number DESC LIMIT 1",
        )
        .get(input.procedureId) as { id: string; success_count: number } | undefined;

      if (existingVer) {
        this.liveDb
          .prepare("UPDATE procedure_versions SET success_count = success_count + 1 WHERE id = ?")
          .run(existingVer.id);
      } else {
        // First version: create version 1 with 1 success
        this.liveDb
          .prepare(
            `INSERT INTO procedure_versions (id, procedure_id, version_number, success_count, failure_count, avoidance_notes, created_at)
             VALUES (?, ?, 1, 1, 0, NULL, ?)`,
          )
          .run(randomUUID(), input.procedureId, nowSec);
      }

      // Get aggregated counts from version table (source of truth)
      const versionCounts = this.liveDb
        .prepare(
          `SELECT COALESCE(SUM(success_count), 0) as total_succ,
                  COALESCE(SUM(failure_count), 0) as total_fail
             FROM procedure_versions
             WHERE procedure_id = ?`,
        )
        .get(input.procedureId) as { total_succ: number; total_fail: number };

      // Update procedure record (do NOT bump success_count — version table is the source of truth for counts)
      this.liveDb
        .prepare(
          `UPDATE procedures SET last_validated = ?, confidence = ?, procedure_type = 'positive', updated_at = ? WHERE id = ?`,
        )
        .run(
          nowSec,
          Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (versionCounts.total_succ - versionCounts.total_fail))),
          nowSec,
          input.procedureId,
        );
    } else {
      // Failure: insert new version record (one version per failure event) and failure record
      const latestVer = this.liveDb
        .prepare(
          "SELECT version_number FROM procedure_versions WHERE procedure_id = ? ORDER BY version_number DESC LIMIT 1",
        )
        .get(input.procedureId) as { version_number: number } | undefined;

      const newVersionNumber = (latestVer?.version_number ?? 0) + 1;

      // Build avoidance note from context
      const avoidanceNotes: string[] = [];
      if (input.context) {
        const note =
          input.failedAtStep !== undefined
            ? `v${newVersionNumber} step ${input.failedAtStep}: ${input.context}`
            : `v${newVersionNumber}: ${input.context}`;
        avoidanceNotes.push(note);
      }

      // Merge with existing avoidance notes from previous versions
      const prevNotes = this.liveDb
        .prepare("SELECT avoidance_notes FROM procedure_versions WHERE procedure_id = ?")
        .all(input.procedureId) as Array<{ avoidance_notes: string | null }>;
      for (const row of prevNotes) {
        if (row.avoidance_notes) {
          try {
            const existing = JSON.parse(row.avoidance_notes) as string[];
            avoidanceNotes.push(...existing);
          } catch {
            // ignore
          }
        }
      }

      const notesJson = avoidanceNotes.length > 0 ? JSON.stringify(avoidanceNotes) : null;

      // One version record per failure event
      this.liveDb
        .prepare(
          `INSERT INTO procedure_versions (id, procedure_id, version_number, success_count, failure_count, avoidance_notes, created_at)
           VALUES (?, ?, ?, 0, 1, ?, ?)`,
        )
        .run(randomUUID(), input.procedureId, newVersionNumber, notesJson, nowSec);

      // Insert individual failure record
      this.liveDb
        .prepare(
          `INSERT INTO procedure_failures (id, procedure_id, version_number, timestamp, context, failed_at_step)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.procedureId,
          newVersionNumber,
          nowSec,
          input.context ?? null,
          input.failedAtStep ?? null,
        );

      // Get aggregated counts from version table (source of truth)
      const versionCounts = this.liveDb
        .prepare(
          `SELECT COALESCE(SUM(success_count), 0) as total_succ,
                  COALESCE(SUM(failure_count), 0) as total_fail
             FROM procedure_versions
             WHERE procedure_id = ?`,
        )
        .get(input.procedureId) as { total_succ: number; total_fail: number };

      // Update procedure record (do NOT bump failure_count — version table is the source of truth for counts)
      this.liveDb
        .prepare(
          `UPDATE procedures SET last_failed = ?, confidence = ?, procedure_type = 'negative', updated_at = ? WHERE id = ?`,
        )
        .run(
          nowSec,
          Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (versionCounts.total_succ - versionCounts.total_fail))),
          nowSec,
          input.procedureId,
        );

      // Create an episode record for this failure
      const eventText =
        input.context && input.failedAtStep !== undefined
          ? `Procedure "${proc.taskPattern}" failed at step ${input.failedAtStep}: ${input.context}`
          : input.context
            ? `Procedure "${proc.taskPattern}" failed: ${input.context}`
            : `Procedure "${proc.taskPattern}" failed (version ${newVersionNumber})`;

      try {
        this.recordEpisode({
          event: eventText,
          outcome: "failure",
          duration: input.duration,
          context: input.context,
          procedureId: input.procedureId,
          tags: input.tags,
          importance: 0.8,
          scope: input.scope ?? "global",
          scopeTarget: (input.scope ?? "global") === "global" ? null : (input.scopeTarget ?? null),
          agentId: input.agentId,
          userId: input.userId,
          sessionId: input.sessionId,
        });
      } catch (err) {
        capturePluginError(err as Error, {
          operation: "record-episode-on-failure",
          severity: "warn",
          subsystem: "facts",
        });
      }
    }

    return this.getProcedureById(input.procedureId);
  }

  /**
   * Get all versions for a procedure, ordered newest first.
   */
  getProcedureVersions(procedureId: string): Array<{
    id: string;
    versionNumber: number;
    successCount: number;
    failureCount: number;
    avoidanceNotes: string[] | null;
    createdAt: number;
  }> {
    const rows = this.liveDb
      .prepare(
        `SELECT id, version_number, success_count, failure_count, avoidance_notes, created_at
         FROM procedure_versions
         WHERE procedure_id = ?
         ORDER BY version_number DESC`,
      )
      .all(procedureId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as string,
      versionNumber: r.version_number as number,
      successCount: r.success_count as number,
      failureCount: r.failure_count as number,
      avoidanceNotes: (() => {
        const raw = r.avoidance_notes as string | null;
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.filter((n: unknown) => typeof n === "string") : null;
        } catch {
          return null;
        }
      })(),
      createdAt: r.created_at as number,
    }));
  }

  /**
   * Get all failure records for a procedure, ordered newest first.
   */
  getProcedureFailures(procedureId: string): Array<{
    id: string;
    versionNumber: number;
    timestamp: number;
    context: string | null;
    failedAtStep: number | null;
  }> {
    const rows = this.liveDb
      .prepare(
        `SELECT id, version_number, timestamp, context, failed_at_step
         FROM procedure_failures
         WHERE procedure_id = ?
         ORDER BY timestamp DESC`,
      )
      .all(procedureId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as string,
      versionNumber: r.version_number as number,
      timestamp: r.timestamp as number,
      context: (r.context as string) ?? null,
      failedAtStep: (r.failed_at_step as number) ?? null,
    }));
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
      const successCount = proc.successCount ?? existing.successCount;
      const failureCount = proc.failureCount ?? existing.failureCount;
      const confidence = proc.confidence ?? Math.max(0.1, Math.min(0.95, 0.5 + 0.1 * (successCount - failureCount)));
      const scope = proc.scope ?? existing.scope ?? "global";
      const scopeTarget = proc.scopeTarget ?? existing.scopeTarget ?? null;
      this.liveDb
        .prepare(
          "UPDATE procedures SET task_pattern = ?, recipe_json = ?, procedure_type = ?, success_count = ?, failure_count = ?, last_validated = ?, last_failed = ?, confidence = ?, ttl_days = ?, scope = ?, scope_target = ?, updated_at = ? WHERE id = ?",
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
          scopeTarget ?? null,
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
        .prepare("SELECT * FROM procedures ORDER BY updated_at DESC, created_at DESC LIMIT ?")
        .all(limit) as Array<Record<string, unknown>>;
      return rows.map((r) => this.procedureRowToEntry(r));
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "list-procedures",
        severity: "info",
        subsystem: "facts",
      });
      return [];
    }
  }

  /** List positive procedures updated in the last N days. Days clamped to [1, 365]. */
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
        operation: "list-procedures-recent",
        severity: "info",
        subsystem: "facts",
      });
      return [];
    }
  }

  getProcedureById(id: string): ProcedureEntry | null {
    const row = this.liveDb.prepare("SELECT * FROM procedures WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.procedureRowToEntry(row);
  }

  /** Find procedure by task_pattern hash or normalized match (for dedupe). */
  findProcedureByTaskPattern(taskPattern: string, limit = 5): ProcedureEntry[] {
    const sanitized = sanitizeFts5QueryForFacts(taskPattern);
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
          "SELECT p.* FROM procedures p JOIN procedures_fts fts ON p.rowid = fts.rowid WHERE procedures_fts MATCH ? ORDER BY rank LIMIT ?",
        )
        .all(safeQuery, limit) as Array<Record<string, unknown>>;
      return rows.map((r) => this.procedureRowToEntry(r));
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "fts-query",
        severity: "info",
        subsystem: "facts",
      });
      return [];
    }
  }

  /**
   * Search procedures by task description (FTS). Returns positive procedures first, then negative.
   * Phase 2: Applies reinforcement boost to score when reinforced_count > 0.
   */
  searchProcedures(
    taskDescription: string,
    limit = 10,
    reinforcementBoost = 0.1,
    scopeFilter?: ScopeFilter,
  ): ProcedureEntry[] {
    const sanitized = sanitizeFts5QueryForFacts(taskDescription);
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
      const rows = this.liveDb.prepare(baseSql).all(safeQuery, ...scopeParams, limit * 2) as Array<
        Record<string, unknown>
      >;

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
        operation: "fts-query",
        severity: "info",
        subsystem: "facts",
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
  searchProceduresRanked(
    taskDescription: string,
    limit = 10,
    reinforcementBoost = 0.1,
    scopeFilter?: ScopeFilter,
  ): Array<ProcedureEntry & { relevanceScore: number }> {
    const sanitized = sanitizeFts5QueryForFacts(taskDescription);
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
        const recencyFactor =
          ageSeconds > RECENCY_WINDOW
            ? MIN_RECENCY_FACTOR
            : Math.max(MIN_RECENCY_FACTOR, 1 - ageSeconds / RECENCY_WINDOW);

        // Success rate (50-100% weight based on successCount/failureCount)
        const totalTrials = proc.successCount + proc.failureCount;
        let successRateWeight = 0.75; // default for never-validated
        if (totalTrials > 0) {
          const successRate = proc.successCount / totalTrials;
          successRateWeight = 0.5 + successRate * 0.5; // 50% base + up to 50% from success rate
        }

        // Penalty for recent failures (last 7 days)
        let recentFailurePenalty = 1.0;
        if (proc.lastFailed && nowSec - proc.lastFailed < RECENT_FAILURE_WINDOW) {
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
        const relevanceScore = Math.min(
          1.0,
          baseScore * recencyFactor * successRateWeight * recentFailurePenalty * validationPenalty,
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
        operation: "fts-query",
        severity: "info",
        subsystem: "facts",
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
      .prepare("UPDATE procedures SET promoted_to_skill = 1, skill_path = ?, updated_at = ? WHERE id = ?")
      .run(skillPath, Math.floor(Date.now() / 1000), id);
    return result.changes > 0;
  }

  /** Procedures that are past TTL (last_validated older than ttl_days). For revalidation/decay. */
  getStaleProcedures(ttlDays: number, limit = 100): ProcedureEntry[] {
    const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 24 * 3600;
    const rows = this.liveDb
      .prepare(
        "SELECT * FROM procedures WHERE last_validated < ? OR (last_validated IS NULL AND created_at < ?) ORDER BY last_validated DESC NULLS LAST LIMIT ?",
      )
      .all(cutoff, cutoff, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.procedureRowToEntry(r));
  }

  /** Alias for pruneExpired() for backward compatibility */
  prune(): number {
    return this.pruneExpired();
  }

  /**
   * Remove orphaned rows from memory_links where source_fact_id or
   * target_fact_id no longer reference an existing fact.
   * Returns the number of deleted rows.
   */
  pruneOrphanedLinks(): number {
    const result = this.liveDb
      .prepare(
        `DELETE FROM memory_links
         WHERE (NOT EXISTS (SELECT 1 FROM facts WHERE facts.id = memory_links.source_fact_id)
            OR NOT EXISTS (SELECT 1 FROM facts WHERE facts.id = memory_links.target_fact_id))
           AND link_type != 'DERIVED_FROM'`,
      )
      .run();
    return Number(result.changes ?? 0);
  }

  /** Alias for backfillDecayClasses() for backward compatibility */
  backfillDecay(): Record<string, number> {
    return this.backfillDecayClasses();
  }

  /**
   * Prune log tables that accumulate indefinitely (Issue #573).
   * Deletes rows older than `retentionDays` from recall/reinforcement/feedback logs.
   */
  pruneLogTables(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
    const recall = this.liveDb.prepare("DELETE FROM recall_log WHERE occurred_at < ?").run(cutoff);
    const reinforcement = this.liveDb.prepare("DELETE FROM reinforcement_log WHERE occurred_at < ?").run(cutoff);
    const feedback = this.liveDb.prepare("DELETE FROM feedback_trajectories WHERE created_at < ?").run(cutoff);
    return Number(recall.changes ?? 0) + Number(reinforcement.changes ?? 0) + Number(feedback.changes ?? 0);
  }

  /** Compact FTS5 shadow tables after bulk deletes. */
  optimizeFts(): void {
    this.liveDb.exec(`INSERT INTO facts_fts(facts_fts) VALUES('optimize')`);
  }

  /** Reclaim freed pages and truncate WAL after maintenance work. */
  vacuumAndCheckpoint(): void {
    this.liveDb.exec("VACUUM");
    this.liveDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  /** Get reflection statistics */
  statsReflection(): { reflectionPatternsCount: number; reflectionRulesCount: number } {
    const patternsRow = this.liveDb
      .prepare(
        `SELECT COUNT(*) as count FROM facts WHERE superseded_at IS NULL AND source = 'reflection' AND category = 'pattern'`,
      )
      .get() as { count: number } | undefined;
    const rulesRow = this.liveDb
      .prepare(
        `SELECT COUNT(*) as count FROM facts WHERE superseded_at IS NULL AND source = 'reflection' AND category = 'rule'`,
      )
      .get() as { count: number } | undefined;
    return {
      reflectionPatternsCount: patternsRow?.count ?? 0,
      reflectionRulesCount: rulesRow?.count ?? 0,
    };
  }

  /** Get self-correction incidents count */
  selfCorrectionIncidentsCount(): number {
    const row = this.liveDb
      .prepare(`SELECT COUNT(*) as count FROM facts WHERE superseded_at IS NULL AND source = 'self-correction'`)
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** Count non-superseded facts with the given source string. Used for document dedup checks. */
  countBySource(source: string): number {
    const row = this.liveDb
      .prepare("SELECT COUNT(*) as count FROM facts WHERE superseded_at IS NULL AND source = ?")
      .get(source) as { count: number } | undefined;
    return row?.count ?? 0;
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
        for (const [_key, val] of Object.entries(lang as Record<string, unknown>)) {
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
      .prepare("SELECT source, COUNT(*) as count FROM facts WHERE superseded_at IS NULL GROUP BY source")
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
      .prepare("SELECT DISTINCT scope, scope_target as scopeTarget FROM facts WHERE scope IS NOT NULL")
      .all() as Array<{ scope: string; scopeTarget: string | null }>;
    return rows;
  }

  /** Get statistics by scope */
  scopeStats(): Array<{ scope: string; scopeTarget: string | null; count: number }> {
    const rows = this.liveDb
      .prepare(
        "SELECT scope, scope_target as scopeTarget, COUNT(*) as count FROM facts WHERE scope IS NOT NULL GROUP BY scope, scope_target",
      )
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

    // Clean up links where deleted facts are targets (except DERIVED_FROM)
    const linkCleanupQuery = `DELETE FROM memory_links
      WHERE target_fact_id IN (
        SELECT id FROM facts WHERE ${conditions.join(" OR ")}
      )
      AND link_type != 'DERIVED_FROM'`;
    this.liveDb.prepare(linkCleanupQuery).run(...params);

    const query = `DELETE FROM facts WHERE ${conditions.join(" OR ")}`;
    const result = this.liveDb.prepare(query).run(...params);
    return Number(result.changes ?? 0);
  }

  /**
   * Find session-scoped facts eligible for promotion.
   * Returns facts where scope='session', importance >= minImportance,
   * created more than thresholdDays ago, and not superseded.
   */
  findSessionFactsForPromotion(thresholdDays: number, minImportance: number): MemoryEntry[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const thresholdSec = nowSec - thresholdDays * 86400;
    const rows = this.liveDb
      .prepare(
        `SELECT * FROM facts
         WHERE scope = 'session'
           AND importance >= ?
           AND created_at <= ?
           AND superseded_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(minImportance, thresholdSec, nowSec) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  // ============================================================================
  // Contradiction Detection (Issue #157)
  // ============================================================================

  /**
   * Update a fact's confidence by `delta` (negative to reduce), with a floor of 0.1.
   * Returns the new confidence value, or null if the fact was not found.
   */
  updateConfidence(id: string, delta: number): number | null {
    // Atomic single-statement UPDATE with RETURNING-like pattern.
    // No explicit transaction wrapper needed — node:sqlite is synchronous,
    // and this method is also called from within recordContradiction's transaction
    // where createTransaction() handles nested SAVEPOINT semantics.
    const row = this.liveDb.prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as
      | { confidence: number }
      | undefined;
    if (!row) return null;
    const current = row.confidence ?? 1.0;
    const updated = Math.max(0.1, Math.min(1.0, current + delta));
    this.liveDb.prepare("UPDATE facts SET confidence = ? WHERE id = ?").run(updated, id);
    return updated;
  }

  /**
   * Set a fact's confidence to a specific value (clamped to 0.1–1 to match updateConfidence floor).
   * Returns the new confidence value, or null if the fact was not found.
   */
  setConfidenceTo(id: string, value: number): number | null {
    const row = this.liveDb.prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as
      | { confidence: number }
      | undefined;
    if (!row) return null;
    const updated = Math.max(0.1, Math.min(1, value));
    this.liveDb.prepare("UPDATE facts SET confidence = ? WHERE id = ?").run(updated, id);
    return updated;
  }

  /**
   * Add a tag to a fact (no-op if already present or fact missing).
   */
  addTag(id: string, tag: string): void {
    const trimmed = tag.trim();
    const normalized = trimmed.toLowerCase();
    // Reject tags that would break the comma-separated storage format.
    if (!normalized || normalized.includes(",")) return;
    const row = this.liveDb.prepare("SELECT tags FROM facts WHERE id = ?").get(id) as
      | { tags: string | null }
      | undefined;
    if (!row) return;
    const tags = parseTags(row.tags);
    // Case-insensitive duplicate check (existing tags may be mixed-case in storage).
    if (tags.some((t) => t.toLowerCase() === normalized)) return;
    tags.push(normalized);
    this.liveDb.prepare("UPDATE facts SET tags = ? WHERE id = ?").run(serializeTags(tags), id);
  }

  /**
   * Find active (non-superseded, non-expired) facts with the same entity and key but a
   * different value. Returns facts ordered newest-first.
   *
   * When `scope` is provided, only facts in the same scope (and same scope_target when
   * non-null) are returned, preventing cross-scope contradiction detection.
   */
  findConflictingFacts(
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
    const rows = this.liveDb
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
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Record a contradiction between two facts:
   *   1. Insert a row into the `contradictions` table.
   *   2. Create a CONTRADICTS link from newFactId → oldFactId in memory_links.
   *   3. Reduce confidence on the old fact by 0.2 (floor at 0.1).
   *
   * Returns the new contradiction record id.
   */
  recordContradiction(factIdNew: string, factIdOld: string): string {
    const id = randomUUID();
    const detectedAt = new Date().toISOString();

    const tx = createTransaction(this.liveDb, () => {
      // Get the old fact's current confidence before reducing it
      const oldFactRow = this.liveDb.prepare("SELECT confidence FROM facts WHERE id = ?").get(factIdOld) as
        | { confidence: number }
        | undefined;
      const originalConfidence = oldFactRow?.confidence ?? 1.0;

      this.liveDb
        .prepare(
          `INSERT INTO contradictions (id, fact_id_new, fact_id_old, detected_at, resolved, resolution, old_fact_original_confidence)
           VALUES (?, ?, ?, ?, 0, NULL, ?)`,
        )
        .run(id, factIdNew, factIdOld, detectedAt, originalConfidence);

      // Store a single directed link (new→old). getContradictedIds queries both directions.
      this.createLink(factIdNew, factIdOld, "CONTRADICTS", 1.0);

      this.updateConfidence(factIdOld, -0.2);
    });
    tx();
    return id;
  }

  /**
   * Detect contradictions for a newly stored fact and record them.
   * Only runs when entity, key, and value are all non-empty.
   *
   * Pass `scope` and `scopeTarget` (from the new fact) to restrict detection to the same
   * memory scope, preventing cross-scope contradiction detection.
   *
   * Returns an array of { contradictionId, oldFactId } for each contradiction found.
   */
  detectContradictions(
    newFactId: string,
    entity: string | null | undefined,
    key: string | null | undefined,
    value: string | null | undefined,
    scope?: string | null,
    scopeTarget?: string | null,
  ): Array<{ contradictionId: string; oldFactId: string }> {
    if (!entity?.trim() || !key?.trim() || !value?.trim()) return [];

    const conflicting = this.findConflictingFacts(
      entity.trim(),
      key.trim(),
      value.trim(),
      newFactId,
      scope,
      scopeTarget,
    );
    const results: Array<{ contradictionId: string; oldFactId: string }> = [];

    for (const old of conflicting) {
      // findConflictingFacts already filters by different value, but guard for safety
      if (old.value?.toLowerCase() === value.trim().toLowerCase()) continue;
      const contradictionId = this.recordContradiction(newFactId, old.id);
      results.push({ contradictionId, oldFactId: old.id });
    }

    return results;
  }

  /**
   * Get contradiction records involving a specific fact (as new or old).
   * If no factId given, returns all unresolved contradictions.
   */
  getContradictions(factId?: string): ContradictionRecord[] {
    const rows = factId
      ? (this.liveDb
          .prepare("SELECT * FROM contradictions WHERE fact_id_new = ? OR fact_id_old = ? ORDER BY detected_at DESC")
          .all(factId, factId) as Array<Record<string, unknown>>)
      : (this.liveDb
          .prepare("SELECT * FROM contradictions WHERE resolved = 0 ORDER BY detected_at DESC")
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => ({
      id: r.id as string,
      factIdNew: r.fact_id_new as string,
      factIdOld: r.fact_id_old as string,
      detectedAt: r.detected_at as string,
      resolved: (r.resolved as number) === 1,
      resolution: (r.resolution as "superseded" | "kept" | "merged" | null) ?? null,
      oldFactOriginalConfidence: r.old_fact_original_confidence as number | undefined,
    }));
  }

  /**
   * Mark a contradiction as resolved with the given strategy.
   * Returns true if the record was found and updated.
   */
  resolveContradiction(contradictionId: string, resolution: "superseded" | "kept" | "merged"): boolean {
    const result = this.liveDb
      .prepare("UPDATE contradictions SET resolved = 1, resolution = ? WHERE id = ? AND resolved = 0")
      .run(resolution, contradictionId);
    return result.changes > 0;
  }

  /**
   * Check if a fact is involved in any active (unresolved) contradiction,
   * either as the old or the new fact.
   */
  isContradicted(factId: string): boolean {
    const row = this.liveDb
      .prepare("SELECT 1 FROM contradictions WHERE (fact_id_old = ? OR fact_id_new = ?) AND resolved = 0 LIMIT 1")
      .get(factId, factId);
    return row != null;
  }

  /**
   * Batch check: return the subset of factIds that are involved in any
   * active (unresolved) contradiction (as old or new fact).
   * Processes in chunks of 499 to stay within SQLite's default
   * SQLITE_LIMIT_VARIABLE_NUMBER (999) when doubling the parameter list for the UNION.
   */
  getContradictedIds(factIds: string[]): Set<string> {
    if (factIds.length === 0) return new Set();
    const result = new Set<string>();
    // Each chunk is used twice in the UNION query, so keep chunk ≤ 499 (total ≤ 998).
    const CHUNK = 499;
    for (let i = 0; i < factIds.length; i += CHUNK) {
      const chunk = factIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.liveDb
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

  /**
   * Nightly resolution stub (Issue #157 / foundation for #143 Dream Cycle).
   *
   * For each unresolved contradiction pair, applies auto-resolution when the
   * newer fact is clearly more authoritative (higher confidence, newer, from an
   * explicit user store).  Ambiguous cases are returned for future LLM resolution.
   */
  resolveContradictions(): {
    autoResolved: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
    ambiguous: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }>;
  } {
    const unresolved = this.getContradictions();
    const autoResolved: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }> = [];
    const ambiguous: Array<{ contradictionId: string; factIdNew: string; factIdOld: string }> = [];

    for (const c of unresolved) {
      const newFact = this.getById(c.factIdNew);
      const oldFact = this.getById(c.factIdOld);

      if (!newFact && !oldFact) {
        // Both facts deleted — resolve as superseded, nothing further to do
        this.resolveContradiction(c.id, "superseded");
        autoResolved.push({ contradictionId: c.id, factIdNew: c.factIdNew, factIdOld: c.factIdOld });
        continue;
      }

      if (!newFact && oldFact) {
        // New/contradicting fact was deleted; old fact survives — keep it and restore confidence
        this.resolveContradiction(c.id, "kept");
        if (c.oldFactOriginalConfidence != null) {
          this.liveDb
            .prepare("UPDATE facts SET confidence = ? WHERE id = ?")
            .run(c.oldFactOriginalConfidence, c.factIdOld);
        }
        autoResolved.push({ contradictionId: c.id, factIdNew: c.factIdNew, factIdOld: c.factIdOld });
        continue;
      }

      if (newFact && !oldFact) {
        // Old fact was deleted; new fact is authoritative — supersede
        this.resolveContradiction(c.id, "superseded");
        autoResolved.push({ contradictionId: c.id, factIdNew: c.factIdNew, factIdOld: c.factIdOld });
        continue;
      }

      // Both facts exist — compare them (all single-null cases handled above with continue)
      const resolvedNew = newFact!;
      const resolvedOld = oldFact!;
      const newConf = resolvedNew.confidence ?? 1.0;
      // Use the original confidence before system reduction, if available
      const oldConf = c.oldFactOriginalConfidence ?? resolvedOld.confidence ?? 1.0;
      const newIsNewer = resolvedNew.createdAt >= resolvedOld.createdAt;
      const newIsHigherConf = newConf > oldConf;
      const newIsFromUser = resolvedNew.source === "conversation" || resolvedNew.source === "cli";

      if (newIsNewer && newIsHigherConf && newIsFromUser) {
        this.resolveContradiction(c.id, "superseded");
        this.supersede(c.factIdOld, c.factIdNew);
        autoResolved.push({ contradictionId: c.id, factIdNew: c.factIdNew, factIdOld: c.factIdOld });
      } else {
        ambiguous.push({ contradictionId: c.id, factIdNew: c.factIdNew, factIdOld: c.factIdOld });
      }
    }

    return { autoResolved, ambiguous };
  }

  /** Count of unresolved contradictions. */
  contradictionsCount(): number {
    try {
      const row = this.liveDb.prepare("SELECT COUNT(*) as cnt FROM contradictions WHERE resolved = 0").get() as {
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

  // ---------------------------------------------------------------------------
  // Auto-linking helpers (Issue #154)
  // ---------------------------------------------------------------------------

  /**
   * Return all distinct non-null entity names for active (non-superseded) facts.
   * Used by entity-matching auto-linker at write time.
   */
  getKnownEntities(): string[] {
    const now = Date.now();
    if (this.knownEntitiesCache !== null && now - this.knownEntitiesCacheTime < this.KNOWN_ENTITIES_CACHE_TTL_MS) {
      return this.knownEntitiesCache;
    }
    const rows = this.liveDb
      .prepare("SELECT DISTINCT entity FROM facts WHERE entity IS NOT NULL AND superseded_at IS NULL")
      .all() as Array<{ entity: string }>;
    this.knownEntitiesCache = rows.map((r) => r.entity);
    this.knownEntitiesCacheTime = now;
    return this.knownEntitiesCache;
  }

  /**
   * Extract entity mentions from a fact's text using:
   *   1. Known-entity matching — exact word-boundary (weight 1.0) or substring (weight 0.7).
   *   2. Simple NER — IPv4 regex (weight 0.5).
   *
   * Returns unique {entity, weight} pairs sorted by descending weight.
   */
  extractEntitiesFromText(text: string, knownEntities: string[]): Array<{ entity: string; weight: number }> {
    const seen = new Map<string, number>();
    const lowerText = text.toLowerCase();

    for (const entity of knownEntities) {
      if (!entity) continue;
      const lowerEntity = entity.toLowerCase();

      // Fast gate: skip if entity is not even a substring
      if (!lowerText.includes(lowerEntity)) continue;

      // Exact whole-word match
      const escapedForRegex = lowerEntity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const wordBoundaryRe = new RegExp(`\\b${escapedForRegex}\\b`);
      if (wordBoundaryRe.test(lowerText)) {
        const current = seen.get(entity) ?? 0;
        if (current < 1.0) seen.set(entity, 1.0);
        continue;
      }

      // Substring match (no word boundary required)
      const current = seen.get(entity) ?? 0;
      if (current < 0.7) seen.set(entity, 0.7);
    }

    // IPv4 NER
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

  /**
   * Find the most recent active (non-superseded, non-expired) fact anchoring an entity.
   * Returns null if no such fact exists.
   */
  findEntityAnchor(entity: string, excludeId?: string): MemoryEntry | null {
    const nowSec = Math.floor(Date.now() / 1000);
    const excludeClause = excludeId ? "AND id != ?" : "";
    const params = excludeId ? [entity, nowSec, excludeId] : [entity, nowSec];
    const row = this.liveDb
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
    return row ? this.rowToEntry(row) : null;
  }

  /**
   * Detect INSTANCE_OF patterns in fact text and create INSTANCE_OF links.
   *
   * Matches patterns:
   *   - "is a <type>" / "is an <type>"
   *   - "type of <type>"
   *   - "kind of <type>"
   *
   * When a match is found and the type noun is a known entity with an anchor fact,
   * creates an INSTANCE_OF link from newFactId → anchor fact.
   *
   * Returns the number of INSTANCE_OF links created.
   */
  autoDetectInstanceOf(newFactId: string, text: string, knownEntities?: string[]): number {
    const patterns = [
      /\bis\s+an?\s+([a-zA-Z][a-zA-Z0-9 _-]{1,40}?)(?:\s*[,;.!?]|$)/gi,
      /\btype\s+of\s+([a-zA-Z][a-zA-Z0-9 _-]{1,40}?)(?:\s*[,;.!?]|$)/gi,
      /\bkind\s+of\s+([a-zA-Z][a-zA-Z0-9 _-]{1,40}?)(?:\s*[,;.!?]|$)/gi,
    ];

    const candidates = new Set<string>();
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      // Reset lastIndex before each use (global flag)
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        const typeName = match[1].trim().toLowerCase();
        if (typeName.length >= 2) candidates.add(typeName);
      }
    }

    if (candidates.size === 0) return 0;

    const entities = knownEntities ?? this.getKnownEntities();
    const knownEntitiesSet = new Set(entities.map((e) => e.toLowerCase()));
    let linked = 0;

    for (const typeName of candidates) {
      // Only link to types that are known entities in the knowledge base
      if (!knownEntitiesSet.has(typeName)) continue;
      const anchor = this.findEntityAnchor(typeName, newFactId);
      if (!anchor) continue;
      // Avoid duplicate INSTANCE_OF links
      const existing = this.liveDb
        .prepare(
          `SELECT id FROM memory_links
           WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'INSTANCE_OF'`,
        )
        .get(newFactId, anchor.id);
      if (!existing) {
        this.createLink(newFactId, anchor.id, "INSTANCE_OF", 1.0);
        linked++;
      }
    }

    return linked;
  }

  /**
   * Auto-link a newly stored fact to related facts at write time (Issue #154).
   *
   * Steps:
   *   1. Known-entity matching + IP NER → RELATES_TO edges to entity anchor facts.
   *   2. Temporal co-occurrence — facts in the same session with entity/tag overlap
   *      get weak RELATES_TO edges.
   *   3. Supersession detection — if entity+key matches an existing fact with a
   *      different value, create a SUPERSEDES edge and (when autoSupersede is true)
   *      mark the old fact as superseded and reduce its confidence.
   *   4. INSTANCE_OF auto-detection — matches "is a/an X", "type of X", and "kind of X" patterns.
   *
   * Returns { linkedCount, supersededIds } for use in the response message.
   */
  autoLinkEntities(
    newFactId: string,
    text: string,
    entity: string | null,
    key: string | null,
    sessionId: string | null,
    cfg: { coOccurrenceWeight: number; autoSupersede: boolean },
    scope?: string | null,
    scopeTarget?: string | null,
  ): { linkedCount: number; supersededIds: string[] } {
    let linkedCount = 0;
    const supersededIds: string[] = [];

    // Step 1: Known-entity + IP matching
    const knownEntities = this.getKnownEntities();
    const mentions = this.extractEntitiesFromText(text, knownEntities);

    for (const { entity: mentionedEntity, weight } of mentions) {
      const anchor = this.findEntityAnchor(mentionedEntity, newFactId);
      if (!anchor) continue;
      // Avoid duplicate links (don't recreate if link already exists)
      const existing = this.liveDb
        .prepare(
          `SELECT id FROM memory_links
           WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'RELATED_TO'`,
        )
        .get(newFactId, anchor.id);
      if (!existing) {
        this.createLink(newFactId, anchor.id, "RELATED_TO", weight);
        linkedCount++;
      }
    }

    // Step 2: Temporal co-occurrence — other facts from the same session
    if (sessionId) {
      const nowSec = Math.floor(Date.now() / 1000);
      // Look for facts stored in the same session (via source_sessions column)
      // Also accept entity or tag overlap as qualifying co-occurrence signal
      const escapedSessionId = sessionId.replace(/[\\%_]/g, "\\$&");
      const recentRows = this.liveDb
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
        const coEntry = this.rowToEntry(row);
        // Skip if already linked
        const existing = this.liveDb
          .prepare(
            `SELECT id FROM memory_links
             WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'RELATED_TO'`,
          )
          .get(newFactId, coEntry.id);
        if (!existing) {
          this.createLink(newFactId, coEntry.id, "RELATED_TO", cfg.coOccurrenceWeight);
          linkedCount++;
        }
      }
    }

    // Step 3: Supersession detection
    if (entity?.trim() && key?.trim()) {
      const nowSec = Math.floor(Date.now() / 1000);
      const scopeClause = scope
        ? scopeTarget != null
          ? "AND scope = ? AND scope_target = ?"
          : "AND scope = ? AND scope_target IS NULL"
        : "";
      const baseParams: SQLInputValue[] = [entity.trim(), key.trim(), newFactId, nowSec];
      const scopeParams: SQLInputValue[] = scope ? (scopeTarget != null ? [scope, scopeTarget] : [scope]) : [];
      const conflicting = this.liveDb
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
        ((
          this.liveDb.prepare("SELECT value FROM facts WHERE id = ?").get(newFactId) as
            | { value: string | null }
            | undefined
        )?.value as string) ?? null;

      // Skip supersession entirely when new fact has no value — a valueless fact
      // cannot meaningfully supersede an existing value.
      if (newVal !== null) {
        for (const row of conflicting) {
          const oldFact = this.rowToEntry(row);
          // Only create SUPERSEDES edge when value actually differs
          if (oldFact.value !== null && newVal.toLowerCase() === oldFact.value.toLowerCase()) continue;

          // Create SUPERSEDES link (new → old)
          const alreadyLinked = this.liveDb
            .prepare(
              `SELECT id FROM memory_links
               WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = 'SUPERSEDES'`,
            )
            .get(newFactId, oldFact.id);
          if (!alreadyLinked) {
            this.createLink(newFactId, oldFact.id, "SUPERSEDES", 1.0);

            if (cfg.autoSupersede) {
              // Mark old fact as superseded
              this.supersede(oldFact.id, newFactId);

              // Only reduce confidence if no contradiction was already recorded
              // (detectContradictions already applied -0.2 penalty)
              const existingContradiction = this.liveDb
                .prepare(
                  `SELECT id FROM contradictions
                   WHERE fact_id_new = ? AND fact_id_old = ?`,
                )
                .get(newFactId, oldFact.id);
              if (!existingContradiction) {
                this.updateConfidence(oldFact.id, -0.2);
              }
              supersededIds.push(oldFact.id);
            }
          }
        }
      }
    }

    // Step 4: INSTANCE_OF auto-detection
    linkedCount += this.autoDetectInstanceOf(newFactId, text, knownEntities);

    return { linkedCount, supersededIds };
  }

  // ---------------------------------------------------------------------------
  // Topic cluster storage (Issue #146)
  // ---------------------------------------------------------------------------

  /** Create clusters and cluster_members tables for topic cluster storage. */
  private migrateClusterTables(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS clusters (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        fact_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS cluster_members (
        cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
        fact_id TEXT NOT NULL,
        PRIMARY KEY (cluster_id, fact_id)
      )
    `);
    this.liveDb.exec("CREATE INDEX IF NOT EXISTS idx_cluster_members_fact ON cluster_members(fact_id)");
  }

  /**
   * Get all unique fact IDs that participate in at least one memory link
   * (as source or target). Used by cluster detection.
   */
  getAllLinkedFactIds(): string[] {
    const rows = this.liveDb
      .prepare(
        `SELECT DISTINCT id FROM (
          SELECT source_fact_id AS id FROM memory_links
          UNION
          SELECT target_fact_id AS id FROM memory_links
        )`,
      )
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /**
   * Get all edges from memory_links as sourceFactId/targetFactId pairs.
   * Used for building the cluster adjacency map in a single query.
   */
  getAllLinks(): Array<{ sourceFactId: string; targetFactId: string }> {
    const rows = this.liveDb.prepare("SELECT source_fact_id, target_fact_id FROM memory_links").all() as Array<{
      source_fact_id: string;
      target_fact_id: string;
    }>;
    return rows.map((r) => ({
      sourceFactId: r.source_fact_id,
      targetFactId: r.target_fact_id,
    }));
  }

  /**
   * Get edges with link_type and strength for dashboard graph (optionally limited).
   */
  getAllEdges(limit = 5000): Array<{ source: string; target: string; link_type: string; strength: number }> {
    const rows = this.liveDb
      .prepare("SELECT source_fact_id, target_fact_id, link_type, strength FROM memory_links LIMIT ?")
      .all(limit) as Array<{ source_fact_id: string; target_fact_id: string; link_type: string; strength: number }>;
    return rows.map((r) => ({
      source: r.source_fact_id,
      target: r.target_fact_id,
      link_type: r.link_type || "RELATED_TO",
      strength: r.strength ?? 0.8,
    }));
  }

  /**
   * Persist detected clusters, replacing all existing cluster data.
   * Runs in a single transaction for atomicity.
   */
  saveClusters(
    clusters: Array<{
      id: string;
      label: string;
      factIds: string[];
      factCount: number;
      createdAt: number;
      updatedAt: number;
    }>,
  ): void {
    const insertCluster = this.liveDb.prepare(
      "INSERT OR REPLACE INTO clusters (id, label, fact_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const insertMember = this.liveDb.prepare(
      "INSERT OR IGNORE INTO cluster_members (cluster_id, fact_id) VALUES (?, ?)",
    );

    createTransaction(this.liveDb, () => {
      // Replace all clusters
      this.liveDb.exec("DELETE FROM cluster_members");
      this.liveDb.exec("DELETE FROM clusters");
      for (const cluster of clusters) {
        insertCluster.run(cluster.id, cluster.label, cluster.factCount, cluster.createdAt, cluster.updatedAt);
        for (const factId of cluster.factIds) {
          insertMember.run(cluster.id, factId);
        }
      }
    })();
  }

  /** Get all stored clusters (without member IDs). Sorted by fact_count desc. */
  getClusters(): Array<{ id: string; label: string; factCount: number; createdAt: number; updatedAt: number }> {
    const rows = this.liveDb
      .prepare("SELECT id, label, fact_count, created_at, updated_at FROM clusters ORDER BY fact_count DESC")
      .all() as Array<{ id: string; label: string; fact_count: number; created_at: number; updated_at: number }>;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      factCount: r.fact_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** Get member fact IDs for a specific cluster. */
  getClusterMembers(clusterId: string): string[] {
    const rows = this.liveDb
      .prepare("SELECT fact_id FROM cluster_members WHERE cluster_id = ?")
      .all(clusterId) as Array<{ fact_id: string }>;
    return rows.map((r) => r.fact_id);
  }

  /** Get the cluster ID that a given fact belongs to (null if not in any cluster). */
  getFactClusterId(factId: string): string | null {
    const row = this.liveDb.prepare("SELECT cluster_id FROM cluster_members WHERE fact_id = ?").get(factId) as
      | { cluster_id: string }
      | undefined;
    return row?.cluster_id ?? null;
  }

  // ============================================================================
  // Episodic Memory (#781)
  // ============================================================================

  /**
   * Store an episodic memory record (#781).
   *
   * Episodes with outcome="failure" are auto-boosted to importance >= 0.8.
   * Related facts are linked via memory_links if relatedFactIds is provided.
   */
  recordEpisode(input: {
    event: string;
    outcome: EpisodeOutcome;
    timestamp?: number;
    duration?: number;
    context?: string;
    relatedFactIds?: string[];
    procedureId?: string;
    importance?: number;
    tags?: string[];
    decayClass?: DecayClass;
    scope?: "global" | "user" | "agent" | "session";
    scopeTarget?: string | null;
    agentId?: string;
    userId?: string;
    sessionId?: string;
  }): Episode {
    const id = randomUUID();
    const nowSec = Math.floor(Date.now() / 1000);
    const timestamp = input.timestamp ?? nowSec;

    // Auto-boost failures to importance >= 0.8
    let importance = input.importance ?? 0.5;
    if (input.outcome === "failure" && importance < 0.8) {
      importance = 0.8;
    }

    const decayClass = input.decayClass ?? "normal";
    const scope = input.scope ?? "global";
    const scopeTarget = scope === "global" ? null : (input.scopeTarget ?? null);
    const tags = input.tags ?? [];
    const relatedFactIds = input.relatedFactIds ?? [];

    const tx = createTransaction(this.liveDb, () => {
      this.liveDb
        .prepare(
          `INSERT INTO episodes (id, event, outcome, timestamp, duration, context, related_fact_ids, procedure_id, scope, scope_target, agent_id, user_id, session_id, importance, tags, decay_class, created_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.event,
          input.outcome,
          timestamp,
          input.duration ?? null,
          input.context ?? null,
          relatedFactIds.length > 0 ? JSON.stringify(relatedFactIds) : null,
          input.procedureId ?? null,
          scope,
          scopeTarget,
          input.agentId ?? null,
          input.userId ?? null,
          input.sessionId ?? null,
          importance,
          serializeTags(tags),
          decayClass,
          nowSec,
          null,
        );

      for (const factId of relatedFactIds) {
        this.liveDb
          .prepare(
            "INSERT INTO episode_relations (id, episode_id, target_id, relation_type, strength, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(randomUUID(), id, factId, "PART_OF", 0.8, nowSec);
      }
    });
    tx();

    return {
      id,
      category: "episode",
      event: input.event,
      outcome: input.outcome,
      timestamp,
      duration: input.duration,
      context: input.context,
      relatedFactIds,
      procedureId: input.procedureId,
      scope,
      scopeTarget: scopeTarget ?? undefined,
      agentId: input.agentId,
      userId: input.userId,
      sessionId: input.sessionId,
      importance,
      tags,
      decayClass,
      createdAt: nowSec,
    };
  }

  /**
   * Convert a raw SQLite episodes row to an Episode object.
   */
  private rowToEpisode(row: Record<string, unknown>): Episode {
    const relatedFactIdsRaw = row.related_fact_ids as string | null;
    return {
      id: row.id as string,
      category: "episode",
      event: row.event as string,
      outcome: row.outcome as EpisodeOutcome,
      timestamp: row.timestamp as number,
      duration: (row.duration as number) ?? undefined,
      context: (row.context as string) ?? undefined,
      relatedFactIds: relatedFactIdsRaw ? (JSON.parse(relatedFactIdsRaw) as string[]) : undefined,
      procedureId: (row.procedure_id as string) ?? undefined,
      scope: (row.scope as "global" | "user" | "agent" | "session") ?? "global",
      scopeTarget: (row.scope_target as string) ?? undefined,
      agentId: (row.agent_id as string) ?? undefined,
      userId: (row.user_id as string) ?? undefined,
      sessionId: (row.session_id as string) ?? undefined,
      importance: row.importance as number,
      tags: parseTags(row.tags as string | null),
      decayClass: (row.decay_class as DecayClass) ?? "normal",
      createdAt: row.created_at as number,
      verifiedAt: (row.verified_at as number) ?? undefined,
    };
  }

  /**
   * Search episodic memories (#781).
   *
   * Returns episodes ordered by timestamp DESC. Supports:
   * - FTS full-text search on event + context (when query is provided)
   * - Outcome filter
   * - Time range filter (since / until as Unix epoch seconds)
   * - Procedure ID filter
   * - Limit and scope filtering
   */
  searchEpisodes(
    options: {
      query?: string;
      outcome?: EpisodeOutcome[];
      since?: number;
      until?: number;
      procedureId?: string;
      limit?: number;
      scopeFilter?: ScopeFilter | null;
    } = {},
  ): Episode[] {
    const { query, outcome, since, until, procedureId, limit = 50, scopeFilter } = options;
    const params: unknown[] = [];
    const conditions: string[] = [];

    // FTS text search on event + context
    if (query?.trim()) {
      const sanitized = sanitizeFts5QueryForFacts(query.trim());
      const words = sanitized
        .split(/\s+/)
        .filter((w) => w.length > 1)
        .slice(0, 8)
        .map((w) => `"${w}"`)
        .join(" OR ");
      if (words) {
        conditions.push("e.rowid IN (SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH ?)");
        params.push(words);
      }
    }

    // Outcome filter
    if (outcome && outcome.length > 0) {
      const placeholders = outcome.map(() => "?").join(",");
      conditions.push(`e.outcome IN (${placeholders})`);
      params.push(...outcome);
    }

    // Time range filter
    if (since !== undefined) {
      conditions.push("e.timestamp >= ?");
      params.push(since);
    }
    if (until !== undefined) {
      conditions.push("e.timestamp <= ?");
      params.push(until);
    }

    // Procedure ID filter
    if (procedureId) {
      conditions.push("e.procedure_id = ?");
      params.push(procedureId);
    }

    // Scope filter
    const scopeClause = this.scopeFilterClausePositional(scopeFilter);
    if (scopeClause.clause) {
      conditions.push(scopeClause.clause.replace(/^AND /, ""));
      params.push(...scopeClause.params);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = "ORDER BY e.timestamp DESC LIMIT ?";
    params.push(limit);

    const sql = `SELECT e.* FROM episodes e ${where} ${limitClause}`;
    const rows = this.liveDb.prepare(sql).all(...(params as SQLInputValue[])) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEpisode(r));
  }

  /**
   * Get a single episode by id.
   */
  getEpisode(id: string): Episode | null {
    const row = this.liveDb.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToEpisode(row);
  }

  /**
   * Delete an episode by id.
   */
  deleteEpisode(id: string): boolean {
    const result = this.liveDb.prepare("DELETE FROM episodes WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * Count of episodes (for stats).
   */
  episodesCount(): number {
    try {
      const row = this.liveDb.prepare("SELECT COUNT(*) as cnt FROM episodes").get() as { cnt: number };
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  // --- Entity layer: NER mentions, organizations, contacts (#985–#987) ---

  /** Replace stored NER rows for a fact (typically after LLM extraction). */
  applyEntityEnrichment(factId: string, mentions: ExtractedMention[], detectedLang: string): void {
    replaceFactEntityMentions(
      this.liveDb,
      factId,
      mentions.map((m) => ({
        label: m.label,
        surfaceText: m.surfaceText,
        normalizedSurface: m.normalizedSurface,
        startOffset: m.startOffset,
        endOffset: m.endOffset,
        confidence: m.confidence,
        detectedLang,
        source: "llm",
      })),
    );
  }

  /** Resolve an organization by canonical key or fuzzy display name. */
  lookupOrganization(query: string): OrganizationRow | null {
    return lookupOrganizationByKeyOrName(this.liveDb, query);
  }

  /** Contacts with primary_org_id = org. */
  listContactsForOrganization(orgId: string, limit: number): ContactRow[] {
    return entityLayerListContactsForOrg(this.liveDb, orgId, limit);
  }

  /** List contacts by optional name prefix (empty = recent alphabetical cap). */
  listContactsByNamePrefix(prefix: string, limit: number): ContactRow[] {
    return entityLayerListContactsByNamePrefix(this.liveDb, prefix, limit);
  }

  /** Fact ids linked to an org via NER/org_fact_links. */
  listFactIdsLinkedToOrg(orgId: string, limit: number): string[] {
    return entityLayerListFactIdsForOrg(this.liveDb, orgId, limit);
  }

  /** Facts not yet processed by entity enrichment (see `facts.entity_enrichment_at`). */
  listFactIdsNeedingEntityEnrichment(limit: number, minTextLen = 24): string[] {
    return entityLayerListFactsNeedingEnrichment(this.liveDb, limit, minTextLen);
  }
}
