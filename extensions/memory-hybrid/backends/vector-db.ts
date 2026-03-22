/**
 * LanceDB vector backend for semantic search.
 */

import * as lancedb from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import type { MemoryCategory, DecayClass } from "../config.js";
import type { MemoryEntry, SearchResult } from "../types/memory.js";
import { capturePluginError } from "../services/error-reporter.js";
import { UUID_REGEX } from "../utils/constants.js";
import { pluginLogger } from "../utils/logger.js";

const LANCE_TABLE = "memories";
const SEMANTIC_QUERY_CACHE_TABLE = "semantic_query_cache";
/** Substring of the LanceDB error thrown on vector-dimension mismatch (issue #366). */
const LANCE_NO_VECTOR_COL_MSG = "No vector column found";

/**
 * Module-level optimization guard keyed by dbPath.
 * Prevents concurrent optimize() calls on the same LanceDB table from multiple VectorDB instances
 * (e.g. when the plugin restarts and a new instance is created before the old one finishes optimizing).
 * NOTE: storeCount is per-instance and resets on restart — this is intentional; the worst case is
 * a redundant optimization on the next store cycle after restart (benign).
 */
const _optimizingByPath = new Map<string, boolean>();
/** Module-level consecutive optimize-failure counter keyed by dbPath. */
const _optimizeFailuresByPath = new Map<string, number>();
const _OPTIMIZE_FAILURE_WARN_THRESHOLD = 3;

export type VectorDBLogger = { warn: (msg: string) => void };

export interface SemanticQueryCacheEntry {
  id: string;
  queryText: string;
  factIds: string[];
  packedFactIds: string[];
  cachedAt: number;
  similarity: number;
  filterKey: string;
}

export class VectorDB {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private semanticQueryCacheTable: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;
  private sessionCount = 0;
  private logger: VectorDBLogger | null = null;
  private storeCount = 0;
  private optimizePromise: Promise<{ compacted: number; removedFragments: number; freedBytes: number }> | null = null;
  private static readonly AUTO_OPTIMIZE_INTERVAL = 100;
  /**
   * Set to true if doInitialize() performed an auto-repair (drop + recreate) of the
   * LanceDB table due to a vector dimension mismatch. Callers can check this flag to
   * decide whether to trigger re-embedding of existing SQLite facts (issue #128).
   */
  wasRepaired = false;
  /**
   * Set to false by validateOrRepairSchema() when the table has no vector column or a
   * dimension mismatch that wasn't auto-repaired. search() and hasDuplicate() return
   * empty results immediately without reporting to GlitchTip when this is false, since
   * the schema issue was already logged at startup (issue #366).
   */
  private schemaValid = true;
  /**
   * Incremented each time close() is called. Re-embedding loops can capture this value
   * and abort when it changes, preventing them from running on a closed instance.
   */
  private closeGeneration = 0;
  /**
   * When true, this VectorDB is a long-lived singleton connection (set via setPersistent()).
   * removeSession() becomes a safe no-op when persistent — the connection is only closed
   * by an explicit close() call (e.g. gateway shutdown). This prevents fragile session
   * refcounting from accidentally closing a shared connection (#581).
   */
  private isPersistent = false;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
    private readonly autoRepair: boolean = false,
  ) {}

  setLogger(logger: VectorDBLogger): void {
    this.logger = logger;
  }

  private logWarn(msg: string): void {
    if (this.logger) this.logger.warn(msg);
    else pluginLogger.warn(msg);
  }

  private async ensureInitialized(): Promise<void> {
    // Await any in-flight init before inspecting state. Without this guard, a caller that
    // arrives while doInitialize() is already running would start a second concurrent
    // doInitialize() — resulting in duplicate connections and a potential connection leak.
    // After awaiting, we clear initPromise so that a stale resolved promise (left behind by
    // _doClose() which intentionally preserves it for this very await) does not short-circuit
    // the reconnect path at the `if (this.initPromise) return` guard below.
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch {
        // The catch handler inside the promise chain already cleared initPromise on failure;
        // fall through so we can attempt a fresh init below.
      }
      // Clear after a successful await: _doClose() intentionally preserves the resolved
      // promise so concurrent callers can serialize on it here, but once awaited it is no
      // longer needed and would block reconnection if left in place (table may be null).
      this.initPromise = null;
    }

    // Auto-reconnect: if closed (e.g., stop() called while async operations are in-flight during
    // a deferred SIGUSR1 restart, or register() called again on hot-reload), reset state and
    // reconnect. Mirrors the FactsDB/CredentialsDB liveDb() pattern for post-restart recovery.
    if (this.closed) {
      this.logWarn("memory-hybrid: VectorDB was closed; reconnecting...");
      this.closed = false;
      this.table = null;
      // Close any connection that may have been set by a concurrent in-flight doInitialize()
      // that completed after close() ran, to avoid leaking the underlying file handle.
      if (this.db) {
        try {
          this.db.close();
        } catch {
          /* ignore */
        }
        this.db = null;
      }
      this.initPromise = null;
    }
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize().catch((err) => {
      capturePluginError(err as Error, {
        operation: "vector-db-init",
        subsystem: "vector",
      });
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    // Reset schema validity on each (re-)init so a fixed table is detected correctly.
    this.schemaValid = true;
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(LANCE_TABLE)) {
      this.table = await this.db.openTable(LANCE_TABLE);
      await this.validateOrRepairSchema();
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
      try {
        await this.table.delete('id = "__schema__"');
      } catch (deleteErr) {
        this.logWarn(`memory-hybrid: failed to delete schema seed row (non-fatal): ${deleteErr}`);
      }
    }

    await this.ensureSemanticQueryCacheTable();
  }

  private async ensureSemanticQueryCacheTable(): Promise<void> {
    if (!this.db) throw new Error("VectorDB connection not initialized.");
    const tables = await this.db.tableNames();

    if (tables.includes(SEMANTIC_QUERY_CACHE_TABLE)) {
      try {
        this.semanticQueryCacheTable = await this.db.openTable(SEMANTIC_QUERY_CACHE_TABLE);
        return;
      } catch (err) {
        this.logWarn(`memory-hybrid: failed to open semantic query cache table, rebuilding: ${err}`);
        try {
          await this.db.dropTable(SEMANTIC_QUERY_CACHE_TABLE);
        } catch {
          /* ignore */
        }
      }
    }

    this.semanticQueryCacheTable = await this.db.createTable(SEMANTIC_QUERY_CACHE_TABLE, [
      {
        id: "__schema__",
        queryText: "",
        filterKey: "",
        vector: new Array(this.vectorDim).fill(0),
        factIds: "[]",
        packedFactIds: "[]",
        cachedAt: 0,
      },
    ]);

    try {
      await this.semanticQueryCacheTable.delete('id = "__schema__"');
    } catch (deleteErr) {
      this.logWarn(`memory-hybrid: failed to delete semantic cache seed row (non-fatal): ${deleteErr}`);
    }
  }

  /**
   * Validates the existing LanceDB table schema against the configured vector dimension.
   * Called from doInitialize() after opening an existing table (issue #128).
   *
   * - If no vector column is found: logs a warning (schema corruption).
   * - If dimension mismatch: logs a clear ERROR with expected vs actual dims.
   * - If autoRepair is true: drops and recreates the table with the correct dimension,
   *   then sets wasRepaired=true so callers can trigger re-embedding from SQLite.
   */
  private async validateOrRepairSchema(): Promise<void> {
    const table = this.table!;
    let tableDropped = false;
    try {
      const schema = await table.schema();
      // Arrow FixedSizeList columns (vector columns) have typeId === 16.
      // Use duck-typing to avoid a direct apache-arrow import.
      const vectorField = schema.fields.find(
        (f: { type?: { typeId?: number; listSize?: number } }) =>
          typeof f.type?.typeId === "number" && f.type.typeId === 16,
      );

      if (!vectorField) {
        this.schemaValid = false;
        this.logWarn(
          `memory-hybrid: ⚠️  LanceDB table '${LANCE_TABLE}' has no vector column — ` +
            `vector search will return empty results. ` +
            `This may indicate schema corruption. ` +
            `Delete the LanceDB directory and restart to rebuild the index.`,
        );
        return;
      }

      const actualDim = (vectorField.type as { listSize?: number }).listSize;
      if (typeof actualDim !== "number" || actualDim !== this.vectorDim) {
        const actual = typeof actualDim === "number" ? actualDim : "unknown";
        this.logWarn(
          `memory-hybrid: ⚠️  LanceDB dimension mismatch — table has dim=${actual}, ` +
            `configured embedding model expects dim=${this.vectorDim}. ` +
            `Vector search will return empty results until resolved (issue #128). ` +
            `Set vector.autoRepair=true in plugin config to automatically rebuild the index.`,
        );
        if (this.autoRepair && typeof actualDim === "number" && actualDim !== this.vectorDim) {
          // schemaValid stays true — it will be valid again after repair
          this.logWarn(
            `memory-hybrid: vector.autoRepair=true — dropping '${LANCE_TABLE}' and recreating ` +
              `with dim=${this.vectorDim} (was ${actual}). ` +
              `Existing vectors are lost; facts will be re-embedded from SQLite automatically.`,
          );
          await this.db!.dropTable(LANCE_TABLE);
          tableDropped = true;
          this.table = await this.db!.createTable(LANCE_TABLE, [
            {
              id: "__schema__",
              text: "",
              vector: new Array(this.vectorDim).fill(0),
              importance: 0,
              category: "other",
              createdAt: 0,
            },
          ]);
          try {
            await this.table.delete('id = "__schema__"');
          } catch (deleteErr) {
            this.logWarn(`memory-hybrid: failed to delete schema seed row (non-fatal): ${deleteErr}`);
          }
          this.wasRepaired = true;
        } else {
          // Mismatch without auto-repair: mark schema invalid so search/hasDuplicate
          // return empty results immediately without spamming GlitchTip (issue #366).
          this.schemaValid = false;
        }
      }
    } catch (err) {
      if (tableDropped) {
        throw err;
      }
      // Non-fatal: schema validation is advisory. search() already catches errors and
      // returns [] on dimension mismatch, so callers are not impacted.
      this.logWarn(`memory-hybrid: LanceDB schema validation failed (non-fatal): ${err}`);
    }
  }

  /**
   * Drop the vector table and recreate it empty with the current dimension.
   * Use before re-embedding all facts (e.g. after switching to a new embedding model).
   * Call ensureInitialized() first so the connection exists.
   */
  async resetTableForReindex(): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) throw new Error("VectorDB connection not initialized.");
    const tables = await this.db.tableNames();
    if (tables.includes(LANCE_TABLE)) {
      await this.db.dropTable(LANCE_TABLE);
    }
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
    try {
      await this.table.delete('id = "__schema__"');
    } catch (deleteErr) {
      this.logWarn(`memory-hybrid: failed to delete schema seed row after reset (non-fatal): ${deleteErr}`);
    }
  }

  /** Get initialized table or throw descriptive error. */
  private getTable(): lancedb.Table {
    if (!this.table) {
      throw new Error("VectorDB not initialized. Call ensureInitialized() first or check if close() was called.");
    }
    return this.table;
  }

  private getSemanticQueryCacheTable(): lancedb.Table {
    if (!this.semanticQueryCacheTable) {
      throw new Error("Semantic query cache table not initialized.");
    }
    return this.semanticQueryCacheTable;
  }

  private computeCosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length === 0 || a.length !== b.length) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index++) {
      dot += a[index] * b[index];
      normA += a[index] * a[index];
      normB += b[index] * b[index];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dot / denom;
  }

  private parseCacheIds(raw: unknown): string[] {
    if (typeof raw !== "string") return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return [];
    }
  }

  async getSemanticQueryCacheMatch(
    vector: number[],
    options: { minSimilarity?: number; ttlMs?: number; filterKey?: string; candidateLimit?: number } = {},
  ): Promise<SemanticQueryCacheEntry | null> {
    try {
      await this.ensureInitialized();
      const nowSec = Math.floor(Date.now() / 1000);
      const minSimilarity = options.minSimilarity ?? 0.95;
      const ttlSec = Math.max(1, Math.floor((options.ttlMs ?? 5 * 60 * 1000) / 1000));
      const filterKey = options.filterKey ?? "default";
      const candidateLimit = options.candidateLimit ?? 25;

      const candidates = await this.getSemanticQueryCacheTable().vectorSearch(vector).limit(candidateLimit).toArray();

      let bestMatch: SemanticQueryCacheEntry | null = null;
      for (const row of candidates) {
        if ((row.filterKey as string | undefined) !== filterKey) continue;

        const cachedAt = Number(row.cachedAt ?? 0);
        const ageSec = nowSec - cachedAt;
        if (!Number.isFinite(cachedAt) || ageSec > ttlSec) {
          continue;
        }

        const candidateVector = Array.isArray(row.vector)
          ? row.vector.map((value) => Number(value))
          : ArrayBuffer.isView(row.vector)
            ? Array.from(row.vector as ArrayLike<number>, (value) => Number(value))
            : [];

        const similarity = this.computeCosineSimilarity(vector, candidateVector);
        if (similarity < minSimilarity) continue;

        const entry: SemanticQueryCacheEntry = {
          id: String(row.id),
          queryText: String(row.queryText ?? ""),
          filterKey,
          factIds: this.parseCacheIds(row.factIds),
          packedFactIds: this.parseCacheIds(row.packedFactIds),
          cachedAt,
          similarity,
        };

        if (
          !bestMatch ||
          entry.similarity > bestMatch.similarity ||
          (entry.similarity === bestMatch.similarity && entry.cachedAt > bestMatch.cachedAt)
        ) {
          bestMatch = entry;
        }
      }

      return bestMatch;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "semantic-query-cache-lookup",
        severity: "info",
        subsystem: "vector",
      });
      this.logWarn(`memory-hybrid: semantic query cache lookup failed: ${err}`);
      return null;
    }
  }

  async storeSemanticQueryCache(entry: {
    queryText: string;
    vector: number[];
    factIds: string[];
    packedFactIds: string[];
    filterKey?: string;
    cachedAt?: number;
  }): Promise<void> {
    try {
      await this.ensureInitialized();
      await this.getSemanticQueryCacheTable().add([
        {
          id: randomUUID(),
          queryText: entry.queryText,
          filterKey: entry.filterKey ?? "default",
          vector: entry.vector,
          factIds: JSON.stringify(entry.factIds),
          packedFactIds: JSON.stringify(entry.packedFactIds),
          cachedAt: entry.cachedAt ?? Math.floor(Date.now() / 1000),
        },
      ]);
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "semantic-query-cache-store",
        severity: "info",
        subsystem: "vector",
      });
      this.logWarn(`memory-hybrid: semantic query cache store failed: ${err}`);
    }
  }

  /** Store a vector row. If id is provided (e.g. fact id from SQLite), it is used so search returns fact ids for classification. */
  async store(entry: {
    text: string;
    vector: number[];
    importance: number;
    category: string;
    /** Optional fact id from SQLite; when set, search results will use this id for classification. */
    id?: string;
  }): Promise<string> {
    try {
      await this.ensureInitialized();
      // Wait for any in-progress optimization to complete before writing
      if (this.optimizePromise) {
        await this.optimizePromise;
      }
      const id = entry.id ?? randomUUID();
      await this.getTable().add([{ ...entry, id, createdAt: Math.floor(Date.now() / 1000) }]);
      this.storeCount++;
      if (!_optimizingByPath.get(this.dbPath) && this.storeCount >= VectorDB.AUTO_OPTIMIZE_INTERVAL) {
        this.storeCount = 0;
        // Fire-and-forget; don't block the store operation
        this.optimize(24 * 60 * 60 * 1000)
          .then(() => {
            _optimizeFailuresByPath.delete(this.dbPath);
          })
          .catch((err) => {
            const failures = (_optimizeFailuresByPath.get(this.dbPath) ?? 0) + 1;
            _optimizeFailuresByPath.set(this.dbPath, failures);
            if (failures >= _OPTIMIZE_FAILURE_WARN_THRESHOLD) {
              this.logWarn(
                `memory-hybrid: auto-optimize has failed ${failures} time(s) in a row — ` +
                  `check LanceDB path (${this.dbPath}) for disk space or permission issues. Error: ${err}`,
              );
            } else {
              this.logWarn(`memory-hybrid: auto-optimize failed (non-fatal): ${err}`);
            }
          });
      }
      return id;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "vector-store",
        subsystem: "vector",
      });
      this.logWarn(`memory-hybrid: LanceDB store failed: ${err}`);
      throw err;
    }
  }

  /**
   * Compact fragments and clean up old versions to reclaim disk space and reduce memory usage.
   * Should be called periodically (e.g., nightly maintenance) to prevent unbounded growth.
   *
   * @param olderThanMs - Clean up versions older than this many ms (default: 7 days = 604800000)
   * @returns Statistics about the optimization (compaction + cleanup)
   */
  async optimize(
    olderThanMs: number = 7 * 24 * 60 * 60 * 1000,
  ): Promise<{ compacted: number; removedFragments: number; freedBytes: number }> {
    await this.ensureInitialized();
    // Wait for any in-progress optimization to complete
    if (this.optimizePromise) {
      await this.optimizePromise;
    }
    // Check again after awaiting in case another optimize started, globally this time
    if (_optimizingByPath.get(this.dbPath)) {
      this.logWarn(
        "memory-hybrid: optimize() called while another optimize is in progress; skipping to prevent concurrent table operations",
      );
      return { compacted: 0, removedFragments: 0, freedBytes: 0 };
    }
    _optimizingByPath.set(this.dbPath, true);
    let promiseRef: Promise<{ compacted: number; removedFragments: number; freedBytes: number }> | null = null;
    const optimizePromise = (async () => {
      try {
        const table = this.getTable();
        const cleanupOlderThan = new Date(Date.now() - olderThanMs);
        const stats = await table.optimize({ cleanupOlderThan });
        return {
          compacted: stats.compaction?.fragmentsRemoved ?? 0,
          removedFragments: stats.prune?.oldVersionsRemoved ?? 0,
          freedBytes: stats.prune?.bytesRemoved ?? 0,
        };
      } finally {
        _optimizingByPath.set(this.dbPath, false);
        if (this.optimizePromise === promiseRef) {
          this.optimizePromise = null;
        }
      }
    })();
    promiseRef = optimizePromise;
    this.optimizePromise = optimizePromise;
    return optimizePromise;
  }

  async search(vector: number[], limit = 5, minScore = 0.3): Promise<SearchResult[]> {
    try {
      await this.ensureInitialized();
      // Schema was detected as invalid at startup (dim mismatch or no vector column).
      // Return empty results immediately without a GlitchTip report — the issue was
      // already logged once during init (issue #366).
      if (!this.schemaValid) return [];
      const results = await this.getTable().vectorSearch(vector).limit(limit).toArray();
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
              // Fields NOT stored in LanceDB — partial/unknown placeholders.
              // Callers should enrich via factsDb.getById(entry.id) before trusting
              // these values. Conservative (non-optimistic) defaults are used so that
              // un-enriched results are not falsely ranked highly (issue #599).
              entity: null,
              key: null,
              value: null,
              source: "unknown",
              createdAt:
                (row.createdAt as number) > 10_000_000_000
                  ? Math.floor((row.createdAt as number) / 1000)
                  : (row.createdAt as number),
              decayClass: "normal" as DecayClass,
              expiresAt: null,
              lastConfirmedAt: 0,
              confidence: 0,
            },
            score,
            backend: "lancedb" as const,
          };
        })
        .filter((r) => r.score >= minScore);
    } catch (err) {
      const isKnownSchemaErr =
        !this.schemaValid && err instanceof Error && err.message.includes(LANCE_NO_VECTOR_COL_MSG);
      if (!isKnownSchemaErr) {
        capturePluginError(err as Error, {
          operation: "vector-search",
          severity: "info",
          subsystem: "vector",
        });
      }
      this.logWarn(`memory-hybrid: LanceDB search failed: ${err}`);
      return [];
    }
  }

  async hasDuplicate(vector: number[], threshold = 0.95): Promise<boolean> {
    try {
      await this.ensureInitialized();
      // Same early-exit as search(): schema was already reported invalid at startup.
      if (!this.schemaValid) return false;
      const results = await this.getTable().vectorSearch(vector).limit(1).toArray();
      if (results.length === 0) return false;
      const score = 1 / (1 + (results[0]._distance ?? 0));
      return score >= threshold;
    } catch (err) {
      const isKnownSchemaErr =
        !this.schemaValid && err instanceof Error && err.message.includes(LANCE_NO_VECTOR_COL_MSG);
      if (!isKnownSchemaErr) {
        capturePluginError(err as Error, {
          operation: "vector-duplicate-check",
          severity: "info",
          subsystem: "vector",
        });
      }
      this.logWarn(`memory-hybrid: LanceDB hasDuplicate failed: ${err}`);
      return false;
    }
  }

  async delete(id: string): Promise<boolean> {
    // SECURITY: UUID validation is the security boundary for delete().
    // LanceDB doesn't support parameterized queries, so we validate strictly before string interpolation.
    // Regex validates UUID v1-v5 format (case-insensitive), then we normalize to lowercase before interpolation.
    // Defensive: skip (log + return false) rather than throw on malformed UUIDs (issue #379).
    // logWarn is intentionally outside the try block so a logWarn failure cannot trigger capturePluginError
    // in the catch — that would contradict the graceful-skip intent for malformed input.
    if (!UUID_REGEX.test(id)) {
      const safeId = String(id).slice(0, 50);
      this.logWarn(`memory-hybrid: skipping LanceDB delete for invalid UUID: ${safeId}`);
      return false;
    }
    try {
      await this.ensureInitialized();
      await this.getTable().delete(`id = '${id.toLowerCase()}'`);
      return true;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: "vector-delete",
        subsystem: "vector",
      });
      this.logWarn(`memory-hybrid: LanceDB delete failed: ${err}`);
      throw err;
    }
  }

  async count(): Promise<number> {
    const tryCount = async (): Promise<number> => {
      await this.ensureInitialized();
      const t = this.getTable();
      return await t.countRows();
    };
    try {
      return await tryCount();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Race: DB may have been closed (e.g. plugin reload) between ensureInitialized() and getTable().
      // Retry once to allow reconnect so verify CLI and other callers get a result instead of 0.
      if (msg.includes("VectorDB not initialized") || msg.includes("close() was called")) {
        try {
          this.table = null;
          this.closed = true;
          this.initPromise = null;
          return await tryCount();
        } catch (retryErr) {
          capturePluginError(retryErr instanceof Error ? retryErr : new Error(String(retryErr)), {
            operation: "vector-count-retry",
            severity: "info",
            subsystem: "vector",
          });
          this.logWarn(`memory-hybrid: LanceDB count failed (after retry): ${retryErr}`);
          return 0;
        }
      }
      capturePluginError(err as Error, {
        operation: "vector-count",
        severity: "info",
        subsystem: "vector",
      });
      this.logWarn(`memory-hybrid: LanceDB count failed: ${err}`);
      return 0;
    }
  }

  /** Optional checkpoint method for LanceDB optimization */
  async checkpoint?(): Promise<void> {
    // LanceDB doesn't have an explicit checkpoint API
    // This is a no-op for compatibility
    return Promise.resolve();
  }

  /**
   * Mark this VectorDB as a persistent long-lived singleton connection (#581).
   *
   * Once called, `removeSession()` becomes a safe no-op — the connection can only be
   * closed by an explicit `close()` call (e.g. gateway shutdown). This eliminates the
   * risk of fragile session refcounting accidentally closing the shared connection while
   * the plugin is still running.
   *
   * Should be called once at plugin startup after the initial `count()` / schema check.
   */
  setPersistent(): void {
    this.isPersistent = true;
  }

  /**
   * Increment the session refcount. Called when an agent session begins using this VectorDB.
   * If the DB was previously closed (e.g. by a premature stop()), resets the closed flag so
   * the next operation auto-reconnects via ensureInitialized().
   *
   * @deprecated The main plugin lifecycle uses a single long-lived connection (setPersistent())
   * and no longer calls open()/removeSession() per turn. These remain for tests and
   * backward compatibility only.
   */
  open(): void {
    this.sessionCount++;
    if (this.closed) {
      this.closed = false;
    }
  }

  /**
   * Decrement the session refcount. Called when an agent session ends.
   * Only actually closes the underlying DB when the refcount reaches zero.
   *
   * When `setPersistent()` has been called, this method is a safe no-op — the persistent
   * connection can only be closed by `close()` (gateway shutdown).
   *
   * @deprecated Prefer the single long-lived connection model (setPersistent()) over
   * refcounted open()/removeSession() calls.
   */
  removeSession(): void {
    if (this.isPersistent) {
      // Persistent connections are managed by close() (gateway shutdown only).
      // Ignore refcount decrements to prevent accidental premature closure (#581).
      // This is a safe no-op by design; no log needed for expected behavior.
      return;
    }
    if (this.sessionCount <= 0) {
      this.logWarn(
        "memory-hybrid: VectorDB.removeSession() called with sessionCount already 0 — possible session lifecycle mismatch (open()/removeSession() calls are unbalanced)",
      );
    }
    this.sessionCount = Math.max(0, this.sessionCount - 1);
    if (this.sessionCount <= 0) {
      this._doClose();
    }
  }

  private _doClose(): void {
    this.closed = true;
    this.closeGeneration++;
    this.table = null;
    this.semanticQueryCacheTable = null;
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
    }
    this.db = null;
    // Intentionally NOT clearing initPromise here. If doInitialize() is in-flight, the
    // next ensureInitialized() call will await it before resetting state — preventing a
    // second concurrent doInitialize() and the associated connection leak / race condition.
  }

  /**
   * Force-close the VectorDB regardless of active session count.
   * Should only be called from gateway shutdown (service stop()).
   * Active sessions will auto-reconnect via ensureInitialized() if they call any method
   * after this (lazy reconnect safety net).
   */
  close(): void {
    // Note: isPersistent is intentionally not reset here.
    // A persistent connection, once closed (gateway shutdown), should not be
    // re-promoted to managed-lifecycle mode by any remaining callers.
    this.sessionCount = 0;
    this.closeGeneration++;
    this._doClose();
  }

  /**
   * Returns the current close generation. Re-embedding loops can capture this value
   * and abort when it changes (indicating the VectorDB has been closed).
   */
  getCloseGeneration(): number {
    return this.closeGeneration;
  }
}
