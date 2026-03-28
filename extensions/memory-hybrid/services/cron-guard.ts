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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Subdirectory (relative to openclawDir) where guard files are kept. */
export const GUARD_SUBDIR = join("cron", "guard");

/** Absolute path of the guard directory. */
export function getGuardDir(openclawDir?: string): string {
  return join(openclawDir ?? join(homedir(), ".openclaw"), GUARD_SUBDIR);
}

/**
 * Absolute path for a named job's persistent guard file.
 * Filename convention: {jobName}.ms  (epoch-ms as plain text)
 */
export function getGuardFilePath(jobName: string, openclawDir?: string): string {
  return join(getGuardDir(openclawDir), `${jobName}.ms`);
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
export function buildGuardPrefix(jobName: string, minIntervalMs: number): string {
  const hours = Math.round(minIntervalMs / (60 * 60 * 1000));
  const guardFile = getGuardFilePath(jobName);
  const guardDir = getGuardDir();
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
  const cronStorePath = join(dir, "cron", "jobs.json");

  if (!existsSync(cronStorePath)) return;

  let store: { jobs?: unknown[] };
  try {
    store = JSON.parse(readFileSync(cronStorePath, "utf-8")) as { jobs?: unknown[] };
  } catch {
    return;
  }
  if (!Array.isArray(store.jobs)) return;

  const jobs = store.jobs as Array<Record<string, unknown>>;

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
      writeFileSync(cronStorePath, JSON.stringify(store, null, 2), "utf-8");
      logger.info(`memory-hybrid: synced lastRunAtMs for ${synced} cron job(s) from persistent guard files`);
    } catch (err) {
      logger.warn(`memory-hybrid: failed to write cron guard sync to jobs.json: ${err}`);
    }
  }
}
