import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireStepLock,
  getStepGuardFilePath,
  listActiveStepLocks,
  readStepGuardTimestampMs,
  readStepLockInfo,
  releaseStepLock,
  STEP_LOCK_STALE_MS,
  stepGuardEligible,
  writeStepGuardTimestampMs,
} from "../services/cron-guard.js";

describe("cron-guard step helpers (#1934)", () => {
  let openclawDir: string;

  afterEach(() => {
    if (openclawDir) rmSync(openclawDir, { recursive: true, force: true });
  });

  it("writeStepGuardTimestampMs writes step--{name}.ms under cron/guard", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    const ts = Date.now();
    writeStepGuardTimestampMs("test-step", ts, openclawDir);
    expect(readStepGuardTimestampMs("test-step", openclawDir)).toBe(ts);
    expect(getStepGuardFilePath("test-step", openclawDir)).toContain("step--test-step.ms");
  });

  it("stepGuardEligible allows first run when guard file is missing", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    const now = Date.now();
    expect(stepGuardEligible("test-step", 60_000, openclawDir, now)).toEqual({
      eligible: true,
      lastRunMs: null,
      nextEligibleMs: null,
    });
  });

  it("stepGuardEligible blocks rerun inside guard interval", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    const started = Date.now();
    writeStepGuardTimestampMs("test-step", started, openclawDir);
    const guardMs = 60 * 60 * 1000;
    const insideWindow = stepGuardEligible("test-step", guardMs, openclawDir, started + 30 * 60 * 1000);
    expect(insideWindow.eligible).toBe(false);
    expect(insideWindow.lastRunMs).toBe(started);
    expect(insideWindow.nextEligibleMs).toBe(started + guardMs);

    const afterWindow = stepGuardEligible("test-step", guardMs, openclawDir, started + guardMs);
    expect(afterWindow.eligible).toBe(true);
  });

  it("stepGuardEligible always allows when guard interval is zero", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    writeStepGuardTimestampMs("test-step", Date.now(), openclawDir);
    expect(stepGuardEligible("test-step", 0, openclawDir).eligible).toBe(true);
  });
});

describe("cron-guard step lock owner metadata (#2031)", () => {
  let openclawDir: string;

  afterEach(() => {
    if (openclawDir) rmSync(openclawDir, { recursive: true, force: true });
  });

  it("acquireStepLock records pid/hostname, readable via readStepLockInfo", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    const now = Date.now();
    expect(acquireStepLock("distill", openclawDir, now)).toBe(true);

    const info = readStepLockInfo("distill", openclawDir, now + 5_000);
    expect(info).not.toBeNull();
    expect(info?.pid).toBe(process.pid);
    expect(info?.hostname).toBe(hostname());
    expect(info?.lockedAtMs).toBe(now);
    expect(info?.ageMs).toBe(5_000);
    expect(info?.stale).toBe(false);
  });

  it("readStepLockInfo returns null when no lock file exists", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    expect(readStepLockInfo("distill", openclawDir)).toBeNull();
  });

  it("readStepLockInfo tolerates the legacy bare-epoch-ms lock format from pre-#2031 versions", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    const now = Date.now();
    // Pre-upgrade code wrote just the epoch-ms number, no JSON envelope.
    expect(acquireStepLock("distill", openclawDir, now)).toBe(true);
    writeFileSync(join(openclawDir, "cron", "guard", "step--distill.lock"), String(now), "utf-8");

    const info = readStepLockInfo("distill", openclawDir, now + 1_000);
    expect(info?.lockedAtMs).toBe(now);
    expect(info?.pid).toBeUndefined();
    expect(info?.hostname).toBeUndefined();
  });

  it("readStepLockInfo marks a lock older than STEP_LOCK_STALE_MS as stale", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    const lockedAt = Date.now() - STEP_LOCK_STALE_MS - 1_000;
    expect(acquireStepLock("distill", openclawDir, lockedAt)).toBe(true);

    const info = readStepLockInfo("distill", openclawDir);
    expect(info?.stale).toBe(true);
  });

  it("listActiveStepLocks lists every held step--*.lock file", () => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-guard-"));
    expect(acquireStepLock("distill", openclawDir)).toBe(true);
    expect(acquireStepLock("passive-observer", openclawDir)).toBe(true);

    const locks = listActiveStepLocks(openclawDir);
    expect(locks.map((l) => l.stepName).sort()).toEqual(["distill", "passive-observer"]);

    releaseStepLock("distill", openclawDir);
    expect(listActiveStepLocks(openclawDir).map((l) => l.stepName)).toEqual(["passive-observer"]);
  });

  it("listActiveStepLocks returns an empty array when the guard dir doesn't exist", () => {
    openclawDir = join(tmpdir(), `hm-guard-nonexistent-${Date.now()}`);
    expect(listActiveStepLocks(openclawDir)).toEqual([]);
  });
});
