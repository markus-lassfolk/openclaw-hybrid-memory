/**
 * Tests for the Task Queue Watchdog — Issue #631
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isPidAlive,
  isRuntimeExceeded,
  getActiveWorktreeBranches,
  runTaskQueueWatchdog,
  type TaskQueueItem,
  type TaskQueueWatchdogConfig,
} from "../services/task-queue-watchdog.js";

// ---------------------------------------------------------------------------
// isPidAlive tests
// ---------------------------------------------------------------------------

describe("isPidAlive", () => {
  it("returns true for the current process PID", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for PID 0", () => {
    expect(isPidAlive(0)).toBe(false);
  });

  it("returns false for negative PID", () => {
    expect(isPidAlive(-1)).toBe(false);
  });

  it("returns false for a PID that does not exist", () => {
    // PID 999999999 is extremely unlikely to be alive
    expect(isPidAlive(999999999)).toBe(false);
  });

  it("returns false for non-integer PID", () => {
    expect(isPidAlive(1.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRuntimeExceeded tests
// ---------------------------------------------------------------------------

describe("isRuntimeExceeded", () => {
  it("returns false when started is undefined", () => {
    expect(isRuntimeExceeded(undefined, 1000)).toBe(false);
  });

  it("returns false when started is not a valid date", () => {
    expect(isRuntimeExceeded("not-a-date", 1000)).toBe(false);
  });

  it("returns true when runtime exceeds the limit", () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    expect(isRuntimeExceeded(fiveHoursAgo, 4 * 60 * 60 * 1000)).toBe(true);
  });

  it("returns false when runtime is within the limit", () => {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(isRuntimeExceeded(thirtyMinutesAgo, 4 * 60 * 60 * 1000)).toBe(false);
  });

  it("returns true for tasks started in the past beyond the threshold", () => {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(isRuntimeExceeded(yesterday, 4 * 60 * 60 * 1000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getActiveWorktreeBranches tests (mocked git)
// ---------------------------------------------------------------------------

describe("getActiveWorktreeBranches", () => {
  it("returns empty set when given a non-git directory", async () => {
    const result = await getActiveWorktreeBranches("/tmp");
    // Should not throw, just return empty set
    expect(result instanceof Set).toBe(true);
  });

  it("returns empty set on git failure", async () => {
    const result = await getActiveWorktreeBranches("/nonexistent/path/that/does/not/exist");
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runTaskQueueWatchdog tests (file-system based)
// ---------------------------------------------------------------------------

describe("runTaskQueueWatchdog", () => {
  let tmpDir: string;
  let stateDir: string;
  let historyDir: string;
  const noopLogger = {
    warn: vi.fn(),
    info: vi.fn(),
  };

  function makeConfig(overrides: Partial<TaskQueueWatchdogConfig> = {}): TaskQueueWatchdogConfig {
    return {
      stateDir,
      checkBranch: false, // Disable git checks by default for unit tests
      maxRuntimeMs: 4 * 60 * 60 * 1000,
      maxRetries: 2,
      ...overrides,
    };
  }

  async function writeCurrentJson(item: TaskQueueItem): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "current.json"), JSON.stringify(item, null, 2), "utf-8");
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "watchdog-test-"));
    stateDir = join(tmpDir, "state", "task-queue");
    historyDir = join(stateDir, "history");
    noopLogger.warn.mockReset();
    noopLogger.info.mockReset();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── No-current ──────────────────────────────────────────────────────────

  it("returns no-current when current.json does not exist", async () => {
    const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
    expect(result.action).toBe("no-current");
  });

  it("returns no-current when current.json is malformed", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "current.json"), "not valid json", "utf-8");
    const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
    expect(result.action).toBe("no-current");
  });

  // ── Healthy entry ────────────────────────────────────────────────────────

  it("returns ok for a healthy entry (live PID, recent start)", async () => {
    const recentStart = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    await writeCurrentJson({
      issue: 100,
      title: "Test issue",
      branch: "feat/test",
      pid: process.pid, // current process — definitely alive
      started: recentStart,
      status: "running",
    });

    const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
    expect(result.action).toBe("ok");
    expect(result.item?.issue).toBe(100);
    expect(noopLogger.warn).not.toHaveBeenCalled();
    expect(noopLogger.info).not.toHaveBeenCalled();
  });

  // ── Dead PID ─────────────────────────────────────────────────────────────

  it("clears entry when PID is dead", async () => {
    const recentStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await writeCurrentJson({
      issue: 200,
      title: "Dead process task",
      pid: 999999999, // no such PID
      started: recentStart,
      status: "running",
    });

    const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
    expect(result.action).toBe("cleared");
    expect(result.reason).toContain("PID 999999999 is no longer alive");
    expect(noopLogger.info).toHaveBeenCalledWith(expect.stringContaining("cleared"));
  });

  it("moves current.json to history on dead PID", async () => {
    const recentStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await writeCurrentJson({
      issue: 201,
      pid: 999999999,
      started: recentStart,
    });

    const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
    expect(result.historyPath).toBeDefined();

    // current.json should be gone
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(stateDir, "current.json"))).toBe(false);

    // history file should exist and contain the enriched item
    const historyContent = JSON.parse(await readFile(result.historyPath!, "utf-8")) as TaskQueueItem;
    expect(historyContent.issue).toBe(201);
    expect(historyContent.watchdogReason).toContain("PID 999999999");
    expect(historyContent.watchdogClearedAt).toBeDefined();
    expect(historyContent.retryCount).toBe(1);
  });

  // ── Max runtime ──────────────────────────────────────────────────────────

  it("clears entry when runtime exceeds the limit", async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await writeCurrentJson({
      issue: 300,
      title: "Slow task",
      pid: process.pid, // alive PID
      started: fiveHoursAgo,
      status: "running",
    });

    const result = await runTaskQueueWatchdog(makeConfig({ maxRuntimeMs: 4 * 60 * 60 * 1000 }), noopLogger);
    expect(result.action).toBe("cleared");
    expect(result.reason).toContain("runtime exceeded 4h");
    expect(noopLogger.info).toHaveBeenCalledWith(expect.stringContaining("#300"));
  });

  it("returns ok when runtime is within limit", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeCurrentJson({
      issue: 301,
      pid: process.pid,
      started: twoHoursAgo,
      status: "running",
    });

    const result = await runTaskQueueWatchdog(makeConfig({ maxRuntimeMs: 4 * 60 * 60 * 1000 }), noopLogger);
    expect(result.action).toBe("ok");
  });

  // ── Quarantine on retry exhaustion ──────────────────────────────────────

  it("quarantines entry when retryCount reaches maxRetries", async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await writeCurrentJson({
      issue: 400,
      pid: 999999999,
      started: fiveHoursAgo,
      retryCount: 2, // already at limit
    });

    const result = await runTaskQueueWatchdog(makeConfig({ maxRetries: 2 }), noopLogger);
    expect(result.action).toBe("quarantined");
    expect(noopLogger.warn).toHaveBeenCalledWith(expect.stringContaining("quarantined"));
  });

  it("quarantines entry when history already has maxRetries entries for the same issue", async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

    // Pre-populate history with 2 cleared entries for issue #500
    await mkdir(historyDir, { recursive: true });
    const prevEntry: TaskQueueItem = { issue: 500, watchdogReason: "prev run" };
    await writeFile(join(historyDir, "2026-01-01T00-00-00-cleared.json"), JSON.stringify(prevEntry), "utf-8");
    await writeFile(join(historyDir, "2026-01-01T01-00-00-cleared.json"), JSON.stringify(prevEntry), "utf-8");

    await writeCurrentJson({
      issue: 500,
      pid: 999999999,
      started: fiveHoursAgo,
    });

    const result = await runTaskQueueWatchdog(makeConfig({ maxRetries: 2 }), noopLogger);
    expect(result.action).toBe("quarantined");
  });

  // ── Retry metadata ───────────────────────────────────────────────────────

  it("increments retryCount on each clear", async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await writeCurrentJson({
      issue: 600,
      pid: 999999999,
      started: fiveHoursAgo,
      retryCount: 0,
    });

    const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
    expect(result.item?.retryCount).toBe(1);
  });

  it("attaches requeued flag when enableRequeue is true and retries remain", async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await writeCurrentJson({
      issue: 601,
      pid: 999999999,
      started: fiveHoursAgo,
      retryCount: 0,
    });

    const result = await runTaskQueueWatchdog(makeConfig({ enableRequeue: true, maxRetries: 3 }), noopLogger);
    expect(result.action).toBe("cleared");
    expect(result.requeued).toBe(true);
  });

  it("does not set requeued flag when enableRequeue is false (default)", async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await writeCurrentJson({
      issue: 602,
      pid: 999999999,
      started: fiveHoursAgo,
    });

    const result = await runTaskQueueWatchdog(makeConfig({ enableRequeue: false }), noopLogger);
    expect(result.requeued).toBeFalsy();
  });

  // ── Entry without PID or started ─────────────────────────────────────────

  it("returns ok for entry with no PID and recent/missing started", async () => {
    await writeCurrentJson({
      issue: 700,
      title: "PID-less task",
      status: "pending",
    });

    const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
    expect(result.action).toBe("ok");
  });

  it("clears entry with no PID when runtime is exceeded", async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await writeCurrentJson({
      issue: 701,
      started: fiveHoursAgo,
      // No PID — only runtime check applies
    });

    const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
    expect(result.action).toBe("cleared");
    expect(result.reason).toContain("runtime exceeded");
  });

  // ── Logger output ────────────────────────────────────────────────────────

  it("includes issue number in log message when present", async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await writeCurrentJson({ issue: 999, pid: 999999999, started: fiveHoursAgo });

    await runTaskQueueWatchdog(makeConfig(), noopLogger);
    expect(noopLogger.info).toHaveBeenCalledWith(expect.stringContaining("#999"));
  });

  it("includes branch in log message when present", async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await writeCurrentJson({
      issue: 1001,
      branch: "feat/my-branch",
      pid: 999999999,
      started: fiveHoursAgo,
    });

    await runTaskQueueWatchdog(makeConfig(), noopLogger);
    expect(noopLogger.info).toHaveBeenCalledWith(expect.stringContaining("feat/my-branch"));
  });

  it("works without a logger (no throw)", async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    await writeCurrentJson({ pid: 999999999, started: fiveHoursAgo });
    await expect(runTaskQueueWatchdog(makeConfig())).resolves.toBeDefined();
  });
});
