/**
 * Concurrency regression tests for cli/install/cron-jobs.ts.
 *
 * ensureGoalStewardshipHeartbeatCronJob and ensureMaintenanceCronJobs each do a plain
 * read-modify-write cycle against ~/.openclaw/cron/jobs.json (or its SQLite equivalent). Two
 * overlapping callers (install racing upgrade, or either racing `verify --fix`) could previously
 * both read the same snapshot and each write back their own additions, with the last writer
 * silently discarding the other's job. Both functions now wrap their read-modify-write cycle in
 * a cross-process step lock and skip (safe no-op) instead of racing when the lock is already held.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGoalStewardshipHeartbeatCronJob, ensureMaintenanceCronJobs } from "../cli/install/cron-jobs.js";
import { acquireStepLock, releaseStepLock } from "../services/cron-guard.js";

const CRON_STORE_LOCK_NAME = "install-cron-jobs-sync";

let openclawDir: string;

afterEach(() => {
  if (openclawDir) rmSync(openclawDir, { recursive: true, force: true });
});

function readCronStore(dir: string): { jobs: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(dir, "cron", "jobs.json"), "utf-8");
  return JSON.parse(raw) as { jobs: Array<Record<string, unknown>> };
}

describe("cron store update lock", () => {
  it("ensureGoalStewardshipHeartbeatCronJob skips instead of racing when another process holds the lock", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-lock-"));
    mkdirSync(join(openclawDir, "cron"), { recursive: true });
    writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");

    // Simulate a concurrent process (e.g. `verify --fix` running at the same time as `install`)
    // already holding the cron-store lock.
    expect(acquireStepLock(CRON_STORE_LOCK_NAME, openclawDir)).toBe(true);
    try {
      const result = ensureGoalStewardshipHeartbeatCronJob(openclawDir, { heartbeatPatterns: [] });
      expect(result.added).toBe(false);
      expect(result.normalized).toBe(false);
      expect(result.skippedReason).toMatch(/already in progress/i);

      // Must not have raced the write — the store is untouched.
      const store = readCronStore(openclawDir);
      expect(store.jobs).toHaveLength(0);
    } finally {
      releaseStepLock(CRON_STORE_LOCK_NAME, openclawDir);
    }
  });

  it("ensureMaintenanceCronJobs skips instead of racing when another process holds the lock", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-lock-maint-"));
    mkdirSync(join(openclawDir, "cron"), { recursive: true });
    writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");

    expect(acquireStepLock(CRON_STORE_LOCK_NAME, openclawDir)).toBe(true);
    try {
      const result = ensureMaintenanceCronJobs(openclawDir, undefined, { normalizeExisting: true });
      expect(result.added).toEqual([]);
      expect(result.normalized).toEqual([]);

      const store = readCronStore(openclawDir);
      expect(store.jobs).toHaveLength(0);
    } finally {
      releaseStepLock(CRON_STORE_LOCK_NAME, openclawDir);
    }
  });

  it("releases the lock after a normal run, so a subsequent call can proceed", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-cron-lock-release-"));
    mkdirSync(join(openclawDir, "cron"), { recursive: true });
    writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }, null, 2), "utf-8");

    const first = ensureGoalStewardshipHeartbeatCronJob(openclawDir, { heartbeatPatterns: [] });
    expect(first.added).toBe(true);

    // The lock must be released after the first call completes — a second call (e.g. a later
    // idempotent re-check) must not be spuriously skipped.
    const second = ensureGoalStewardshipHeartbeatCronJob(openclawDir, { heartbeatPatterns: [] });
    expect(second.skippedReason).toBeUndefined();
    expect(second.added).toBe(false);
    expect(second.normalized).toBe(false);
  });
});
