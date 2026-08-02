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

import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
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
// Retention / pruning (Issue #2229)
// ---------------------------------------------------------------------------

/** Bounded retention policy applied to completed backup snapshots. */
export type BackupRetentionOptions = {
  /** Max number of completed snapshots to retain. 0 or negative disables count-based pruning. Default 7. */
  retentionCount?: number;
  /** Max age in days a completed snapshot may reach before it's prune-eligible. 0 or negative disables age-based pruning. Default 30. */
  retentionAgeDays?: number;
  /**
   * Grace period (ms) a `.backup-tmp-*` working directory or unrecognized root artifact must sit
   * untouched before it's treated as abandoned and safe to remove — protects a concurrently
   * running backup's in-progress temp dir from being pruned out from under it. Default 1 hour.
   */
  partialGraceMs?: number;
};

export const DEFAULT_BACKUP_RETENTION_COUNT = 7;
export const DEFAULT_BACKUP_RETENTION_AGE_DAYS = 30;
const DEFAULT_PARTIAL_GRACE_MS = 60 * 60 * 1000;

export type BackupPruneReport = {
  root: string;
  retainedCompleted: string[];
  prunedCompleted: string[];
  prunedPartial: string[];
  prunedOrphaned: string[];
  errors: string[];
};

export type BackupStatusEntry = { name: string; createdAt: string; bytes: number };

export type BackupStatusReport = {
  root: string;
  /** Completed snapshots currently on disk. */
  completedCount: number;
  /** Completed snapshots that satisfy the retention policy right now (i.e. would survive a prune). */
  retainedCount: number;
  /** In-progress (`.backup-tmp-*`) working directories currently on disk. */
  partialCount: number;
  /** Unrecognized files/directories sitting directly under the backup root (e.g. legacy orphaned artifacts). */
  orphanedCount: number;
  /** partialCount + orphanedCount — artifacts that are neither a completed snapshot nor prunable safely yet. */
  stalePartialCount: number;
  /** Total bytes across all completed snapshots. */
  totalBytes: number;
  newest: BackupStatusEntry | null;
  oldest: BackupStatusEntry | null;
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface BackupContext {
  resolvedSqlitePath: string;
  resolvedLancePath: string;
  /** Override default backup destination (~/.openclaw/backups/memory/). */
  backupDir?: string;
  /** Bounded retention applied after a successful backup (Issue #2229). Omit to skip pruning. */
  retention?: BackupRetentionOptions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prefix for the hidden working directory a backup writes into before it's promoted (renamed) into place. */
const TEMP_BACKUP_PREFIX = ".backup-tmp-";
/** Name pattern for a completed, atomically-promoted backup snapshot directory. */
const COMPLETED_BACKUP_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

function isCompletedBackupDirName(name: string): boolean {
  return COMPLETED_BACKUP_DIR_PATTERN.test(name);
}

function isPartialBackupDirName(name: string): boolean {
  return name.startsWith(TEMP_BACKUP_PREFIX);
}

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

/** Hidden sibling working directory a backup writes into before being promoted (renamed) into place. */
function tempBackupDir(root: string): string {
  return join(root, `${TEMP_BACKUP_PREFIX}${process.pid}-${randomBytes(6).toString("hex")}`);
}

// ---------------------------------------------------------------------------
// Retention / pruning (Issue #2229)
// ---------------------------------------------------------------------------

type ClassifiedEntry = { name: string; path: string; mtimeMs: number };

type BackupRootClassification = {
  completed: Array<ClassifiedEntry & { bytes: number }>;
  partial: ClassifiedEntry[];
  orphaned: ClassifiedEntry[];
};

/** List and classify everything directly under the backup root. Never mutates the filesystem. */
function classifyBackupRoot(root: string): BackupRootClassification {
  const result: BackupRootClassification = { completed: [], partial: [], orphaned: [] };
  if (!existsSync(root)) return result;

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(fullPath).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat; skip
    }
    if (entry.isDirectory() && isCompletedBackupDirName(entry.name)) {
      result.completed.push({ name: entry.name, path: fullPath, mtimeMs, bytes: dirSizeSync(fullPath) });
    } else if (entry.isDirectory() && isPartialBackupDirName(entry.name)) {
      result.partial.push({ name: entry.name, path: fullPath, mtimeMs });
    } else {
      // Anything else directly under the root — loose files or unrecognized directories (e.g. the
      // orphaned pre-sync SQLite snapshots reported in #2229) — is neither a completed snapshot
      // nor an in-progress working dir.
      result.orphaned.push({ name: entry.name, path: fullPath, mtimeMs });
    }
  }
  return result;
}

/**
 * Decide which completed snapshots survive retention. The newest snapshot is always retained,
 * even if it exceeds retentionAgeDays and even when it's the only one on disk — deleting the
 * sole valid backup because it aged out would defeat the purpose of having one (#2229).
 */
function planRetention(
  completed: BackupRootClassification["completed"],
  opts: BackupRetentionOptions,
): { retain: Set<string>; prune: Set<string> } {
  const retentionCount = opts.retentionCount ?? DEFAULT_BACKUP_RETENTION_COUNT;
  const retentionAgeDays = opts.retentionAgeDays ?? DEFAULT_BACKUP_RETENTION_AGE_DAYS;
  const ageCutoffMs = retentionAgeDays > 0 ? Date.now() - retentionAgeDays * 24 * 60 * 60 * 1000 : null;
  const sorted = [...completed].sort((a, b) => b.mtimeMs - a.mtimeMs);

  const retain = new Set<string>();
  const prune = new Set<string>();
  sorted.forEach((backup, index) => {
    const isNewest = index === 0;
    const overCount = retentionCount > 0 && index >= retentionCount;
    const overAge = ageCutoffMs !== null && backup.mtimeMs < ageCutoffMs;
    if (!isNewest && (overCount || overAge)) {
      prune.add(backup.name);
    } else {
      retain.add(backup.name);
    }
  });
  return { retain, prune };
}

/**
 * Apply bounded retention to a backup root: prunes old completed snapshots per policy, removes
 * abandoned `.backup-tmp-*` working directories left by a crashed/killed run, and removes stale
 * orphaned artifacts sitting directly under the root (e.g. legacy loose SQLite files). Only
 * artifacts older than `partialGraceMs` are ever touched for partial/orphaned cleanup, so a
 * concurrently running backup's in-progress temp dir is never disturbed.
 */
export function pruneBackups(root: string, opts: BackupRetentionOptions = {}): BackupPruneReport {
  const partialGraceMs = opts.partialGraceMs ?? DEFAULT_PARTIAL_GRACE_MS;
  const report: BackupPruneReport = {
    root,
    retainedCompleted: [],
    prunedCompleted: [],
    prunedPartial: [],
    prunedOrphaned: [],
    errors: [],
  };
  const classified = classifyBackupRoot(root);
  const now = Date.now();

  const { retain, prune } = planRetention(classified.completed, opts);
  for (const backup of classified.completed) {
    if (prune.has(backup.name)) {
      try {
        rmSync(backup.path, { recursive: true, force: true });
        report.prunedCompleted.push(backup.name);
      } catch (err) {
        report.errors.push(`Failed to prune old backup ${backup.name}: ${err}`);
      }
    } else if (retain.has(backup.name)) {
      report.retainedCompleted.push(backup.name);
    }
  }

  for (const entry of classified.partial) {
    if (now - entry.mtimeMs < partialGraceMs) continue; // may still be an active run — leave alone
    try {
      rmSync(entry.path, { recursive: true, force: true });
      report.prunedPartial.push(entry.name);
    } catch (err) {
      report.errors.push(`Failed to remove stale partial backup ${entry.name}: ${err}`);
    }
  }

  for (const entry of classified.orphaned) {
    if (now - entry.mtimeMs < partialGraceMs) continue;
    try {
      const st = statSync(entry.path);
      if (st.isDirectory()) {
        rmSync(entry.path, { recursive: true, force: true });
      } else {
        unlinkSync(entry.path);
      }
      report.prunedOrphaned.push(entry.name);
    } catch (err) {
      report.errors.push(`Failed to remove orphaned backup artifact ${entry.name}: ${err}`);
    }
  }

  return report;
}

/** Read-only status/audit summary of a backup root: no filesystem mutation (Issue #2229). */
export function getBackupStatus(root: string, opts: BackupRetentionOptions = {}): BackupStatusReport {
  const classified = classifyBackupRoot(root);
  const { retain } = planRetention(classified.completed, opts);
  const sorted = [...classified.completed].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toEntry = (e: (typeof sorted)[number]): BackupStatusEntry => ({
    name: e.name,
    createdAt: new Date(e.mtimeMs).toISOString(),
    bytes: e.bytes,
  });
  return {
    root,
    completedCount: classified.completed.length,
    retainedCount: retain.size,
    partialCount: classified.partial.length,
    orphanedCount: classified.orphaned.length,
    stalePartialCount: classified.partial.length + classified.orphaned.length,
    totalBytes: classified.completed.reduce((sum, e) => sum + e.bytes, 0),
    newest: sorted.length > 0 ? toEntry(sorted[0]) : null,
    oldest: sorted.length > 0 ? toEntry(sorted[sorted.length - 1]) : null,
  };
}

// ---------------------------------------------------------------------------
// Main backup function
// ---------------------------------------------------------------------------

/**
 * Create a point-in-time backup of the hybrid-memory data stores.
 * Uses VACUUM INTO for a consistent SQLite copy and recursive copy for LanceDB.
 *
 * Atomicity (#2229): all copying happens inside a hidden `.backup-tmp-*` working directory. Only
 * once every step (SQLite, LanceDB, manifest) has succeeded is that directory atomically renamed
 * to the final timestamped name. A crash or kill at any point before that rename leaves only the
 * hidden temp dir behind — never a directory that looks like a completed snapshot — so pruning
 * and status tooling can never mistake a partial backup for a verified one.
 */
export async function runBackup(ctx: BackupContext): Promise<BackupCliResult> {
  const start = Date.now();
  const root = ctx.backupDir ?? defaultBackupRoot();
  const finalDest = timestampedDir(root);
  const dest = tempBackupDir(root);

  try {
    mkdirSync(dest, { recursive: true });
  } catch (err) {
    return { ok: false, error: `Failed to create backup directory ${finalDest}: ${err}` };
  }

  /** Remove the half-written working directory before reporting a failure — otherwise a stale,
   * incomplete backup (e.g. valid memory.db but missing/partial lancedb) is left on disk. Because
   * this directory never reached its final (non-`.backup-tmp-*`) name, it can never be mistaken
   * for a legitimate completed snapshot even if this best-effort cleanup itself fails. */
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
    sqliteSnapshotAt !== null && lancedbSnapshotAt !== null ? Math.abs(lancedbSnapshotAt - sqliteSnapshotAt) : 0;

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

  // Atomic promotion (#2229): only after every step above succeeded does the working directory
  // become a real, discoverable snapshot. If this rename itself fails (e.g. disk full), the
  // backup did not complete — clean up and report failure rather than leaving a dangling temp dir.
  try {
    renameSync(dest, finalDest);
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "backup",
      operation: "finalize-backup",
    });
    return cleanupAndFail(`Failed to finalize backup directory: ${err}`);
  }

  // Bounded retention (#2229): best-effort, never blocks reporting success even if pruning fails.
  if (ctx.retention) {
    const pruneReport = pruneBackups(root, ctx.retention);
    if (pruneReport.errors.length > 0) {
      capturePluginError(new Error(pruneReport.errors.join("; ")), {
        subsystem: "backup",
        operation: "prune-backups",
        severity: "warning",
      });
    }
  }

  const durationMs = Date.now() - start;
  return {
    ok: true,
    backupDir: finalDest,
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
