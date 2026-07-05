import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capTimeoutByMaintenanceRunDeadline,
  clearMaintenanceRunDeadline,
  getMaintenanceRunAbortSignal,
  getMaintenanceRunDeadlineMs,
  maintenanceRunDeadlineReached,
  remainingMaintenanceRunMs,
  resolveMaintenanceStepDeadlineMs,
  runUntilMaintenanceDeadline,
  setMaintenanceRunDeadlineMs,
} from "../utils/maintenance-run-deadline.js";

describe("maintenance-run-deadline", () => {
  afterEach(() => {
    clearMaintenanceRunDeadline();
  });

  it("tracks orchestrator deadline via env", () => {
    setMaintenanceRunDeadlineMs(10_000);
    expect(getMaintenanceRunDeadlineMs()).toBe(10_000);
    expect(maintenanceRunDeadlineReached(9_999)).toBe(false);
    expect(maintenanceRunDeadlineReached(10_000)).toBe(true);
    expect(remainingMaintenanceRunMs(9_000)).toBe(1_000);
  });

  it("resolveMaintenanceStepDeadlineMs picks earliest deadline", () => {
    setMaintenanceRunDeadlineMs(50_000);
    expect(resolveMaintenanceStepDeadlineMs(40_000, 30)).toBe(50_000);
    expect(resolveMaintenanceStepDeadlineMs(40_000, 120)).toBe(50_000);
    clearMaintenanceRunDeadline();
    expect(resolveMaintenanceStepDeadlineMs(40_000, 30)).toBe(70_000);
  });

  it("capTimeoutByMaintenanceRunDeadline shrinks per-call timeout near run end", () => {
    setMaintenanceRunDeadlineMs(10_000);
    expect(capTimeoutByMaintenanceRunDeadline(45_000, 9_000)).toBe(1_000);
    expect(capTimeoutByMaintenanceRunDeadline(45_000, 10_000)).toBe(0);
  });

  it("getMaintenanceRunAbortSignal aborts when run deadline elapses", () => {
    vi.useFakeTimers();
    try {
      setMaintenanceRunDeadlineMs(Date.now() + 5_000);
      const signal = getMaintenanceRunAbortSignal();
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(false);
      vi.advanceTimersByTime(5_001);
      expect(signal?.aborted).toBe(true);
      expect(maintenanceRunDeadlineReached()).toBe(true);
    } finally {
      vi.useRealTimers();
      clearMaintenanceRunDeadline();
    }
  });
});

describe("runUntilMaintenanceDeadline (#2041 review finding — shared loop-truncation helper)", () => {
  afterEach(() => {
    clearMaintenanceRunDeadline();
  });

  it("processes every item and reports truncatedAt=-1 when no deadline is active", async () => {
    const seen: number[] = [];
    const result = await runUntilMaintenanceDeadline([1, 2, 3], (item) => {
      seen.push(item);
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(result.truncatedAt).toBe(-1);
  });

  it("stops before the item that would run once the deadline is reached", async () => {
    vi.useFakeTimers();
    try {
      setMaintenanceRunDeadlineMs(Date.now() + 10);
      const seen: number[] = [];
      const result = await runUntilMaintenanceDeadline([10, 20, 30, 40, 50], (item, index) => {
        seen.push(item);
        // Deadline elapses while processing index 1 (item 20) — index 2 (item 30) must never run.
        if (index === 1) vi.advanceTimersByTime(11);
      });
      expect(seen).toEqual([10, 20]);
      expect(result.truncatedAt).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("awaits an async fn for each item before checking the next one", async () => {
    const order: string[] = [];
    const result = await runUntilMaintenanceDeadline([1, 2], async (item) => {
      order.push(`start-${item}`);
      await Promise.resolve();
      order.push(`end-${item}`);
    });
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    expect(result.truncatedAt).toBe(-1);
  });
});
