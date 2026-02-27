/**
 * LanceDB vector backend for semantic search.
 */

import * as lancedb from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import type { MemoryCategory, DecayClass } from "../config.js";
import type { MemoryEntry, SearchResult } from "../types/memory.js";
import { capturePluginError } from "../services/error-reporter.js";

const LANCE_TABLE = "memories";

export type VectorDBLogger = { warn: (msg: string) => void };

export class VectorDB {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private closed = false;
  private sessionCount = 0;
  private logger: VectorDBLogger | null = null;
  /**
   * Set to true if doInitialize() performed an auto-repair (drop + recreate) of the
   * LanceDB table due to a vector dimension mismatch. Callers can check this flag to
   * decide whether to trigger re-embedding of existing SQLite facts (issue #128).
   */
  wasRepaired = false;
  /**
   * Incremented each time close() is called. Re-embedding loops can capture this value
   * and abort when it changes, preventing them from running on a closed instance.
   */
  private closeGeneration = 0;

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
    else if (typeof console !== "undefined" && console.warn) console.warn(msg);
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
        try { this.db.close(); } catch { /* ignore */ }
        this.db = null;
      }
      this.initPromise = null;
    }
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize().catch((err) => {
      capturePluginError(err as Error, {
        operation: 'vector-db-init',
        subsystem: 'vector'
      });
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
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

  /** Returns the current close generation (for re-embedding loops to abort on hot reload). */
  getCloseGeneration(): number {
    return this.closeGeneration;
  }

  /** Get initialized table or throw descriptive error. */
  private getTable(): lancedb.Table {
    if (!this.table) {
      throw new Error("VectorDB not initialized. Call ensureInitialized() first or check if close() was called.");
    }
    return this.table;
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
      const id = entry.id ?? randomUUID();
      await this.getTable().add([{ ...entry, id, createdAt: Math.floor(Date.now() / 1000) }]);
      return id;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'vector-store',
        subsystem: 'vector'
      });
      this.logWarn(`memory-hybrid: LanceDB store failed: ${err}`);
      throw err;
    }
  }

  async search(
    vector: number[],
    limit = 5,
    minScore = 0.3,
  ): Promise<SearchResult[]> {
    try {
      await this.ensureInitialized();
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
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'vector-search',
        severity: 'info',
        subsystem: 'vector'
      });
      this.logWarn(`memory-hybrid: LanceDB search failed: ${err}`);
      return [];
    }
  }

  async hasDuplicate(vector: number[], threshold = 0.95): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const results = await this.getTable().vectorSearch(vector).limit(1).toArray();
      if (results.length === 0) return false;
      const score = 1 / (1 + (results[0]._distance ?? 0));
      return score >= threshold;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'vector-duplicate-check',
        severity: 'info',
        subsystem: 'vector'
      });
      this.logWarn(`memory-hybrid: LanceDB hasDuplicate failed: ${err}`);
      return false;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.ensureInitialized();
      // SECURITY: UUID validation is the security boundary for delete().
      // LanceDB doesn't support parameterized queries, so we validate strictly before string interpolation.
      // Regex validates UUID v1-v5 format (case-insensitive), then we normalize to lowercase before interpolation.
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id)) throw new Error(`Invalid UUID format: ${id}`);
      await this.getTable().delete(`id = '${id.toLowerCase()}'`);
      return true;
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'vector-delete',
        subsystem: 'vector'
      });
      this.logWarn(`memory-hybrid: LanceDB delete failed: ${err}`);
      throw err;
    }
  }

  async count(): Promise<number> {
    try {
      await this.ensureInitialized();
      return await this.getTable().countRows();
    } catch (err) {
      capturePluginError(err as Error, {
        operation: 'vector-count',
        severity: 'info',
        subsystem: 'vector'
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
   * Increment the session refcount. Called when an agent session begins using this VectorDB.
   * If the DB was previously closed (e.g. by a premature stop()), resets the closed flag so
   * the next operation auto-reconnects via ensureInitialized().
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
   * Use this in session teardown hooks instead of close() to prevent premature
   * shutdown of a shared singleton while other sessions are still active.
   */
  removeSession(): void {
    if (this.sessionCount <= 0) {
      this.logWarn("memory-hybrid: VectorDB.removeSession() called with sessionCount already 0 — possible session lifecycle mismatch (open()/removeSession() calls are unbalanced)");
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
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
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
