import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decrementReindexLockCount,
  getReindexLockCount,
  incrementReindexLockCount,
  isReindexLockHeld,
  reindexExclusiveLockByPath,
  waitForReindexLockClear,
} from "../backends/vector-db/runtime-locks.js";

describe("runtime-locks re-index cooperative lock (#1841)", () => {
  const dbPath = "/tmp/runtime-locks-test-db";

  afterEach(() => {
    reindexExclusiveLockByPath.delete(dbPath);
    vi.useRealTimers();
  });

  it("tracks nested re-index holders via refcount helpers", () => {
    expect(getReindexLockCount(dbPath)).toBe(0);
    expect(isReindexLockHeld(dbPath)).toBe(false);

    incrementReindexLockCount(dbPath);
    incrementReindexLockCount(dbPath);
    expect(getReindexLockCount(dbPath)).toBe(2);
    expect(isReindexLockHeld(dbPath)).toBe(true);

    decrementReindexLockCount(dbPath);
    expect(getReindexLockCount(dbPath)).toBe(1);

    decrementReindexLockCount(dbPath);
    expect(getReindexLockCount(dbPath)).toBe(0);
    expect(isReindexLockHeld(dbPath)).toBe(false);
  });

  it("waitForReindexLockClear resolves immediately when no lock is held", async () => {
    await expect(waitForReindexLockClear(dbPath, 100)).resolves.toBeUndefined();
  });

  it("waitForReindexLockClear waits until the re-index lock is released", async () => {
    vi.useFakeTimers();
    incrementReindexLockCount(dbPath);

    const waiting = waitForReindexLockClear(dbPath, 1_000);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(40);
    expect(settled).toBe(false);

    decrementReindexLockCount(dbPath);
    await vi.advanceTimersByTimeAsync(60);
    await waiting;
    expect(settled).toBe(true);
  });

  it("waitForReindexLockClear re-checks after drain when lock is re-acquired during await", async () => {
    vi.useFakeTimers();
    incrementReindexLockCount(dbPath);

    const waiting = waitForReindexLockClear(dbPath, 1_000);

    decrementReindexLockCount(dbPath);
    incrementReindexLockCount(dbPath);

    await vi.advanceTimersByTimeAsync(50);
    expect(isReindexLockHeld(dbPath)).toBe(true);

    decrementReindexLockCount(dbPath);
    await vi.advanceTimersByTimeAsync(50);
    await waiting;
    expect(isReindexLockHeld(dbPath)).toBe(false);
  });
});
