/**
 * Task Queue Watchdog — Issue #631
 *
 * Detects stale/broken autonomous queue runs and self-heals by:
 * - Validating the PID in current.json is still alive
 * - Verifying the referenced branch/worktree still exists
 * - Detecting max-runtime exceeded entries
 * - Clearing or quarantining stale queue entries safely
 * - Emitting structured log events when intervening
 * - Optionally attaching retry metadata
 *
 * Addresses Engineering Goal 1: Rock-Solid Stability
 * Addresses Product Goal 4: Autonomous Maintenance
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { capturePluginError } from "./error-reporter.js";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskQueueWatchdogConfig {
  /** Directory containing current.json and history/. Defaults to ~/.openclaw/workspace/state/task-queue */
  stateDir?: string;
  /** Root of the git repository — used for branch/worktree verification. */
  repoDir?: string;
  /** Maximum task runtime in milliseconds before the entry is flagged stale. Default: 4 hours */
  maxRuntimeMs?: number;
  /** Maximum retry attempts before an entry is quarantined permanently. Default: 2 */
  maxRetries?: number;
  /** Whether to requeue (add retry metadata) after clearing. Default: false */
  enableRequeue?: boolean;
  /** If true, treat a missing branch as stale (requires repoDir). Default: true */
  checkBranch?: boolean;
}

export type WatchdogAction =
  | "no-current" // No active current.json found
  | "ok" // Entry is healthy, no action needed
  | "cleared" // Stale entry moved to history (will be retried)
  | "quarantined"; // Entry exceeded retry limit; moved to quarantine

export interface WatchdogResult {
  /** What the watchdog decided to do */
  action: WatchdogAction;
  /** Human-readable explanation for the action */
  reason?: string;
  /** The task queue item that was inspected */
  item?: TaskQueueItem;
  /** Absolute path of the history/quarantine file written */
  historyPath?: string;
  /** True when retry metadata was attached */
  requeued?: boolean;
}

/** Subset of TaskQueueItem used internally — avoids importing from dashboard-server */
export interface TaskQueueItem {
  issue?: number;
  title?: string;
  branch?: string;
  pid?: number;
  started?: string;
  status?: string;
  completed?: string;
  exit_code?: number;
  details?: string;
  /** Retry counter attached by the watchdog on successive clears */
  retryCount?: number;
  /** ISO timestamp when the watchdog last intervened */
  watchdogClearedAt?: string;
  /** Reason the watchdog flagged this entry */
  watchdogReason?: string;
  /** Set to true by the watchdog when requeue is requested */
  requeued?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns true if the given PID is alive on this system.
 * Uses signal 0 (no-op) — throws ESRCH if no such process.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = no such process (dead)
    // EPERM = process exists but we lack permission to signal it (alive)
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    // Unexpected error — assume dead to unblock the queue
    return false;
  }
}

/**
 * Returns the set of branch names referenced by active git worktrees.
 * Gracefully returns an empty set if git is unavailable or repoDir is absent.
 */
export async function getActiveWorktreeBranches(repoDir: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFile("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
      timeout: 5000,
    });
    const branches = new Set<string>();
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("branch refs/heads/")) {
        branches.add(trimmed.slice("branch refs/heads/".length));
      }
    }
    return branches;
  } catch {
    return new Set();
  }
}

/**
 * Returns true if `started` is more than `maxRuntimeMs` milliseconds ago.
 * Returns false if `started` is missing or unparseable (gives benefit of the doubt).
 */
export function isRuntimeExceeded(started: string | undefined, maxRuntimeMs: number): boolean {
  if (!started) return false;
  const startedMs = new Date(started).getTime();
  if (Number.isNaN(startedMs)) return false;
  return Date.now() - startedMs > maxRuntimeMs;
}

// ---------------------------------------------------------------------------
// Core watchdog logic
// ---------------------------------------------------------------------------

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Build a timestamped history filename.
 * Format: YYYY-MM-DDTHH-MM-SS-{suffix}.json
 */
function buildHistoryFilename(suffix: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${ts}-${suffix}.json`;
}

/**
 * Count how many quarantined/cleared history entries share the same issue number.
 * Used to determine retry exhaustion.
 */
async function countIssueHistory(historyDir: string, issue: number | undefined): Promise<number> {
  if (issue == null) return 0;
  if (!existsSync(historyDir)) return 0;
  try {
    const files = (await readdir(historyDir)).filter((f) => f.endsWith(".json"));
    let count = 0;
    for (const file of files) {
      const item = await readJsonFile<TaskQueueItem>(join(historyDir, file));
      if (item?.issue === issue) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Run the task queue watchdog.
 *
 * Reads `<stateDir>/current.json`, checks health, and either:
 * - Returns `ok` if the entry looks healthy.
 * - Moves the entry to `<stateDir>/history/<timestamp>-{cleared|quarantined}.json`
 *   if it is stale or broken, then deletes `current.json`.
 */
export async function runTaskQueueWatchdog(
  config: TaskQueueWatchdogConfig = {},
  logger?: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<WatchdogResult> {
  const stateDir = config.stateDir ?? join(homedir(), ".openclaw", "workspace", "state", "task-queue");
  const maxRuntimeMs = config.maxRuntimeMs ?? 4 * 60 * 60 * 1000; // 4 hours
  const maxRetries = config.maxRetries ?? 2;
  const enableRequeue = config.enableRequeue ?? false;
  const checkBranch = config.checkBranch ?? true;

  const currentPath = join(stateDir, "current.json");
  const historyDir = join(stateDir, "history");

  if (!existsSync(currentPath)) {
    return { action: "no-current" };
  }

  const item = await readJsonFile<TaskQueueItem>(currentPath);
  if (!item) {
    return { action: "no-current" };
  }

  // ── Health checks ─────────────────────────────────────────────────────────

  let staleReason: string | null = null;

  // 1. PID liveness
  if (item.pid != null && !isPidAlive(item.pid)) {
    staleReason = `PID ${item.pid} is no longer alive`;
  }

  // 2. Max runtime
  if (!staleReason && isRuntimeExceeded(item.started, maxRuntimeMs)) {
    const hoursLimit = Math.round(maxRuntimeMs / (60 * 60 * 1000));
    staleReason = `runtime exceeded ${hoursLimit}h limit (started ${item.started})`;
  }

  // 3. Branch / worktree verification
  if (!staleReason && checkBranch && item.branch && config.repoDir) {
    const worktreeBranches = await getActiveWorktreeBranches(config.repoDir);
    if (worktreeBranches.size > 0 && !worktreeBranches.has(item.branch)) {
      staleReason = `branch "${item.branch}" not found in any active worktree`;
    }
  }

  if (!staleReason) {
    return { action: "ok", item };
  }

  // ── Recovery: clear or quarantine ─────────────────────────────────────────

  const previousRetries = item.retryCount ?? 0;
  const historyCount = await countIssueHistory(historyDir, item.issue);
  const isExhausted = previousRetries >= maxRetries || historyCount >= maxRetries;

  const action: WatchdogAction = isExhausted ? "quarantined" : "cleared";
  const now = new Date().toISOString();

  const enrichedItem: TaskQueueItem = {
    ...item,
    watchdogClearedAt: now,
    watchdogReason: staleReason,
    retryCount: previousRetries + 1,
  };

  if (enableRequeue && !isExhausted) {
    enrichedItem.requeued = true;
  }

  // Write to history
  await mkdir(historyDir, { recursive: true });
  const historyFilename = buildHistoryFilename(action);
  const historyPath = join(historyDir, historyFilename);
  await writeJsonFile(historyPath, enrichedItem);

  // Remove current.json
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(currentPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "task-queue-watchdog",
        operation: "unlink-current",
      });
    }
  }

  const logMsg =
    `memory-hybrid: task-queue-watchdog — ${action} entry` +
    (item.issue != null ? ` for issue #${item.issue}` : "") +
    (item.branch ? ` (branch: ${item.branch})` : "") +
    ` — reason: ${staleReason}`;

  if (action === "quarantined") {
    logger?.warn(logMsg);
  } else {
    logger?.info(logMsg);
  }

  return {
    action,
    reason: staleReason,
    item: enrichedItem,
    historyPath,
    requeued: enableRequeue && !isExhausted,
  };
}
