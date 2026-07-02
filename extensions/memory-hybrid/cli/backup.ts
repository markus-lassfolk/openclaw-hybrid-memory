/**
 * Backup CLI Commands (Issue #276)
 *
 * hybrid-mem backup          — creates a timestamped snapshot of memory state
 * hybrid-mem backup verify   — checks DB integrity without creating a new backup
 *
 * The backup captures:
 *  - SQLite memory.db (via VACUUM INTO — consistent hot copy, works with WAL mode)
 *  - LanceDB vector store directory (recursive copy)
 *
 * Note: plugin config (openclaw.yaml) is NOT currently captured by this command.
 * Users who want a full config backup should copy their openclaw.yaml separately.
 *
 * Output directory: ~/.openclaw/backups/memory/YYYY-MM-DDTHH-mm-ss/ (configurable)
 *
 * Document for OpenClaw core integration:
 *   `openclaw backup create` should capture these paths:
 *     - <memoryDir>/memory.db
 *     - <lanceDir>/
 *
 * Cron automation for scheduled backups should be managed via openclaw.yaml.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
      /** Epoch ms when the SQLite VACUUM INTO snapshot completed (undefined if no SQLite db existed). */
      sqliteSnapshotAt?: number;
      /** Epoch ms when the LanceDB directory copy completed (undefined if no LanceDB dir existed). */
      lancedbSnapshotAt?: number;
      /**
       * Gap in ms between the two snapshots — the window during which a live write could have
       * landed in one half but not the other, since the two stores are copied sequentially with
       * no write-quiesce between them (#81). 0 when either half is missing.
       */
      snapshotSkewMs: number;
    }
  | { ok: false; error: string };

/**
 * Written to the backup directory alongside the copied data so downstream verify/restore
 * tooling can detect (not prevent) SQLite/LanceDB drift caused by a write landing in the gap
 * between the two sequential snapshots (#81).
 */
export type BackupManifest = {
  version: 1;
  createdAt: number;
  sqliteSnapshotAt: number | null;
  lancedbSnapshotAt: number | null;
  snapshotSkewMs: number;
  sqliteSize: number;
  lancedbSize: number;
  integrityOk: boolean;
};

export type BackupVerifyResult =
  | { ok: true; integrityOk: boolean; sqlitePath: string; factCount: number; message: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface BackupContext {
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
  // Keep millisecond resolution (drop the old .slice(0, 19) truncation to whole seconds) — two
  // backups triggered within the same second (a scripted retry, or a manual run racing a cron
  // tick) previously resolved to the identical directory name. VACUUM INTO then failed on the
  // second run because SQLite refuses to write into an already-existing destination file,
  // reporting a misleading "SQLite backup failed" for what was really a naming collision.
  const ts = now.toISOString().replace(/[:.]/g, "-"); // YYYY-MM-DDTHH-mm-ss-SSSZ
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
    if (entry.isSymbolicLink()) {
      try {
        const linkTarget = readlinkSync(srcPath);
        symlinkSync(linkTarget, destPath);
      } catch {
        // skip unreadable symlink
      }
    } else if (entry.isDirectory()) {
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
 * Uses VACUUM INTO for a consistent SQLite copy and recursive copy for LanceDB.
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

  /** Remove the half-written backup directory before reporting a failure — otherwise a stale,
   * incomplete backup (e.g. valid memory.db but missing/partial lancedb) is left on disk looking
   * like a legitimate timestamped backup, with no marker that it's incomplete. */
  const cleanupAndFail = (error: string): { ok: false; error: string } => {
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only — the original error is what matters to the caller.
    }
    return { ok: false, error };
  };

  // -- SQLite backup --
  let sqliteSize = 0;
  // Defaults to false (not true): if resolvedSqlitePath doesn't exist, no integrity check ever
  // ran, and reporting `integrityOk: true` in that case falsely implied a check passed. Failing
  // closed means a caller relying on this flag can't mistake "never checked" for "verified ok."
  let integrityOk = false;
  // The two stores are copied sequentially (SQLite via VACUUM INTO, then LanceDB via directory
  // copy) with no write-quiesce between them — a store()/evict() landing in that gap makes the
  // two halves disagree. There is no cheap way to make the pair atomic without pausing all
  // writes, so instead we record when each snapshot completed; verify/restore tooling can use
  // the gap to reason about how much drift is possible (#81).
  let sqliteSnapshotAt: number | null = null;
  let lancedbSnapshotAt: number | null = null;

  if (existsSync(ctx.resolvedSqlitePath)) {
    const destSqlite = join(dest, basename(ctx.resolvedSqlitePath));
    try {
      // Open read-only to verify integrity, then use VACUUM INTO for a consistent hot copy.
      const db = new DatabaseSync(ctx.resolvedSqlitePath, { readOnly: true });
      try {
        // Run integrity check on source before backup
        const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
        integrityOk = row?.integrity_check === "ok";

        // VACUUM INTO creates a consistent snapshot compatible with WAL mode databases.
        // Escape single quotes in the path (path is system-generated, not user input).
        const escapedDest = destSqlite.replace(/'/g, "''");
        db.exec(`VACUUM INTO '${escapedDest}'`);
      } finally {
        db.close();
      }
      sqliteSize = statSync(destSqlite).size;
      sqliteSnapshotAt = Date.now();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "backup",
        operation: "sqlite-backup",
      });
      return cleanupAndFail(`SQLite backup failed: ${err}`);
    }
  }

  // -- LanceDB backup --
  let lancedbSize = 0;
  if (existsSync(ctx.resolvedLancePath)) {
    const destLance = join(dest, basename(ctx.resolvedLancePath));
    try {
      copyDirSync(ctx.resolvedLancePath, destLance);
      lancedbSize = dirSizeSync(destLance);
      lancedbSnapshotAt = Date.now();
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "backup",
        operation: "lancedb-backup",
      });
      return cleanupAndFail(`LanceDB backup failed: ${err}`);
    }
  }

  const snapshotSkewMs =
    sqliteSnapshotAt !== null && lancedbSnapshotAt !== null
      ? Math.abs(lancedbSnapshotAt - sqliteSnapshotAt)
      : 0;

  const manifest: BackupManifest = {
    version: 1,
    createdAt: start,
    sqliteSnapshotAt,
    lancedbSnapshotAt,
    snapshotSkewMs,
    sqliteSize,
    lancedbSize,
    integrityOk,
  };
  try {
    writeFileSync(join(dest, "backup-manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  } catch (err) {
    // Non-fatal — the data itself backed up successfully; only the drift-detection metadata
    // failed to write.
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "backup",
      operation: "write-manifest",
      severity: "warning",
    });
  }

  const durationMs = Date.now() - start;
  return {
    ok: true,
    backupDir: dest,
    sqliteSize,
    lancedbSize,
    durationMs,
    integrityOk,
    sqliteSnapshotAt: sqliteSnapshotAt ?? undefined,
    lancedbSnapshotAt: lancedbSnapshotAt ?? undefined,
    snapshotSkewMs,
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

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(ctx.resolvedSqlitePath, { readOnly: true });

    // integrity_check
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    const integrityOk = row?.integrity_check === "ok";

    // Count active facts. superseded_at (not superseded_by) is the "is this fact still active"
    // marker — the daily-quota eviction path and expiry/decay pruning only set superseded_at,
    // never superseded_by (that column is only populated when a fact is replaced by a specific
    // newer fact), so filtering on superseded_by IS NULL would miscount evicted/expired facts
    // as still active (#82).
    const countRow = db.prepare("SELECT COUNT(*) as n FROM facts WHERE superseded_at IS NULL").get() as
      | { n: number }
      | undefined;
    const factCount = countRow?.n ?? 0;

    const message = integrityOk
      ? `SQLite integrity OK — ${factCount} active facts`
      : "SQLite integrity FAILED — database may be corrupt";

    return { ok: true, integrityOk, sqlitePath: ctx.resolvedSqlitePath, factCount: factCount, message };
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
