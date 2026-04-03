/**
 * Base class for SQLite stores with defensive reconnection logic.
 *
 * Provides shared functionality for:
 * - Database connection management with automatic reopening after SIGUSR1
 * - Pragma application (WAL mode, busy timeout, optional foreign keys)
 * - Lifecycle tracking (open/closed state)
 * - Optional deferred close: when `deferClose` is true, `close()` waits until no
 *   `runWithDb` operation is in flight (#1015, plugin reload vs in-flight list).
 *
 * Subclasses must call `this.liveDb` to access the database handle instead of
 * accessing `this.db` directly. The getter ensures the connection is open and
 * pragmas are reapplied after a restart.
 *
 * Stores with `deferClose: true` should wrap each public DB operation in
 * `this.runWithDb("operationName", () => { ... })` and use `*Internal` helpers
 * to avoid nested `runWithDb` calls.
 */

import type { DatabaseSync } from "node:sqlite";
import { capturePluginError } from "../services/error-reporter.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";

interface BaseSqliteStoreOptions {
  /** Enable foreign key constraints (default: false). */
  foreignKeys?: boolean;
  /** Additional custom pragmas to apply on open/reopen. */
  customPragmas?: string[];
  /**
   * When true, `close()` only runs after in-flight `runWithDb` work completes (#1015).
   * Subclasses must use `runWithDb` for operations that touch `liveDb`.
   */
  deferClose?: boolean;
}

type ClosePhase = "open" | "closing" | "shutdown";

export abstract class BaseSqliteStore {
  protected db: DatabaseSync;
  protected _dbOpen = true;
  private _closed = false;
  private readonly options: BaseSqliteStoreOptions;
  private readonly deferClose: boolean;
  private activeOps = 0;
  private closePhase: ClosePhase = "open";

  constructor(db: DatabaseSync, options: BaseSqliteStoreOptions = {}) {
    this.db = db;
    this.options = options;
    this.deferClose = options.deferClose === true;
    this.applyPragmas();
  }

  protected applyPragmas(): void {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    if (this.options.foreignKeys) {
      this.db.exec("PRAGMA foreign_keys = ON");
    }

    if (this.options.customPragmas) {
      for (const pragma of this.options.customPragmas) {
        this.db.exec(pragma);
      }
    }
  }

  protected get closed(): boolean {
    return this._closed;
  }

  protected get liveDb(): DatabaseSync {
    if (this.closePhase === "shutdown") {
      throw new Error("The database connection is not open");
    }
    if (this.deferClose && this.closePhase === "closing" && this.activeOps === 0) {
      throw new Error("The database connection is not open");
    }
    if (!this._dbOpen) {
      this.db.open();
      this._dbOpen = true;
      this._closed = false;
      this.applyPragmas();
    }
    return this.db;
  }

  /**
   * Wrap a synchronous DB operation. With `deferClose`, participates in reference-counted
   * shutdown so `close()` does not run until the callback returns.
   */
  protected runWithDb<T>(operation: string, fn: () => T): T {
    if (!this.deferClose) {
      return this.runSqliteOp(operation, fn);
    }
    if (this.closePhase === "shutdown") {
      throw new Error("The database connection is not open");
    }
    if (this.closePhase === "closing") {
      throw new Error("The database connection is not open");
    }
    this.activeOps += 1;
    try {
      return this.runSqliteOp(operation, fn);
    } finally {
      this.activeOps -= 1;
      // `close()` may set phase to "closing" while this op runs — TS cannot see that mutation.
      const phaseAfter = this.closePhase as ClosePhase;
      if (this.deferClose && phaseAfter === "closing" && this.activeOps === 0) {
        this.finalizeShutdown();
      }
    }
  }

  /**
   * Run a synchronous DB operation; if the native handle was closed while `_dbOpen` stayed true
   * (lifecycle race, external close), reopen once and retry (#968).
   */
  protected runSqliteOp<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not open|connection is not open|The database connection is not open|database is not open/i.test(msg)) {
        throw err;
      }
      const phase = this.closePhase as ClosePhase;
      if (phase === "shutdown" || (this.deferClose && phase === "closing")) {
        throw err;
      }
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: this.getSubsystemName(),
        operation,
        phase: "sqlite-reconnect",
        severity: "info",
      });
      this._dbOpen = false;
      this._closed = false;
      try {
        this.db.open();
      } catch (openErr) {
        capturePluginError(openErr instanceof Error ? openErr : new Error(String(openErr)), {
          subsystem: this.getSubsystemName(),
          operation: `${operation}:reopen-failed`,
          severity: "warning",
        });
        throw openErr instanceof Error ? openErr : new Error(String(openErr));
      }
      this._dbOpen = true;
      this.applyPragmas();
      return fn();
    }
  }

  isOpen(): boolean {
    if (this.deferClose) {
      return this.closePhase === "open" && this._dbOpen;
    }
    return !this._closed && this._dbOpen;
  }

  private finalizeShutdown(): void {
    if (this.closePhase === "shutdown") return;
    this.closePhase = "shutdown";
    this._closed = true;
    this._dbOpen = false;
    try {
      this.db.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "db-close",
        subsystem: this.getSubsystemName(),
        severity: "info",
      });
    }
  }

  close(): void {
    if (this.deferClose) {
      if (this.closePhase !== "open") return;
      this.closePhase = "closing";
      if (this.activeOps === 0) {
        this.finalizeShutdown();
      }
      return;
    }
    if (this._closed) return;
    this._closed = true;
    this._dbOpen = false;
    try {
      this.db.close();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "db-close",
        subsystem: this.getSubsystemName(),
        severity: "info",
      });
    }
  }

  /**
   * Subclasses should override this to provide a descriptive name for error reporting.
   * Default implementation returns the class name.
   */
  protected getSubsystemName(): string {
    return this.constructor.name.toLowerCase();
  }
}
