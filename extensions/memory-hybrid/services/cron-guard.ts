/**
 * Persistent cron guard utilities — issue #305.
 *
 * Maintains ~/.openclaw/cron/guard/{jobName}.ms files (epoch-ms timestamps)
 * to track last-run state across gateway restarts AND system reboots.
 *
 * ## Problem (issue #305)
 * All plugin-registered cron jobs show `lastRun: never` after every gateway
 * restart, even if they ran minutes ago, because:
 *   1. The OpenClaw cron runner keeps lastRunAtMs state in memory only —
 *      it may not flush to jobs.json before a crash/restart.
 *   2. The old guard files lived in /tmp/ and were lost on system reboot.
 *
 * ## Fix
 * - `buildGuardPrefix`: writes guard timestamps to a persistent directory
 *   (~/.openclaw/cron/guard/) instead of /tmp/.
 * - `syncCronLastRunFromGuards`: called from plugin-service start() to read
 *   guard files and back-fill state.lastRunAtMs in jobs.json before the cron
 *   runner processes the queue on startup.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { join } from "node:path";

import { atomicWriteFile } from "../utils/atomic-write.js";
import { readOpenClawCronStore, writeOpenClawCronStore } from "./openclaw-cron-store.js";
import { isPidAlive } from "./task-queue-watchdog.js";

/** Subdirectory (relative to openclawDir) where guard files are kept. */
export const GUARD_SUBDIR = join("cron", "guard");

/** Absolute path of the guard directory. */
function getGuardDir(openclawDir?: string): string {
  return join(openclawDir ?? join(homedir(), ".openclaw"), GUARD_SUBDIR);
}

/**
 * Absolute path for a named job's persistent guard file.
 * Filename convention: {jobName}.ms  (epoch-ms as plain text)
 */
export function getGuardFilePath(jobName: string, openclawDir?: string): string {
  return join(getGuardDir(openclawDir), `${jobName}.ms`);
}

/** Per-step orchestrator guard file: `step--{name}.ms` */
export function getStepGuardFilePath(stepName: string, openclawDir?: string): string {
  return join(getGuardDir(openclawDir), `step--${stepName}.ms`);
}

export function readStepGuardTimestampMs(stepName: string, openclawDir?: string): number | null {
  return readGuardTimestampMs(`step--${stepName}`, openclawDir);
}

export function writeStepGuardTimestampMs(stepName: string, timestampMs: number, openclawDir?: string): void {
  const guardDir = getGuardDir(openclawDir);
  mkdirSync(guardDir, { recursive: true });
  // atomicWriteFile (write-temp + rename), not a plain writeFileSync — a crash mid-write (the
  // orchestrator's own runtime-budget kill is a plausible trigger) must never leave a truncated
  // guard timestamp, which readStepGuardTimestampMs would then misread as "never run" and
  // re-trigger the step early (QA follow-up).
  atomicWriteFile(getStepGuardFilePath(stepName, openclawDir), String(timestampMs));
}

/** Per-step in-progress lock file: `step--{name}.lock` — a real cross-process mutex. */
function getStepLockFilePath(stepName: string, openclawDir?: string): string {
  return join(getGuardDir(openclawDir), `step--${stepName}.lock`);
}

/** Lock files older than this are treated as abandoned by a crashed process, not a live run. */
export const STEP_LOCK_STALE_MS = 30 * 60 * 1000;

interface StepLockPayload {
  lockedAtMs: number;
  pid?: number;
  hostname?: string;
}

/** Owner metadata for a lock file this process is about to (re)write (#2031). */
function serializeLockPayload(nowMs: number): string {
  return JSON.stringify({ lockedAtMs: nowMs, pid: process.pid, hostname: osHostname() } satisfies StepLockPayload);
}

/**
 * Parse a lock file's contents. Accepts the current JSON payload as well as the legacy bare
 * epoch-ms number written by pre-#2031 versions, so an in-place upgrade with a live lock file
 * from the old format doesn't get misread as corrupt.
 */
function parseLockPayload(raw: string): StepLockPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const lockedAtMs = Number(trimmed);
    return Number.isFinite(lockedAtMs) ? { lockedAtMs } : null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<StepLockPayload>;
    if (typeof parsed.lockedAtMs !== "number" || !Number.isFinite(parsed.lockedAtMs)) return null;
    return {
      lockedAtMs: parsed.lockedAtMs,
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Acquire a real cross-process/cross-invocation lock for a maintenance step, so two orchestrator
 * runs starting near-simultaneously (a manual CLI run overlapping the gateway's own tick, or a
 * double-fired cron trigger) cannot both execute the same step concurrently. stepGuardEligible()
 * above only tracks *cadence* (has enough time passed since the last successful run) — it has no
 * concept of "currently running," so it does not prevent overlap by itself.
 *
 * Uses exclusive file creation (`wx`), which atomically fails if the file already exists. A lock
 * file older than STEP_LOCK_STALE_MS is assumed abandoned by a process that crashed without
 * releasing it and is forcibly reclaimed, so a stuck lock cannot permanently block the step.
 */
export function acquireStepLock(stepName: string, openclawDir?: string, nowMs = Date.now()): boolean {
  const guardDir = getGuardDir(openclawDir);
  mkdirSync(guardDir, { recursive: true });
  const lockPath = getStepLockFilePath(stepName, openclawDir);
  try {
    writeFileSync(lockPath, serializeLockPayload(nowMs), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch {
    // Lock file already exists — check whether it's stale (abandoned by a crashed process).
    try {
      const raw = readFileSync(lockPath, "utf-8");
      const payload = parseLockPayload(raw);
      if (!payload || nowMs - payload.lockedAtMs <= STEP_LOCK_STALE_MS) {
        return false; // held by a live (or recent) run, or unreadable — fail closed
      }
      // Past the time-based staleness window doesn't mean abandoned — a legitimately long-running
      // step (e.g. a slow local-LLM-tier step) can still be genuinely alive and holding this lock.
      // Only reclaim without a liveness check when we can't verify it (no pid recorded, a legacy
      // bare-timestamp lock file, or the owner ran on a different host we can't signal); when the
      // recorded owner is on THIS host, confirm it's actually dead before stealing its lock
      // (QA follow-up — a purely time-based reclaim let a second invocation run the same step
      // concurrently with a still-alive first one).
      if (payload.pid !== undefined && payload.hostname === osHostname() && isPidAlive(payload.pid)) {
        return false; // recorded owner is alive on this host — not actually abandoned
      }
    } catch {
      return false; // couldn't read the lock file — fail closed, don't run concurrently
    }
    // Stale — reclaim it. Not perfectly atomic (a fresh writer could win the race between the
    // failed `wx` above and this write), but the window is a single fs call and the consequence
    // of losing that race is a harmless re-run of an idempotent step, not corruption.
    try {
      writeFileSync(lockPath, serializeLockPayload(nowMs), "utf-8");
      return true;
    } catch {
      return false;
    }
  }
}

export function releaseStepLock(stepName: string, openclawDir?: string): void {
  try {
    rmSync(getStepLockFilePath(stepName, openclawDir), { force: true });
  } catch {
    /* non-fatal — worst case a stale lock sits until STEP_LOCK_STALE_MS passes */
  }
}

export interface StepLockInfo {
  stepName: string;
  lockPath: string;
  lockedAtMs: number;
  ageMs: number;
  pid?: number;
  hostname?: string;
  stale: boolean;
}

/** Read a single step's lock metadata, if a lock file is currently present (#2031). */
export function readStepLockInfo(stepName: string, openclawDir?: string, nowMs = Date.now()): StepLockInfo | null {
  const lockPath = getStepLockFilePath(stepName, openclawDir);
  if (!existsSync(lockPath)) return null;
  try {
    const payload = parseLockPayload(readFileSync(lockPath, "utf-8"));
    if (!payload) return null;
    const ageMs = Math.max(0, nowMs - payload.lockedAtMs);
    return {
      stepName,
      lockPath,
      lockedAtMs: payload.lockedAtMs,
      ageMs,
      pid: payload.pid,
      hostname: payload.hostname,
      stale: ageMs > STEP_LOCK_STALE_MS,
    };
  } catch {
    return null;
  }
}

/**
 * List every step lock file currently present under the guard dir, live or stale (#2031/#2033).
 * Used by `maintenance status --verbose` to surface a lock that would block `maintenance step --force`
 * instead of leaving operators to discover it only when a targeted run reports `skipped_guard`.
 */
export function listActiveStepLocks(openclawDir?: string, nowMs = Date.now()): StepLockInfo[] {
  const guardDir = getGuardDir(openclawDir);
  if (!existsSync(guardDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(guardDir);
  } catch {
    return [];
  }
  const locks: StepLockInfo[] = [];
  for (const f of entries) {
    if (!f.startsWith("step--") || !f.endsWith(".lock")) continue;
    const stepName = f.slice("step--".length, -".lock".length);
    const info = readStepLockInfo(stepName, openclawDir, nowMs);
    if (info) locks.push(info);
  }
  return locks;
}

/**
 * Single canonical rendering of lock owner metadata, shared by the orchestrator's `skipped_guard`
 * summary and `maintenance status`'s lock listing so the two surfaces can't drift out of sync (#2031).
 */
export function formatStepLockDetail(info: StepLockInfo | null): string {
  if (!info) return "lock metadata unavailable";
  return `pid=${info.pid ?? "unknown"} host=${info.hostname ?? "unknown"} held=${Math.round(info.ageMs / 1000)}s stale=${info.stale} lock=${info.lockPath}`;
}

/** Per-step "retry once" marker file: `step--{name}.retry-once`. */
function getStepRetryOnceMarkerPath(stepName: string, openclawDir?: string): string {
  return join(getGuardDir(openclawDir), `step--${stepName}.retry-once`);
}

/**
 * Mark a step for one forced run outside its normal cadence guard (#2094). Set by
 * analyze-maintenance-logs --auto-fix when a finding is classified transient-llm/transient-network
 * with the retry-once action; consumed by the orchestrator's guard check on the step's next
 * evaluation (forced or scheduled), so a transient failure gets one automatic bounded retry instead
 * of silently waiting out the full cadence window.
 */
export function markStepRetryOnce(stepName: string, openclawDir?: string): void {
  const guardDir = getGuardDir(openclawDir);
  mkdirSync(guardDir, { recursive: true });
  // atomicWriteFile, not a plain writeFileSync — see writeStepGuardTimestampMs above for why.
  atomicWriteFile(getStepRetryOnceMarkerPath(stepName, openclawDir), String(Date.now()));
}

/** Whether a retry-once marker is currently pending for this step, without consuming it. */
export function hasStepRetryOncePending(stepName: string, openclawDir?: string): boolean {
  return existsSync(getStepRetryOnceMarkerPath(stepName, openclawDir));
}

/**
 * Consume (delete) a pending retry-once marker, if present. Returns whether one existed. Always
 * call this as soon as a pending marker is observed — regardless of whether the bypass it grants
 * ends up mattering for this particular guard check — so the marker can never grant more than one
 * extra chance, and never lingers to retroactively affect an unrelated future guard evaluation.
 */
export function consumeStepRetryOnce(stepName: string, openclawDir?: string): boolean {
  const markerPath = getStepRetryOnceMarkerPath(stepName, openclawDir);
  if (!existsSync(markerPath)) return false;
  try {
    rmSync(markerPath, { force: true });
  } catch {
    // Non-fatal — worst case this step gets one more forced retry than intended on a future tick.
  }
  return true;
}

export function stepGuardEligible(
  stepName: string,
  guardIntervalMs: number,
  openclawDir?: string,
  nowMs = Date.now(),
): { eligible: boolean; lastRunMs: number | null; nextEligibleMs: number | null } {
  if (guardIntervalMs <= 0) {
    return { eligible: true, lastRunMs: null, nextEligibleMs: null };
  }
  const lastRunMs = readStepGuardTimestampMs(stepName, openclawDir);
  if (lastRunMs === null) {
    return { eligible: true, lastRunMs: null, nextEligibleMs: null };
  }
  const nextEligibleMs = lastRunMs + guardIntervalMs;
  return { eligible: nowMs >= nextEligibleMs, lastRunMs, nextEligibleMs };
}

/**
 * Read a guard file and return its timestamp in epoch-ms.
 * Tolerates both epoch-seconds (< 2e12) and epoch-ms formats written by older
 * code that used `date +%s`.  Returns null if the file is missing or invalid.
 */
export function readGuardTimestampMs(jobName: string, openclawDir?: string): number | null {
  const path = getGuardFilePath(jobName, openclawDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Epoch-seconds have ~10 digits (≤ 9_999_999_999); epoch-ms have ~13 digits.
    // Threshold 1e10 safely distinguishes them for any date until year 2286.
    return n < 1e10 ? n * 1000 : n;
  } catch {
    return null;
  }
}

/**
 * Build a job-message prefix that instructs the executing agent to check the
 * persistent guard file and skip if the job ran within the guard window.
 *
 * The persistent path (~/.openclaw/cron/guard/) survives system reboots,
 * unlike the old /tmp/ files used by issue #304.
 */
export function buildGuardPrefix(jobName: string, minIntervalMs: number, openclawDir?: string): string {
  const hours = Math.round(minIntervalMs / (60 * 60 * 1000));
  const guardFile = getGuardFilePath(jobName, openclawDir);
  const guardDir = getGuardDir(openclawDir);
  return `GUARD CHECK (issue #305): Before running, read the last-run guard file: cat "${guardFile}" 2>/dev/null. If the file contains a number T (Unix epoch ms) where (current epoch ms − T) < ${minIntervalMs} (${hours}h guard window), reply ONLY 'Skipped: ${jobName} — ran within ${hours}h guard window' and stop. Otherwise proceed with the task below. AFTER successful completion: mkdir -p "${guardDir}" and write the current Unix epoch ms to "${guardFile}".\n\n`;
}

type Logger = { info: (s: string) => void; warn: (s: string) => void };

/**
 * Sync cron job lastRunAtMs from persistent guard files into jobs.json.
 *
 * Called from plugin-service start() on every gateway startup.  Reads:
 *   1. ~/.openclaw/cron/guard/*.ms  (new persistent format, epoch-ms)
 *   2. /tmp/hybrid-mem-guard-*.txt  (legacy format, epoch-seconds — backward compat)
 *
 * For each guard file whose timestamp is newer than the current
 * state.lastRunAtMs in jobs.json, the state is updated.  This ensures the
 * cron runner sees a recent lastRunAtMs and does not fire jobs immediately.
 */
export function syncCronLastRunFromGuards(logger: Logger, openclawDir?: string): void {
  const dir = openclawDir ?? join(homedir(), ".openclaw");
  const guardDir = getGuardDir(dir);

  let snapshot: ReturnType<typeof readOpenClawCronStore>;
  try {
    snapshot = readOpenClawCronStore(dir);
  } catch {
    return;
  }
  if (!Array.isArray(snapshot.store.jobs) || snapshot.store.jobs.length === 0) return;

  const jobs = snapshot.store.jobs as Array<Record<string, unknown>>;

  // Collect guard timestamps keyed by jobName (normalized: spaces → hyphens).
  // The persistent files take precedence over legacy /tmp/ files.
  const guardTimestamps = new Map<string, number>(); // jobName → epoch-ms

  // 1. Persistent guard files (~/.openclaw/cron/guard/*.ms)
  if (existsSync(guardDir)) {
    try {
      for (const f of readdirSync(guardDir)) {
        if (!f.endsWith(".ms")) continue;
        const jobName = f.slice(0, -3); // strip .ms
        const ts = readGuardTimestampMs(jobName, dir);
        if (ts !== null) guardTimestamps.set(jobName, ts);
      }
    } catch {
      /* non-fatal — guard dir may be temporarily unreadable */
    }
  }

  // 2. Legacy /tmp/hybrid-mem-guard-*.txt files (epoch-seconds, convert to ms)
  try {
    for (const f of readdirSync("/tmp")) {
      if (!f.startsWith("hybrid-mem-guard-") || !f.endsWith(".txt")) continue;
      const jobName = f.slice("hybrid-mem-guard-".length, -4);
      if (guardTimestamps.has(jobName)) continue; // persistent wins
      try {
        const raw = readFileSync(join("/tmp", f), "utf-8").trim();
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) {
          guardTimestamps.set(jobName, n < 1e10 ? n * 1000 : n);
        }
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    /* non-fatal: /tmp might not be readable in some environments */
  }

  if (guardTimestamps.size === 0) return;

  let synced = 0;
  for (const job of jobs) {
    if (typeof job !== "object" || job === null) continue;
    // Normalize job name to match guard file naming (spaces → hyphens)
    const jobName = String(job.name ?? "").replace(/\s+/g, "-");
    const guardTs = guardTimestamps.get(jobName);
    if (guardTs === undefined) continue;

    const state = (typeof job.state === "object" && job.state !== null ? job.state : {}) as Record<string, unknown>;
    const currentLastRun = typeof state.lastRunAtMs === "number" ? state.lastRunAtMs : 0;

    if (guardTs > currentLastRun) {
      job.state = { ...state, lastRunAtMs: guardTs };
      synced++;
    }
  }

  if (synced > 0) {
    try {
      writeOpenClawCronStore(dir, snapshot.store, snapshot.backend);
      logger.info(`memory-hybrid: synced lastRunAtMs for ${synced} cron job(s) from persistent guard files`);
    } catch (err) {
      logger.warn(`memory-hybrid: failed to write cron guard sync to OpenClaw cron store: ${err}`);
    }
  }
}
