/**
 * Base class for SQLite stores with defensive reconnection logic.
 *
 * Provides shared functionality for:
 * - Database connection management with automatic reopening after SIGUSR1
 * - Pragma application (WAL mode, busy timeout, optional foreign keys)
 * - Lifecycle tracking (open/closed state)
 *
 * Subclasses must call `this.liveDb` to access the database handle instead of
 * accessing `this.db` directly. The getter ensures the connection is open and
 * pragmas are reapplied after a restart.
 */

import type { DatabaseSync } from "node:sqlite";
import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";
import { capturePluginError } from "../services/error-reporter.js";

export interface BaseSqliteStoreOptions {
  /** Enable foreign key constraints (default: false). */
  foreignKeys?: boolean;
  /** Additional custom pragmas to apply on open/reopen. */
  customPragmas?: string[];
}

export abstract class BaseSqliteStore {
  protected db: DatabaseSync;
  protected _dbOpen = true;
  protected closed = false;
  private readonly options: BaseSqliteStoreOptions;

  constructor(db: DatabaseSync, options: BaseSqliteStoreOptions = {}) {
    this.db = db;
    this.options = options;
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

  protected get liveDb(): DatabaseSync {
    if (!this._dbOpen && !this.closed) {
      this.db.open();
      this._dbOpen = true;
      this.applyPragmas();
    }
    return this.db;
  }

  isOpen(): boolean {
    return !this.closed && this._dbOpen;
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
