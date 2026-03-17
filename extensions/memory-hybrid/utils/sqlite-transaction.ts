/**
 * Transaction helper for node:sqlite (DatabaseSync).
 *
 * node:sqlite does not ship a `.transaction()` helper like better-sqlite3 does.
 * This module provides `createTransaction`, a drop-in functional replacement.
 *
 * Usage:
 *   const tx = createTransaction(db, (arg: T) => { ... });
 *   tx(arg); // executes inside BEGIN / COMMIT, ROLLBACK on error
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * Wraps a function in a SQLite BEGIN / COMMIT / ROLLBACK block.
 * Mirrors the semantics of better-sqlite3's `db.transaction(fn)` helper.
 *
 * @param db  An open DatabaseSync instance.
 * @param fn  The function to execute inside the transaction.
 * @returns   A new function with the same signature that, when called, runs
 *            `fn` inside a transaction and returns its return value.
 */
export function createTransaction<T extends unknown[], R>(db: DatabaseSync, fn: (...args: T) => R): (...args: T) => R {
  return (...args: T): R => {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors — connection may already be broken
      }
      throw err;
    }
  };
}
