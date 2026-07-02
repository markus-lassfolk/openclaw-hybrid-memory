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

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readOpenClawCronStore, writeOpenClawCronStore } from "./openclaw-cron-store.js";

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
  writeFileSync(getStepGuardFilePath(stepName, openclawDir), String(timestampMs), "utf-8");
}

/** Per-step in-progress lock file: `step--{name}.lock` — a real cross-process mutex. */
function getStepLockFilePath(stepName: string, openclawDir?: string): string {
  return join(getGuardDir(openclawDir), `step--${stepName}.lock`);
}

/** Lock files older than this are treated as abandoned by a crashed process, not a live run. */
export const STEP_LOCK_STALE_MS = 30 * 60 * 1000;

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
    writeFileSync(lockPath, String(nowMs), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch {
    // Lock file already exists — check whether it's stale (abandoned by a crashed process).
    try {
      const raw = readFileSync(lockPath, "utf-8").trim();
      const lockedAtMs = Number(raw);
      if (!Number.isFinite(lockedAtMs) || nowMs - lockedAtMs <= STEP_LOCK_STALE_MS) {
        return false; // held by a live (or recent) run
      }
    } catch {
      return false; // couldn't read the lock file — fail closed, don't run concurrently
    }
    // Stale — reclaim it. Not perfectly atomic (a fresh writer could win the race between the
    // failed `wx` above and this write), but the window is a single fs call and the consequence
    // of losing that race is a harmless re-run of an idempotent step, not corruption.
    try {
      writeFileSync(lockPath, String(nowMs), "utf-8");
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
