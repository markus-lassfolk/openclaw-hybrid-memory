/**
 * Backup CLI Commands (Issue #276)
 *
 * hybrid-mem backup          — creates a timestamped snapshot of memory state
 * hybrid-mem backup verify   — checks DB integrity without creating a new backup
 *
 * The backup captures:
 *  - SQLite memory.db (via better-sqlite3 .backup() — hot copy, no lock required)
 *  - LanceDB vector store directory (recursive copy)
 *  - Plugin config state (from resolvedSqlitePath directory)
 *
 * Output directory: ~/.openclaw/backups/memory/YYYY-MM-DDTHH-mm-ss/ (configurable)
 *
 * Document for OpenClaw core integration:
 *   `openclaw backup create` should capture these paths:
 *     - <memoryDir>/memory.db
 *     - <lanceDir>/
 *
 * Cron automation for scheduled backups should be managed via opencclaw.yaml.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, cpSync, statSync, readdirSync, copyFileSync } from "node:fs";
import { readdir, stat, mkdir, copyFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { capturePluginError } from "../services/error-reporter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackupCliResult =
  | {
      ok: true;
      backupDir: string;
      sqliteSize: number;
      lancedbSize: number;
      durationMs: number;
      integrityOk: boolean;
    }
  | { ok: false; error: string };

export type BackupVerifyResult =
  | { ok: true; integrityOk: boolean; sqlitePath: string; factCount: number; message: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface BackupContext {
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  /** Override default backup destination (~/.openclaw/backups/memory/). */
  backupDir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultBackupRoot(): string {
  return join(homedir(), ".openclaw", "backups", "memory");
}

function timestampedDir(root: string): string {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "T")
    .slice(0, 19); // YYYY-MM-DDTHH-mm-ss
  return join(root, ts);
}

/** Recursively measure directory size in bytes. Returns 0 if dir doesn't exist. */
function dirSizeSync(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeSync(fullPath);
    } else {
      try {
        total += statSync(fullPath).size;
      } catch {
        // skip unreadable
      }
    }
  }
  return total;
}

/** Recursively copy a directory. Uses cpSync when available (Node 16.7+), falls back to manual. */
function copyDirSync(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });

  // cpSync with recursive is available in Node 16.7+
  if (typeof cpSync === "function") {
    cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
    return;
  }

  // Fallback: manual recursive copy
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      try {
        copyFileSync(srcPath, destPath);
      } catch {
        // skip unreadable files
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main backup function
// ---------------------------------------------------------------------------

/**
 * Create a point-in-time backup of the hybrid-memory data stores.
 * Uses better-sqlite3 .backup() for a hot SQLite copy and recursive copy for LanceDB.
 */
export async function runBackup(ctx: BackupContext): Promise<BackupCliResult> {
  const start = Date.now();
  const root = ctx.backupDir ?? defaultBackupRoot();
  const dest = timestampedDir(root);

  try {
    mkdirSync(dest, { recursive: true });
  } catch (err) {
    return { ok: false, error: `Failed to create backup directory ${dest}: ${err}` };
  }

  // -- SQLite backup --
  let sqliteSize = 0;
  let integrityOk = false;

  if (existsSync(ctx.resolvedSqlitePath)) {
    const destSqlite = join(dest, basename(ctx.resolvedSqlitePath));
    try {
      // better-sqlite3 .backup() creates a consistent snapshot even while the DB is open.
      const db = new Database(ctx.resolvedSqlitePath, { readonly: true, fileMustExist: true });
      try {
        // Run integrity check on source before backup
        const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
        integrityOk = row?.integrity_check === "ok";

        // Hot backup — does not require closing the DB
        await db.backup(destSqlite);
      } finally {
        db.close();
      }
      sqliteSize = statSync(destSqlite).size;
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "backup",
        operation: "sqlite-backup",
      });
      return { ok: false, error: `SQLite backup failed: ${err}` };
    }
  }

  // -- LanceDB backup --
  let lancedbSize = 0;
  if (existsSync(ctx.resolvedLancePath)) {
    const destLance = join(dest, basename(ctx.resolvedLancePath));
    try {
      copyDirSync(ctx.resolvedLancePath, destLance);
      lancedbSize = dirSizeSync(destLance);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "backup",
        operation: "lancedb-backup",
      });
      return { ok: false, error: `LanceDB backup failed: ${err}` };
    }
  }

  const durationMs = Date.now() - start;
  return {
    ok: true,
    backupDir: dest,
    sqliteSize,
    lancedbSize,
    durationMs,
    integrityOk,
  };
}

// ---------------------------------------------------------------------------
// Verify function
// ---------------------------------------------------------------------------

/**
 * Verify DB integrity without creating a new backup.
 * Runs PRAGMA integrity_check and counts facts.
 */
export function runBackupVerify(ctx: { resolvedSqlitePath: string }): BackupVerifyResult {
  if (!existsSync(ctx.resolvedSqlitePath)) {
    return { ok: false, error: `SQLite database not found at: ${ctx.resolvedSqlitePath}` };
  }

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(ctx.resolvedSqlitePath, { readonly: true, fileMustExist: true });

    // integrity_check
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    const integrityOk = row?.integrity_check === "ok";

    // Count facts
    const countRow = db.prepare("SELECT COUNT(*) as n FROM facts WHERE superseded_by IS NULL").get() as
      | { n: number }
      | undefined;
    const factCount = countRow?.n ?? 0;

    const message = integrityOk
      ? `SQLite integrity OK — ${factCount} active facts`
      : `SQLite integrity FAILED — database may be corrupt`;

    return { ok: true, integrityOk, sqlitePath: ctx.resolvedSqlitePath, factCount, message };
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "backup",
      operation: "verify",
    });
    return { ok: false, error: `Verification failed: ${err}` };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}
