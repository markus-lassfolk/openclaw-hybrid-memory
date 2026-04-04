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
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readJsonFile } from "../utils/fs.js";
import { execFile as execFileCb } from "../utils/process-runner.js";
import { stableStringify } from "../utils/stable-stringify.js";
import { capturePluginError } from "./error-reporter.js";
import { expireDispatchLeases, transitionDispatchLease } from "./task-queue-leases.js";

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

type WatchdogAction =
  | "no-current" // No active current.json found
  | "ok" // Entry is healthy, no action needed
  | "cleared" // Stale entry moved to history (will be retried)
  | "quarantined"; // Entry exceeded retry limit; moved to quarantine

interface WatchdogResult {
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
  dispatchToken?: string;
  pid?: number;
  started?: string;
  /** When set to `idle`, the entry is a placeholder (no factory task yet) — see #983. */
  status?: string;
  completed?: string;
  exit_code?: number;
  details?: string;
  /** Set on idle placeholders written by hybrid-mem so consumers can distinguish them. */
  producer?: string;
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
 * Returns true when `current` is the same queue task as `stale` for safe replacement of current.json.
 * When pid/started are absent, pid/start equality must not be used (undefined === undefined is always true).
 */
export function taskQueueItemMatchesStale(current: TaskQueueItem, stale: TaskQueueItem): boolean {
  const hasPidOrStarted = stale.pid != null || stale.started != null;
  if (hasPidOrStarted) {
    return current.pid === stale.pid && current.started === stale.started;
  }
  return (
    current.issue === stale.issue && current.dispatchToken === stale.dispatchToken && current.branch === stale.branch
  );
}

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

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export const TASK_QUEUE_IDLE_PRODUCER = "openclaw-hybrid-memory";

const IDLE_DETAILS =
  "Placeholder: no autonomous queue task is active. The factory overwrites this file when work is dispatched.";

/** Status values that imply a real queue entry when combined with producer/title/branch. */
const TASK_QUEUE_STATUS_WITH_PAYLOAD = new Set([
  "running",
  "completed",
  "failed",
  "dispatched",
  "queued",
  "blocked",
  "cancelled",
]);

function buildIdleTaskQueuePayload(): TaskQueueItem {
  return {
    status: "idle",
    producer: TASK_QUEUE_IDLE_PRODUCER,
    details: IDLE_DETAILS,
  };
}

/**
 * Returns true when `item` looks like a real task-queue snapshot (idle sentinel, running work,
 * forge issue, shell runner, etc.). Returns false for metadata-only shells such as
 * `{ updatedAt, repo, maxForge }` written by external tools (#1037).
 */
export function taskQueueItemHasRecognizedSemantics(item: TaskQueueItem): boolean {
  if (item.status === "idle" && item.producer === TASK_QUEUE_IDLE_PRODUCER) return true;
  if (typeof item.issue === "number" && Number.isFinite(item.issue) && item.issue > 0) return true;
  if (typeof item.pid === "number" && item.pid > 0) {
    if (typeof item.started === "string" && item.started.length > 0) return true;
  }
  if (item.dispatchToken != null && String(item.dispatchToken).trim().length > 0) return true;
  const st = item.status != null ? String(item.status).toLowerCase() : "";
  if (st && TASK_QUEUE_STATUS_WITH_PAYLOAD.has(st)) {
    if (item.producer != null && String(item.producer).trim().length > 0) return true;
  }
  if (item.branch != null && String(item.branch).trim().length > 0) {
    if (item.title != null && String(item.title).trim().length > 0) return true;
    if (typeof item.issue === "number" && item.issue > 0) return true;
  }
  if (item.title != null && String(item.title).trim().length > 0 && item.producer != null) {
    return String(item.producer).trim().length > 0;
  }
  return false;
}

/**
 * Write the canonical idle `current.json` (overwrites). Use after clearing a degenerate snapshot
 * so cron and prompts always see a valid hybrid-memory placeholder (#983, #1037).
 */
export async function writeCanonicalIdleTaskQueueFile(
  stateDir: string,
  logger?: { info?: (msg: string) => void },
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const currentPath = join(stateDir, "current.json");
  const body = JSON.stringify(buildIdleTaskQueuePayload(), null, 2);
  await writeFile(currentPath, body, { encoding: "utf-8" });
  logger?.info?.(`memory-hybrid: wrote canonical idle task-queue file at ${currentPath}`);
}

/**
 * When `current.json` is absent, write a minimal idle sentinel so tools and cron jobs can read
 * JSON from the canonical path without ENOENT (#983). Real factory tasks overwrite this file.
 *
 * @returns true when a new file was written.
 */
export async function ensureTaskQueueIdlePlaceholder(
  stateDir: string,
  logger?: { info?: (msg: string) => void },
): Promise<boolean> {
  await mkdir(stateDir, { recursive: true });
  const currentPath = join(stateDir, "current.json");
  const body = JSON.stringify(buildIdleTaskQueuePayload(), null, 2);
  try {
    await writeFile(currentPath, body, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  }
  logger?.info?.(`memory-hybrid: wrote task-queue idle placeholder at ${currentPath}`);
  return true;
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
 * Count how many quarantined/cleared history entries match the given task.
 * Matches by issue number if present, otherwise by branch name.
 * Used to determine retry exhaustion.
 */
async function countMatchingHistory(
  historyDir: string,
  issue: number | undefined,
  branch: string | undefined,
): Promise<number> {
  // Need at least one identifier to match against
  if (issue == null && !branch) return 0;
  if (!existsSync(historyDir)) return 0;
  try {
    const files = (await readdir(historyDir)).filter((f) => f.endsWith(".json"));
    let count = 0;
    for (const file of files) {
      const item = await readJsonFile<TaskQueueItem>(join(historyDir, file));
      if (!item) continue;
      // Match by issue number if available, otherwise by branch
      if (issue != null && item.issue === issue) count++;
      else if (issue == null && branch && item.branch === branch) count++;
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

  await mkdir(stateDir, { recursive: true });
  await ensureTaskQueueIdlePlaceholder(stateDir, logger);

  // Keep lease registry fresh even when there is no active current.json.
  try {
    await expireDispatchLeases(stateDir);
  } catch {
    // Non-fatal: watchdog should still function for current.json hygiene.
  }

  const item = await readJsonFile<TaskQueueItem>(currentPath);
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { action: "no-current" };
  }

  // Idle placeholder — never treat as a stale factory run (#983).
  if (item.status === "idle" && item.producer === TASK_QUEUE_IDLE_PRODUCER) {
    return { action: "ok", item };
  }

  // Metadata-only or unknown shapes (e.g. external tools writing { updatedAt, repo, maxForge })
  // are not valid queue tasks — archive and restore canonical idle so automation sees a real sentinel (#1037).
  if (!taskQueueItemHasRecognizedSemantics(item)) {
    const recheckBefore = await readJsonFile<TaskQueueItem>(currentPath);
    if (recheckBefore != null && taskQueueItemHasRecognizedSemantics(recheckBefore)) {
      return { action: "ok", item: recheckBefore };
    }
    // Concurrent writers can replace the file between the initial read and this pass — do not archive/overwrite.
    if (recheckBefore == null || stableStringify(recheckBefore) !== stableStringify(item)) {
      return { action: "ok", item: recheckBefore ?? item };
    }

    const now = new Date().toISOString();
    const degenerateReason =
      "current.json has no recognizable task-queue payload (metadata-only shell or unknown shape; issue #1037)";
    await mkdir(historyDir, { recursive: true });
    const historyFilename = buildHistoryFilename("degenerate");
    const historyPath = join(historyDir, historyFilename);
    const archived: TaskQueueItem = {
      ...item,
      watchdogClearedAt: now,
      watchdogReason: degenerateReason,
    };
    await writeJsonFile(historyPath, archived);
    try {
      const recheckAfter = await readJsonFile<TaskQueueItem>(currentPath);
      const stillSameSnapshot = recheckAfter != null && stableStringify(recheckAfter) === stableStringify(item);
      if (stillSameSnapshot) {
        await unlink(currentPath);
        await writeCanonicalIdleTaskQueueFile(stateDir, logger);
        const logMsg = `memory-hybrid: task-queue-watchdog — cleared degenerate current.json → idle placeholder (${historyFilename})`;
        logger?.info(logMsg);
        return {
          action: "cleared",
          reason: degenerateReason,
          item: archived,
          historyPath,
        };
      }
      return { action: "ok", item: recheckAfter ?? item };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "task-queue-watchdog",
          operation: "unlink-degenerate-current",
        });
      }
      return { action: "ok", item };
    }
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
  const historyCount = await countMatchingHistory(historyDir, item.issue, item.branch);
  const isExhausted = previousRetries >= maxRetries || historyCount >= maxRetries;

  const action: WatchdogAction = isExhausted ? "quarantined" : "cleared";
  const now = new Date().toISOString();

  // If we can identify a lease for this issue, force it terminal so dispatch
  // dedupe does not depend on GitHub branch propagation.
  if (item.issue != null) {
    try {
      await transitionDispatchLease({
        stateDir,
        issue: item.issue,
        token: item.dispatchToken,
        toState: "lease-expired",
        reason: staleReason,
      });
    } catch {
      // Lease transition is best-effort here.
    }
  }

  const enrichedItem: TaskQueueItem = {
    ...item,
    watchdogClearedAt: now,
    watchdogReason: staleReason,
    retryCount: previousRetries + 1,
    // Explicitly set requeued to avoid inheriting a stale true from the spread
    requeued: enableRequeue && !isExhausted,
  };

  // Write to history
  await mkdir(historyDir, { recursive: true });
  const historyFilename = buildHistoryFilename(action);
  const historyPath = join(historyDir, historyFilename);
  await writeJsonFile(historyPath, enrichedItem);

  // Remove current.json — re-read to guard against TOCTOU race where a new task
  // was written between our initial read and this unlink.
  try {
    const recheck = await readJsonFile<TaskQueueItem>(currentPath);
    const identityMatches = recheck != null && taskQueueItemMatchesStale(recheck, item);
    if (identityMatches) {
      await unlink(currentPath);
    }
    // If recheck differs (new task started), leave current.json intact.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "task-queue-watchdog",
        operation: "unlink-current",
      });
    }
  }

  const logMsg = `memory-hybrid: task-queue-watchdog — ${action} entry${item.issue != null ? ` for issue #${item.issue}` : ""}${item.branch ? ` (branch: ${item.branch})` : ""} — reason: ${staleReason}`;

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
