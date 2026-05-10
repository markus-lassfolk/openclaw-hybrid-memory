/**
 * Goal stewardship — barrel re-exports + global dispatch rate limit.
 * @see docs/GOAL-STEWARDSHIP-DESIGN.md
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoalStewardshipConfig } from "../config/types/index.js";
import type { GoalDefaults } from "./goal-stewardship-types.js";

export * from "./goal-stewardship-types.js";
export * from "./goal-registry.js";
export * from "./goal-health.js";
export * from "./goal-subagent.js";
export * from "./goal-stewardship-heartbeat.js";
export * from "./goal-active-task-mirror.js";
export * from "./goal-circuit-breaker.js";

const globalDispatchTimestamps: number[] = [];
const GLOBAL_RATE_LIMIT_FILENAME = "_global_dispatch_rate_limit.json";

function readPersistedDispatchTimestamps(goalsDir?: string): number[] {
  if (!goalsDir?.trim()) return [];
  try {
    const raw = readFileSync(join(goalsDir, GLOBAL_RATE_LIMIT_FILENAME), "utf-8");
    const parsed = JSON.parse(raw) as { timestamps?: unknown };
    if (!Array.isArray(parsed.timestamps)) return [];
    return parsed.timestamps
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function writePersistedDispatchTimestamps(goalsDir: string, timestamps: number[]): void {
  mkdirSync(goalsDir, { recursive: true });
  const path = join(goalsDir, GLOBAL_RATE_LIMIT_FILENAME);
  const payload = JSON.stringify({ timestamps, updatedAt: new Date().toISOString() }, null, 2);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function pruneOldTimestamps(timestamps: number[]): number[] {
  const cutoff = Date.now() - 60 * 60 * 1000;
  let firstValid = 0;
  while (firstValid < timestamps.length && timestamps[firstValid]! < cutoff) {
    firstValid++;
  }
  return firstValid > 0 ? timestamps.slice(firstValid) : timestamps;
}

function getRateLimitWindow(goalsDir?: string): { timestamps: number[]; persisted: boolean } {
  if (!goalsDir?.trim()) {
    const pruned = pruneOldTimestamps(globalDispatchTimestamps);
    if (pruned !== globalDispatchTimestamps) {
      globalDispatchTimestamps.splice(0, globalDispatchTimestamps.length, ...pruned);
    }
    return { timestamps: globalDispatchTimestamps, persisted: false };
  }
  return { timestamps: pruneOldTimestamps(readPersistedDispatchTimestamps(goalsDir)), persisted: true };
}

export function recordGoalDispatch(goalsDir?: string): void {
  const window = getRateLimitWindow(goalsDir);
  const next = [...window.timestamps, Date.now()];
  if (window.persisted && goalsDir?.trim()) {
    writePersistedDispatchTimestamps(goalsDir, next);
    return;
  }
  globalDispatchTimestamps.splice(0, globalDispatchTimestamps.length, ...next);
}

export function isGlobalRateLimited(maxPerHour: number, goalsDir?: string): boolean {
  const window = getRateLimitWindow(goalsDir);
  if (window.persisted && goalsDir?.trim()) {
    writePersistedDispatchTimestamps(goalsDir, window.timestamps);
  }
  return window.timestamps.length >= maxPerHour;
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
