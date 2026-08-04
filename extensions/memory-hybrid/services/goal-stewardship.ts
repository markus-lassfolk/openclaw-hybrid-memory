/**
 * Goal stewardship — barrel re-exports + global dispatch rate limit.
 * @see docs/GOAL-STEWARDSHIP-DESIGN.md
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { GoalStewardshipConfig } from "../config/types/index.js";
import { nowIso } from "../utils/dates.js";
import type { GoalDefaults } from "./goal-stewardship-types.js";

export * from "./goal-stewardship-types.js";
export * from "./goal-registry.js";
export * from "./goal-health.js";
export * from "./goal-subagent.js";
export * from "./goal-stewardship-heartbeat.js";
export * from "./goal-active-task-mirror.js";
export * from "./goal-circuit-breaker.js";
export * from "./goal-continuation.js";
export * from "./goal-preflight.js";

const globalDispatchTimestamps: number[] = [];
const GLOBAL_RATE_LIMIT_FILENAME = "_global_dispatch_rate_limit.json";
const GLOBAL_RATE_LOCK_FILENAME = ".global-dispatch-rate.lock";
const GLOBAL_RATE_LOCK_RETRY_MS = 25;
const GLOBAL_RATE_LOCK_MAX_RETRIES = 200;
const GLOBAL_RATE_LOCK_STALE_MS = 2 * 60 * 1000;
const DISPATCH_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(DISPATCH_LOCK_SLEEP, 0, 0, ms);
}

function persistedDispatchPath(goalsDir: string): string {
  return join(goalsDir, GLOBAL_RATE_LIMIT_FILENAME);
}

function readPersistedDispatchWindow(goalsDir: string): { timestamps: number[]; exists: boolean } {
  const filePath = persistedDispatchPath(goalsDir);
  if (!existsSync(filePath)) return { timestamps: [], exists: false };
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { timestamps?: unknown };
    if (!Array.isArray(parsed.timestamps)) return { timestamps: [], exists: true };
    return {
      timestamps: parsed.timestamps
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0)
        .sort((a, b) => a - b),
      exists: true,
    };
  } catch {
    return { timestamps: [], exists: true };
  }
}

function writePersistedDispatchTimestamps(goalsDir: string, timestamps: number[]): void {
  mkdirSync(goalsDir, { recursive: true });
  const path = persistedDispatchPath(goalsDir);
  const payload = JSON.stringify({ timestamps, updatedAt: nowIso() }, null, 2);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function withPersistedDispatchLock<T>(goalsDir: string, fn: () => T): T {
  mkdirSync(goalsDir, { recursive: true });
  const lockPath = join(goalsDir, GLOBAL_RATE_LOCK_FILENAME);
  let acquired = false;
  for (let attempt = 0; attempt < GLOBAL_RATE_LOCK_MAX_RETRIES; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${process.pid}\n${nowIso()}\n`, "utf-8");
      } finally {
        closeSync(fd);
      }
      acquired = true;
      break;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      try {
        const lockStat = statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > GLOBAL_RATE_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Another process may have rotated the lock; continue retrying.
      }
      sleepSync(GLOBAL_RATE_LOCK_RETRY_MS);
    }
  }
  if (!acquired) {
    throw new Error("Timed out waiting for global dispatch rate lock");
  }

  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort lock cleanup.
    }
  }
}

function pruneOldTimestamps(timestamps: number[]): number[] {
  const cutoff = Date.now() - 60 * 60 * 1000;
  let firstValid = 0;
  while (firstValid < timestamps.length && timestamps[firstValid]! < cutoff) {
    firstValid++;
  }
  return firstValid > 0 ? timestamps.slice(firstValid) : timestamps;
}

function getInMemoryRateLimitWindow(): number[] {
  const pruned = pruneOldTimestamps(globalDispatchTimestamps);
  if (pruned !== globalDispatchTimestamps) {
    globalDispatchTimestamps.splice(0, globalDispatchTimestamps.length, ...pruned);
  }
  return globalDispatchTimestamps;
}

export function recordGoalDispatch(goalsDir?: string): void {
  if (goalsDir?.trim()) {
    withPersistedDispatchLock(goalsDir, () => {
      const persisted = readPersistedDispatchWindow(goalsDir);
      const next = [...pruneOldTimestamps(persisted.timestamps), Date.now()];
      writePersistedDispatchTimestamps(goalsDir, next);
    });
    return;
  }
  const next = [...getInMemoryRateLimitWindow(), Date.now()];
  globalDispatchTimestamps.splice(0, globalDispatchTimestamps.length, ...next);
}

export function isGlobalRateLimited(maxPerHour: number, goalsDir?: string): boolean {
  if (goalsDir?.trim()) {
    return withPersistedDispatchLock(goalsDir, () => {
      const persisted = readPersistedDispatchWindow(goalsDir);
      const pruned = pruneOldTimestamps(persisted.timestamps);
      if (persisted.exists && pruned.length !== persisted.timestamps.length) {
        writePersistedDispatchTimestamps(goalsDir, pruned);
      }
      return pruned.length >= maxPerHour;
    });
  }
  return getInMemoryRateLimitWindow().length >= maxPerHour;
}

export function goalStewardshipDefaultsFromConfig(cfg: GoalStewardshipConfig): GoalDefaults {
  return {
    maxDispatches: cfg.defaults.maxDispatches,
    maxAssessments: cfg.defaults.maxAssessments,
    cooldownMinutes: cfg.defaults.cooldownMinutes,
    escalateAfterFailures: cfg.defaults.escalateAfterFailures,
    priority: cfg.defaults.priority,
  };
}

/** Runtime check: explicit enable OR auto-enable when active goals exist on disk. */
export async function isGoalStewardshipInjectionEnabled(
  cfg: { goalStewardship: GoalStewardshipConfig },
  goalsDir: string,
): Promise<boolean> {
  if (cfg.goalStewardship.enabled) return true;
  if (cfg.goalStewardship.autoEnableWhenGoalsPresent === false) return false;
  try {
    const { listActiveGoals } = await import("./goal-registry.js");
    const goals = await listActiveGoals(goalsDir);
    return goals.length > 0;
  } catch {
    return false;
  }
}
