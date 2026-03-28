import type { DatabaseSync } from "node:sqlite";
import { createTransaction } from "../../utils/sqlite-transaction.js";
import { normalizedHash } from "../../utils/tags.js";
/**
 * Procedure feedback loop — version tracking and failure logging (#782).
 * procedure_versions: per-version success/failure counts and avoidance notes.
 * procedure_failures: individual failure events with context and step info.
 */

/** Create procedure_versions table for version-level outcome tracking (#782). */
function migrateProcedureVersionsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS procedure_versions (
      id TEXT PRIMARY KEY,
      procedure_id TEXT NOT NULL,
      version_number INTEGER NOT NULL DEFAULT 1,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      avoidance_notes TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(procedure_id, version_number)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_proc_ver_procedure ON procedure_versions(procedure_id)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_proc_ver_num ON procedure_versions(procedure_id, version_number) WHERE version_number IS NOT NULL",
  );
}

/** Create procedure_failures table for individual failure event logging (#782). */
function migrateProcedureFailuresTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS procedure_failures (
      id TEXT PRIMARY KEY,
      procedure_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      context TEXT,
      failed_at_step INTEGER
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_proc_fail_procedure ON procedure_failures(procedure_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_proc_fail_version ON procedure_failures(procedure_id, version_number)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_proc_fail_ts ON procedure_failures(timestamp DESC)");
}

/** Create episodes table for episodic memory (#781). */
function migrateDecayColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("decay_class")) {
    db.exec(`ALTER TABLE facts ADD COLUMN decay_class TEXT NOT NULL DEFAULT 'stable'`);
  }
  if (!colNames.has("expires_at")) {
    db.exec("ALTER TABLE facts ADD COLUMN expires_at INTEGER");
  }
  if (!colNames.has("last_confirmed_at")) {
    db.exec("ALTER TABLE facts ADD COLUMN last_confirmed_at INTEGER");
    db.exec("UPDATE facts SET last_confirmed_at = created_at WHERE last_confirmed_at IS NULL");
  }
  if (!colNames.has("confidence")) {
    db.exec("ALTER TABLE facts ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_expires ON facts(expires_at)
      WHERE expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class);
  `);
}

/**
 * Fix timestamp unit mismatch from earlier versions that stored created_at
 * (and potentially last_confirmed_at via the decay migration) in milliseconds
 * while expires_at used seconds. Any value > 10_000_000_000 is certainly
 * milliseconds — that threshold in seconds is the year 2286.
 */
function migrateTimestampUnits(db: DatabaseSync): void {
  const MS_THRESHOLD = 10_000_000_000;
  const { cnt } = db.prepare("SELECT COUNT(*) as cnt FROM facts WHERE created_at > ?").get(MS_THRESHOLD) as {
    cnt: number;
  };
  if (cnt === 0) return;
  db.prepare(
    `UPDATE facts
     SET created_at = CAST(created_at / 1000 AS INTEGER)
     WHERE created_at > ?`,
  ).run(MS_THRESHOLD);
  // last_confirmed_at may have been seeded from ms-based created_at
  // by the migrateDecayColumns migration (created_at → last_confirmed_at).
  db.prepare(
    `UPDATE facts
     SET last_confirmed_at = CAST(last_confirmed_at / 1000 AS INTEGER)
     WHERE last_confirmed_at IS NOT NULL
       AND last_confirmed_at > ?`,
  ).run(MS_THRESHOLD);
}

function migrateSummaryColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "summary")) return;
  db.exec("ALTER TABLE facts ADD COLUMN summary TEXT");
}

/** Add optional lineage context (`why`) to facts. */
function migrateWhyColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "why")) return;
  db.exec("ALTER TABLE facts ADD COLUMN why TEXT");
}

function migrateNormalizedHash(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "normalized_hash")) {
    db.exec("ALTER TABLE facts ADD COLUMN normalized_hash TEXT");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_normalized_hash ON facts(normalized_hash) WHERE normalized_hash IS NOT NULL",
    );
  }
  const rows = db.prepare("SELECT id, text FROM facts WHERE normalized_hash IS NULL").all() as Array<{
    id: string;
    text: string;
  }>;
  if (rows.length === 0) return;
  const stmt = db.prepare("UPDATE facts SET normalized_hash = ? WHERE id = ?");
  for (const row of rows) {
    stmt.run(normalizedHash(row.text), row.id);
  }
}

function migrateSourceDateColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "source_date")) return;
  db.exec("ALTER TABLE facts ADD COLUMN source_date INTEGER");
  db.exec("UPDATE facts SET source_date = created_at WHERE source_date IS NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_facts_source_date ON facts(source_date) WHERE source_date IS NOT NULL");
}

function migrateTagsColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "tags")) return;
  db.exec("ALTER TABLE facts ADD COLUMN tags TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_tags ON facts(tags) WHERE tags IS NOT NULL AND tags != ''`);
}

/** Add recall_count and last_accessed for dynamic salience scoring. */
function migrateAccessTracking(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("recall_count")) {
    db.exec("ALTER TABLE facts ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!colNames.has("last_accessed")) {
    db.exec("ALTER TABLE facts ADD COLUMN last_accessed INTEGER");
    db.exec("UPDATE facts SET last_accessed = last_confirmed_at WHERE last_accessed IS NULL");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_facts_last_accessed ON facts(last_accessed) WHERE last_accessed IS NOT NULL");
}

/** Add superseded_at and superseded_by for contradiction resolution. */
function migrateSupersessionColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (colNames.has("superseded_at")) return;
  db.exec("ALTER TABLE facts ADD COLUMN superseded_at INTEGER");
  db.exec("ALTER TABLE facts ADD COLUMN superseded_by TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_facts_superseded ON facts(superseded_at) WHERE superseded_at IS NOT NULL");
}

/** Bi-temporal columns valid_from, valid_until, supersedes_id for point-in-time queries. */
function migrateBiTemporalColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (colNames.has("valid_from")) return;
  db.exec("ALTER TABLE facts ADD COLUMN valid_from INTEGER");
  db.exec("ALTER TABLE facts ADD COLUMN valid_until INTEGER");
  db.exec("ALTER TABLE facts ADD COLUMN supersedes_id TEXT");
  db.exec(
    "UPDATE facts SET valid_from = COALESCE(source_date, created_at), valid_until = NULL, supersedes_id = NULL WHERE valid_from IS NULL",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_facts_valid_range ON facts(valid_from, valid_until)");
}

/** Create memory_links table for graph-based spreading activation. */
function migrateMemoryLinksTable(db: DatabaseSync): void {
  const tableExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_links'`).get();

  if (tableExists) {
    // Use PRAGMA foreign_key_list to check for a CASCADE FK on target_fact_id.
    // This is immune to DDL formatting variations across plugin versions.
    const fkList = db.prepare("PRAGMA foreign_key_list(memory_links)").all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;
    const hasTargetCascade = fkList.some(
      (fk) => fk.from === "target_fact_id" && fk.on_delete.toUpperCase() === "CASCADE",
    );

    if (hasTargetCascade) {
      // Table exists with old CASCADE FK on target_fact_id — recreate without it.
      const recreate = createTransaction(db, () => {
        db.exec(`
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
        db.exec("INSERT INTO memory_links_new SELECT * FROM memory_links");
        db.exec("DROP TABLE memory_links");
        db.exec("ALTER TABLE memory_links_new RENAME TO memory_links");
      });
      recreate();
    }
    // If table exists without CASCADE on target, no migration needed.
  } else {
    // Table doesn't exist — create it fresh.
    db.exec(`
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

  db.exec("CREATE INDEX IF NOT EXISTS idx_links_source ON memory_links(source_fact_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_links_target ON memory_links(target_fact_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_links_type ON memory_links(link_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_links_source_type ON memory_links(source_fact_id, link_type)");
}

/** Add tier column; default 'warm' for existing rows. */
function migrateTierColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "tier")) return;
  db.exec(`ALTER TABLE facts ADD COLUMN tier TEXT DEFAULT 'warm'`);
  db.exec(`UPDATE facts SET tier = 'warm' WHERE tier IS NULL`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_facts_tier ON facts(tier) WHERE tier IS NOT NULL");
}

/** Add scope and scope_target columns for memory scoping. */
function migrateScopeColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("scope")) {
    db.exec(`ALTER TABLE facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`);
  }
  if (!colNames.has("scope_target")) {
    db.exec("ALTER TABLE facts ADD COLUMN scope_target TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_facts_scope_target ON facts(scope, scope_target) WHERE scope_target IS NOT NULL",
  );
}

/** Procedural memory: add procedure_type, success_count, last_validated, source_sessions to facts. */
function migrateProcedureColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (colNames.has("procedure_type")) return;
  db.exec("ALTER TABLE facts ADD COLUMN procedure_type TEXT");
  db.exec("ALTER TABLE facts ADD COLUMN success_count INTEGER DEFAULT 0");
  db.exec("ALTER TABLE facts ADD COLUMN last_validated INTEGER");
  db.exec("ALTER TABLE facts ADD COLUMN source_sessions TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_facts_procedure_type ON facts(procedure_type) WHERE procedure_type IS NOT NULL",
  );
}

/** Procedural memory: create procedures table for full recipe storage. */
function migrateProceduresTable(db: DatabaseSync): void {
  db.exec(`
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
  const cols = db.prepare("PRAGMA table_info(procedures)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("source_sessions")) {
    db.exec("ALTER TABLE procedures ADD COLUMN source_sessions TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_procedures_type ON procedures(procedure_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_procedures_validated ON procedures(last_validated)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_procedures_confidence ON procedures(confidence)");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS procedures_fts USING fts5(
      task_pattern,
      content=procedures,
      content_rowid=rowid,
      tokenize='porter unicode61'
    )
  `);
  db.exec(`
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

/** Add reinforcement tracking columns (reinforced_count, last_reinforced_at, reinforced_quotes). */
function migrateReinforcementColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (colNames.has("reinforced_count")) return;
  db.exec("ALTER TABLE facts ADD COLUMN reinforced_count INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE facts ADD COLUMN last_reinforced_at INTEGER");
  db.exec("ALTER TABLE facts ADD COLUMN reinforced_quotes TEXT"); // JSON array of strings
  db.exec("CREATE INDEX IF NOT EXISTS idx_facts_reinforced ON facts(reinforced_count) WHERE reinforced_count > 0");
}

/** Phase 2: Add reinforcement tracking columns to procedures table (same pattern as facts). */
function migrateReinforcementColumnsProcedures(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(procedures)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (colNames.has("reinforced_count")) return;
  db.exec("ALTER TABLE procedures ADD COLUMN reinforced_count INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE procedures ADD COLUMN last_reinforced_at INTEGER");
  db.exec("ALTER TABLE procedures ADD COLUMN reinforced_quotes TEXT"); // JSON array of strings
  db.exec("ALTER TABLE procedures ADD COLUMN promoted_at INTEGER"); // When auto-promoted via reinforcement
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_procedures_reinforced ON procedures(reinforced_count) WHERE reinforced_count > 0",
  );
}

/** Add scope and scope_target columns to procedures table (same pattern as facts). */
function migrateProcedureScopeColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(procedures)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  // Check both columns independently, not just scope
  if (!colNames.has("scope")) {
    db.exec(`ALTER TABLE procedures ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`);
  }
  if (!colNames.has("scope_target")) {
    db.exec("ALTER TABLE procedures ADD COLUMN scope_target TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_procedures_scope ON procedures(scope)");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_procedures_scope_target ON procedures(scope, scope_target) WHERE scope_target IS NOT NULL",
  );
}

/**
 * Migrate the FTS5 virtual table to include the `tags` and `why` columns.
 * FTS5 virtual tables cannot be altered, so we drop and recreate if tags are absent.
 * The entire migration is wrapped in a transaction so a crash mid-migration leaves the
 * DB in a consistent state (either old schema intact, or new schema + backfill complete).
 */
function migrateFtsTagsSupport(db: DatabaseSync): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='facts_fts'`).get() as
    | { sql: string }
    | undefined;

  // If the CREATE statement already contains both 'tags' and 'why', nothing to do.
  if (row?.sql?.includes("tags") && row?.sql?.includes("why")) return;

  // Wrap the entire migration in a transaction so any failure leaves the DB consistent.
  const migrate = createTransaction(db, () => {
    // Drop old triggers first (they reference the old column list).
    db.exec(`
      DROP TRIGGER IF EXISTS facts_ai;
      DROP TRIGGER IF EXISTS facts_ad;
      DROP TRIGGER IF EXISTS facts_au;
    `);

    // Drop and recreate FTS5 with tags included.
    db.exec("DROP TABLE IF EXISTS facts_fts");
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        text,
        category,
        entity,
        tags,
        why,
        key,
        value,
        content='facts',
        content_rowid='rowid',
        tokenize='porter unicode61'
      )
    `);

    // Recreate triggers with tags column.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, text, category, entity, tags, why, key, value)
        VALUES (new.rowid, new.text, new.category, new.entity, new.tags, new.why, new.key, new.value);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, tags, why, key, value)
        VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.tags, old.why, old.key, old.value);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, tags, why, key, value)
        VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.tags, old.why, old.key, old.value);
        INSERT INTO facts_fts(rowid, text, category, entity, tags, why, key, value)
        VALUES (new.rowid, new.text, new.category, new.entity, new.tags, new.why, new.key, new.value);
      END
    `);

    // Backfill existing facts into the new FTS index.
    db.exec(`
      INSERT INTO facts_fts(rowid, text, category, entity, tags, why, key, value)
      SELECT rowid, text, category, entity, tags, why, key, value FROM facts
    `);
  });
  migrate();
}

/** Create contradictions table for tracking conflicting facts (Issue #157). */
function migrateContradictionsTable(db: DatabaseSync): void {
  db.exec(`
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
  db.exec("CREATE INDEX IF NOT EXISTS idx_contradictions_new ON contradictions(fact_id_new)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contradictions_old ON contradictions(fact_id_old)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contradictions_resolved ON contradictions(resolved) WHERE resolved = 0");

  // Add old_fact_original_confidence column if it doesn't exist (for unbiased comparison)
  const cols = db.prepare("PRAGMA table_info(contradictions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "old_fact_original_confidence")) {
    db.exec("ALTER TABLE contradictions ADD COLUMN old_fact_original_confidence REAL");
  }
}

/** Create clusters and cluster_members tables for topic cluster storage (Issue #146). */
function migrateClusterTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clusters (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      fact_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cluster_members (
      cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
      fact_id TEXT NOT NULL,
      PRIMARY KEY (cluster_id, fact_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_cluster_members_fact ON cluster_members(fact_id)");
}

/** Create recall_log table for memory_recall hit-rate tracking (Issue #148). */
function migrateRecallLog(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_log (
      id TEXT PRIMARY KEY,
      occurred_at INTEGER NOT NULL,
      hit INTEGER NOT NULL CHECK(hit IN (0, 1))
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_recall_log_time ON recall_log(occurred_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_recall_log_hit ON recall_log(hit)");
}

/** Add embedding_model column to facts for tracking vector provenance (Issue #153). */
function migrateEmbeddingModelColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "embedding_model")) return;
  db.exec("ALTER TABLE facts ADD COLUMN embedding_model TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_facts_embedding_model ON facts(embedding_model) WHERE embedding_model IS NOT NULL",
  );
}

/** Store active embedding provider+model metadata (Issue #153). */
function migrateEmbeddingMetaTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/** Add decay_freeze_until column for future-date freeze protection (#144). */
function migrateDecayFreezeColumn(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === "decay_freeze_until")) return;
  db.exec("ALTER TABLE facts ADD COLUMN decay_freeze_until INTEGER DEFAULT NULL");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_facts_freeze ON facts(decay_freeze_until) WHERE decay_freeze_until IS NOT NULL",
  );
}

/**
 * Create the fact_embeddings table for multi-model embedding storage (Issue #158).
 * Idempotent — safe to call on existing databases.
 */
function migrateFactEmbeddingsTable(db: DatabaseSync): void {
  db.exec(`
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
  db.exec("CREATE INDEX IF NOT EXISTS idx_fact_embeddings_fact_id ON fact_embeddings(fact_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fact_embeddings_model ON fact_embeddings(model)");
}

/**
 * Create the fact_variants table for contextual variant text storage (Issue #159).
 * Idempotent — safe to call on existing databases.
 */
function migrateFactVariantsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_id TEXT NOT NULL,
      variant_type TEXT NOT NULL DEFAULT 'contextual',
      variant_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_fact_variants_fact_id ON fact_variants(fact_id)");
}

/** Add provenance columns to facts table (Issue #163). All nullable. */
function migrateProvenanceColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("provenance_session")) {
    db.exec("ALTER TABLE facts ADD COLUMN provenance_session TEXT");
    if (colNames.has("source_session")) {
      db.exec("UPDATE facts SET provenance_session = source_session WHERE source_session IS NOT NULL");
    }
  }
  if (!colNames.has("source_turn")) {
    db.exec("ALTER TABLE facts ADD COLUMN source_turn INTEGER");
  }
  if (!colNames.has("extraction_method")) {
    db.exec("ALTER TABLE facts ADD COLUMN extraction_method TEXT");
  }
  if (!colNames.has("extraction_confidence")) {
    db.exec("ALTER TABLE facts ADD COLUMN extraction_confidence REAL");
  }
}

/** Add FK to verified_facts for existing DBs created before FK was in schema. Idempotent. */
function migrateVerifiedFactsAddFk(db: DatabaseSync): void {
  const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verified_facts'").get();
  if (!tableInfo) return;
  const fkCheck = db.prepare("PRAGMA foreign_key_list(verified_facts)").all() as Array<{ table: string }> | undefined;
  if (Array.isArray(fkCheck) && fkCheck.length > 0) return; // FK already present — nothing to do
  createTransaction(db, () => {
    db.exec(`
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

/** Create verified_facts table for critical fact verification (Issue #162). */
function migrateVerifiedFactsTable(db: DatabaseSync): void {
  db.exec(`
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
  migrateVerifiedFactsAddFk(db);
}

/** Create reinforcement_log table for per-event context (#259). */
function migrateReinforcementLogTable(db: DatabaseSync): void {
  db.exec(`
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
  db.exec("CREATE INDEX IF NOT EXISTS idx_rl_fact_id ON reinforcement_log(fact_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_rl_occurred ON reinforcement_log(occurred_at)");

  // Idempotent migration: add FK constraint to existing tables that pre-date this migration.
  // SQLite does not support ALTER TABLE ADD CONSTRAINT, so we use RENAME-RECREATE-INSERT-DROP.
  const fkList = db.prepare("PRAGMA foreign_key_list(reinforcement_log)").all() as Array<{
    table: string;
    from: string;
  }>;
  const hasFk = fkList.some((fk) => fk.from === "fact_id" && fk.table === "facts");
  if (!hasFk) {
    createTransaction(db, () => {
      db.exec("ALTER TABLE reinforcement_log RENAME TO reinforcement_log_v1");
      db.exec(`
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
      db.exec(
        "INSERT INTO reinforcement_log SELECT * FROM reinforcement_log_v1 WHERE fact_id IN (SELECT id FROM facts)",
      );
      db.exec("DROP TABLE reinforcement_log_v1");
      db.exec("CREATE INDEX IF NOT EXISTS idx_rl_fact_id ON reinforcement_log(fact_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_rl_occurred ON reinforcement_log(occurred_at)");
    })();
  }
}

/** Change reinforced_count from INTEGER to REAL to support fractional boost amounts (#259, #260).
 *  The entire migration per table is wrapped in a transaction so a failure mid-step leaves the
 *  DB in a consistent state and the migration can be retried on the next startup.
 *  Requires SQLite >= 3.35 for ALTER TABLE … DROP COLUMN.
 */
function migrateReinforcedCountToReal(db: DatabaseSync): void {
  const factsCols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string; type: string }>;
  const factsReinforcedCol = factsCols.find((c) => c.name === "reinforced_count");
  if (factsReinforcedCol && factsReinforcedCol.type !== "REAL") {
    createTransaction(db, () => {
      db.exec("DROP INDEX IF EXISTS idx_facts_reinforced");
      db.exec("ALTER TABLE facts ADD COLUMN reinforced_count_real REAL NOT NULL DEFAULT 0");
      db.exec("UPDATE facts SET reinforced_count_real = CAST(reinforced_count AS REAL)");
      db.exec("ALTER TABLE facts DROP COLUMN reinforced_count");
      db.exec("ALTER TABLE facts RENAME COLUMN reinforced_count_real TO reinforced_count");
      db.exec("CREATE INDEX IF NOT EXISTS idx_facts_reinforced ON facts(reinforced_count) WHERE reinforced_count > 0");
    })();
  }

  const proceduresCols = db.prepare("PRAGMA table_info(procedures)").all() as Array<{
    name: string;
    type: string;
  }>;
  const proceduresReinforcedCol = proceduresCols.find((c) => c.name === "reinforced_count");
  if (proceduresReinforcedCol && proceduresReinforcedCol.type !== "REAL") {
    createTransaction(db, () => {
      db.exec("DROP INDEX IF EXISTS idx_procedures_reinforced");
      db.exec("ALTER TABLE procedures ADD COLUMN reinforced_count_real REAL NOT NULL DEFAULT 0");
      db.exec("UPDATE procedures SET reinforced_count_real = CAST(reinforced_count AS REAL)");
      db.exec("ALTER TABLE procedures DROP COLUMN reinforced_count");
      db.exec("ALTER TABLE procedures RENAME COLUMN reinforced_count_real TO reinforced_count");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_procedures_reinforced ON procedures(reinforced_count) WHERE reinforced_count > 0",
      );
    })();
  }
}

/** Create implicit_signals table for behavioral feedback signals (#262). */
function migrateImplicitSignalsTable(db: DatabaseSync): void {
  db.exec(`
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
  db.exec("CREATE INDEX IF NOT EXISTS idx_is_created ON implicit_signals(created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_is_polarity ON implicit_signals(polarity)");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_is_unique ON implicit_signals(session_file, signal_type, user_message, polarity)",
  );
}

/** Create feedback_trajectories table for multi-turn task sequence learning (#262). */
function migrateFeedbackTrajectoriesTable(db: DatabaseSync): void {
  db.exec(`
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
  db.exec("CREATE INDEX IF NOT EXISTS idx_ft_session ON feedback_trajectories(session_file)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ft_outcome ON feedback_trajectories(outcome)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ft_created_at ON feedback_trajectories(created_at)");
}

/** Create feedback_effectiveness table for closed-loop rule measurement (#262). */
function migrateFeedbackEffectivenessTable(db: DatabaseSync): void {
  db.exec(`
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
  db.exec("CREATE INDEX IF NOT EXISTS idx_fe_measured ON feedback_effectiveness(measured_at)");

  // Idempotent migration: add FK constraint to existing tables that pre-date this migration.
  const fkList = db.prepare("PRAGMA foreign_key_list(feedback_effectiveness)").all() as Array<{
    table: string;
    from: string;
  }>;
  const hasFk = fkList.some((fk) => fk.from === "rule_id" && fk.table === "facts");
  if (!hasFk) {
    createTransaction(db, () => {
      db.exec("ALTER TABLE feedback_effectiveness RENAME TO feedback_effectiveness_v1");
      db.exec(`
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
      db.exec(
        "INSERT INTO feedback_effectiveness SELECT * FROM feedback_effectiveness_v1 WHERE rule_id IN (SELECT id FROM facts)",
      );
      db.exec("DROP TABLE feedback_effectiveness_v1");
      db.exec("CREATE INDEX IF NOT EXISTS idx_fe_measured ON feedback_effectiveness(measured_at)");
    })();
  }
}

/** Create scan_cursors table for watermark-based incremental processing (#288). */
function migrateScanCursorsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_cursors (
      scan_type TEXT PRIMARY KEY,
      last_session_ts INTEGER NOT NULL DEFAULT 0,
      last_run_at INTEGER NOT NULL DEFAULT 0,
      sessions_processed INTEGER NOT NULL DEFAULT 0
    )
  `);
}

/** Add access_count and last_accessed_at columns for salience scoring (#237).
 *  access_count is backfilled from recall_count.
 *  last_accessed_at (ISO 8601 TEXT) is backfilled from last_accessed (epoch INTEGER).
 */
function migrateAccessCountAndLastAccessedAt(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has("access_count")) {
    db.exec("ALTER TABLE facts ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
    // Backfill from recall_count so existing access history is preserved
    db.exec("UPDATE facts SET access_count = COALESCE(recall_count, 0)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_facts_access_count ON facts(access_count)");
  }

  if (!colNames.has("last_accessed_at")) {
    db.exec("ALTER TABLE facts ADD COLUMN last_accessed_at TEXT");
    // Backfill from last_accessed (epoch seconds → ISO 8601)
    db.exec(
      `UPDATE facts SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%SZ', last_accessed, 'unixepoch') WHERE last_accessed IS NOT NULL`,
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_last_accessed_at ON facts(last_accessed_at) WHERE last_accessed_at IS NOT NULL",
    );
  }
}

// Token-budget tiered trimming (Issue #792)
function migratePreserveColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(facts)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("preserve_until")) {
    db.exec("ALTER TABLE facts ADD COLUMN preserve_until INTEGER");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_preserve_until ON facts(preserve_until) WHERE preserve_until IS NOT NULL",
    );
  }
  if (!colNames.has("preserve_tags")) {
    db.exec("ALTER TABLE facts ADD COLUMN preserve_tags TEXT");
  }
}

function migrateTrimMetricsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trim_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trimmed_at INTEGER NOT NULL,
      fact_id TEXT NOT NULL,
      fact_text_preview TEXT NOT NULL,
      tier TEXT NOT NULL,
      importance REAL NOT NULL,
      preserve_until INTEGER,
      token_cost INTEGER NOT NULL,
      budget_before INTEGER NOT NULL,
      budget_after INTEGER NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_trim_metrics_trimmed_at ON trim_metrics(trimmed_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_trim_metrics_fact_id ON trim_metrics(fact_id)");
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Run all FactsDB schema migrations in the correct order.
 * Every migration is idempotent — safe to re-run on an already-migrated database.
 *
 * Call this once after opening the database and creating the base schema
 * (facts table, FTS5 table, triggers, and basic indexes).
 */
export function runFactsMigrations(db: DatabaseSync): void {
  // Column migrations (depend on base facts table existing)
  migrateDecayColumns(db);
  migrateTimestampUnits(db);
  migrateSummaryColumn(db);
  migrateWhyColumn(db);
  migrateNormalizedHash(db);
  migrateSourceDateColumn(db);
  migrateTagsColumn(db);
  migrateAccessTracking(db);
  migrateSupersessionColumns(db);
  migrateBiTemporalColumns(db);

  // Graph/link table
  migrateMemoryLinksTable(db);

  // Tiering and scoping
  migrateTierColumn(db);
  migrateScopeColumns(db);

  // Procedural memory
  migrateProcedureColumns(db);
  migrateProceduresTable(db);

  // Reinforcement tracking
  migrateReinforcementColumns(db);
  migrateReinforcementColumnsProcedures(db);
  migrateProcedureScopeColumns(db);

  // FTS5 tags support (must run after migrateTagsColumn)
  migrateFtsTagsSupport(db);

  // Contradiction, cluster, and recall tracking
  migrateContradictionsTable(db);
  migrateClusterTables(db);
  migrateRecallLog(db);

  // Embedding tracking
  migrateEmbeddingModelColumn(db);
  migrateEmbeddingMetaTable(db);

  // Decay freeze
  migrateDecayFreezeColumn(db);

  // Multi-model embeddings and variants
  migrateFactEmbeddingsTable(db);
  migrateFactVariantsTable(db);

  // Provenance and verification
  migrateProvenanceColumns(db);
  migrateVerifiedFactsTable(db);

  // Reinforcement log and count type migration
  migrateReinforcementLogTable(db);
  migrateReinforcedCountToReal(db);

  // Implicit/behavioral feedback
  migrateImplicitSignalsTable(db);
  migrateFeedbackTrajectoriesTable(db);
  migrateFeedbackEffectivenessTable(db);

  // Scan cursors and access salience
  migrateScanCursorsTable(db);
  migrateAccessCountAndLastAccessedAt(db);

  // Token-budget tiered trimming (Issue #792)
  migratePreserveColumns(db);
  migrateTrimMetricsTable(db);

  // Episodic memory (Issue #781)
  // Procedural feedback loop (#782)
  migrateProcedureVersionsTable(db);
  migrateProcedureFailuresTable(db);

  // Episodic memory (#781)
  migrateEpisodesTable(db);
  migrateEpisodeRelationsTable(db);
}
function migrateEpisodesTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'partial', 'unknown')),
      timestamp INTEGER NOT NULL,
      duration INTEGER,
      context TEXT,
      related_fact_ids TEXT,
      procedure_id TEXT,
      scope TEXT,
      scope_target TEXT,
      agent_id TEXT,
      user_id TEXT,
      session_id TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      tags TEXT,
      decay_class TEXT,
      created_at INTEGER NOT NULL,
      verified_at INTEGER
    )
  `);
  // idx_episodes_outcome omitted: idx_episodes_outcome_timestamp (outcome, timestamp DESC) is a
  // leading-column superset and covers the same single-column outcome filter lookups.
  db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_procedure ON episodes(procedure_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_outcome_timestamp ON episodes(outcome, timestamp DESC)");

  // Check if episodes_fts exists and what schema it has.
  const ftsInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='episodes_fts'").get() as
    | { sql?: string }
    | undefined;
  const ftsExists = !!ftsInfo;
  // Old schema used content='episodes' (4-col FTS); new schema is standalone 2-col with triggers.
  const hasOldFtsSchema = ftsInfo?.sql?.includes("content='episodes'") || ftsInfo?.sql?.includes('content="episodes"');

  // Wrap the entire migration in a transaction so any failure leaves the DB consistent.
  if (hasOldFtsSchema || !ftsExists) {
    const migrate = createTransaction(db, () => {
      if (hasOldFtsSchema) {
        // Drop old content-FTS triggers and table — they reference a column set that no longer matches.
        db.exec("DROP TRIGGER IF EXISTS episodes_fts_ai");
        db.exec("DROP TRIGGER IF EXISTS episodes_fts_ad");
        db.exec("DROP TRIGGER IF EXISTS episodes_fts_au");
        db.exec("DROP TABLE IF EXISTS episodes_fts");
      }

      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
          event,
          context,
          tokenize='porter unicode61'
        )
      `);

      // Backfill FTS when the table was just created (either never existed, or dropped above).
      db.exec("INSERT INTO episodes_fts(rowid, event, context) SELECT rowid, event, context FROM episodes");
    });
    migrate();
  }

  // Trigger-based FTS maintenance: INSERT, DELETE, UPDATE all keep episodes_fts in sync.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodes_fts_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, event, context) VALUES (new.rowid, new.event, new.context);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodes_fts_ad AFTER DELETE ON episodes BEGIN
      DELETE FROM episodes_fts WHERE rowid = old.rowid;
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodes_fts_au AFTER UPDATE ON episodes BEGIN
      DELETE FROM episodes_fts WHERE rowid = old.rowid;
      INSERT INTO episodes_fts(rowid, event, context) VALUES (new.rowid, new.event, new.context);
    END;
  `);
}
function migrateEpisodeRelationsTable(db: DatabaseSync): void {
  const tableExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='episode_relations'`).get();
  if (!tableExists) {
    db.prepare(`
      CREATE TABLE episode_relations (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT,
        strength REAL,
        created_at TEXT NOT NULL
      )
    `).run();
    db.prepare("CREATE INDEX idx_episode_relations_episode_id ON episode_relations (episode_id)").run();
  }
}
