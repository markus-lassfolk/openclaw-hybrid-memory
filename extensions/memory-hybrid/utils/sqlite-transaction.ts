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
 * Supports nested transactions via SAVEPOINTs: if a transaction is already
 * active when this function is called, it uses SAVEPOINT/RELEASE/ROLLBACK TO
 * instead of BEGIN/COMMIT/ROLLBACK.
 *
 * @param db  An open DatabaseSync instance.
 * @param fn  The function to execute inside the transaction.
 * @returns   A new function with the same signature that, when called, runs
 *            `fn` inside a transaction and returns its return value.
 */

let savepointCounter = 0;

export function createTransaction<T extends unknown[], R>(db: DatabaseSync, fn: (...args: T) => R): (...args: T) => R {
  return (...args: T): R => {
    const isNested = db.isTransaction;
    const savepointName = isNested ? `sp_${++savepointCounter}` : null;

    if (isNested) {
      db.exec(`SAVEPOINT ${savepointName}`);
    } else {
      db.exec("BEGIN");
    }

    try {
      const result = fn(...args);
      if (isNested) {
        db.exec(`RELEASE ${savepointName}`);
      } else {
        db.exec("COMMIT");
      }
      return result;
    } catch (err) {
      try {
        if (isNested) {
          db.exec(`ROLLBACK TO ${savepointName}`);
          db.exec(`RELEASE ${savepointName}`);
        } else {
          db.exec("ROLLBACK");
        }
      } catch {
        // ignore rollback errors — connection may already be broken
      }
      throw err;
    }
  };
}
