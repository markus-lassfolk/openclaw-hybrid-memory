/**
 * Tests for the Task Queue Watchdog — Issue #631
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireDispatchLease,
	getDispatchLease,
} from "../services/task-queue-leases.js";
import {
	TASK_QUEUE_IDLE_PRODUCER,
	type TaskQueueItem,
	type TaskQueueWatchdogConfig,
	getActiveWorktreeBranches,
	isPidAlive,
	isRuntimeExceeded,
	runTaskQueueWatchdog,
	taskQueueItemHasRecognizedSemantics,
	taskQueueItemMatchesStale,
} from "../services/task-queue-watchdog.js";

// ---------------------------------------------------------------------------
// taskQueueItemMatchesStale
// ---------------------------------------------------------------------------

describe("taskQueueItemMatchesStale", () => {
	it("matches by pid and started when present (branch not part of identity)", () => {
		const stale: TaskQueueItem = {
			pid: 42,
			started: "2026-01-01T00:00:00.000Z",
		};
		expect(taskQueueItemMatchesStale({ ...stale }, stale)).toBe(true);
		expect(
			taskQueueItemMatchesStale({ ...stale, branch: "other" }, stale),
		).toBe(true);
		expect(
			taskQueueItemMatchesStale({ pid: 43, started: stale.started }, stale),
		).toBe(false);
	});

	it("without pid/started, matches issue, dispatchToken, and branch (not undefined===undefined)", () => {
		const stale: TaskQueueItem = {
			issue: 99,
			dispatchToken: "tok",
			branch: "feat/x",
		};
		expect(taskQueueItemMatchesStale({ ...stale }, stale)).toBe(true);
		expect(taskQueueItemMatchesStale({ ...stale, issue: 100 }, stale)).toBe(
			false,
		);
		expect(
			taskQueueItemMatchesStale(
				{ issue: 99, dispatchToken: "tok", branch: "feat/y" },
				stale,
			),
		).toBe(false);
	});
});

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
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
		expect(isRuntimeExceeded(fiveHoursAgo, 4 * 60 * 60 * 1000)).toBe(true);
	});

	it("returns false when runtime is within the limit", () => {
		const thirtyMinutesAgo = new Date(
			Date.now() - 30 * 60 * 1000,
		).toISOString();
		expect(isRuntimeExceeded(thirtyMinutesAgo, 4 * 60 * 60 * 1000)).toBe(false);
	});

	it("returns true for tasks started in the past beyond the threshold", () => {
		const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		expect(isRuntimeExceeded(yesterday, 4 * 60 * 60 * 1000)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// taskQueueItemHasRecognizedSemantics (#1037)
// ---------------------------------------------------------------------------

describe("taskQueueItemHasRecognizedSemantics", () => {
	it("rejects metadata-only shells", () => {
		expect(
			taskQueueItemHasRecognizedSemantics({
				updatedAt: "2026-04-04T20:44:39+02:00",
				repo: "markus-lassfolk/openclaw-hybrid-memory",
				maxForge: 3,
			} as unknown as TaskQueueItem),
		).toBe(false);
	});

	it("accepts canonical idle placeholder", () => {
		expect(
			taskQueueItemHasRecognizedSemantics({
				status: "idle",
				producer: TASK_QUEUE_IDLE_PRODUCER,
				details: "x",
			}),
		).toBe(true);
	});

	it("accepts issue-based forge tasks", () => {
		expect(
			taskQueueItemHasRecognizedSemantics({ issue: 1037, status: "running" }),
		).toBe(true);
	});

	it("accepts pid+started runner tasks", () => {
		expect(
			taskQueueItemHasRecognizedSemantics({
				pid: process.pid,
				started: new Date().toISOString(),
			}),
		).toBe(true);
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
		const result = await getActiveWorktreeBranches(
			"/nonexistent/path/that/does/not/exist",
		);
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

	function makeConfig(
		overrides: Partial<TaskQueueWatchdogConfig> = {},
	): TaskQueueWatchdogConfig {
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
		await writeFile(
			join(stateDir, "current.json"),
			JSON.stringify(item, null, 2),
			"utf-8",
		);
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

	// ── No-current / idle placeholder (#983) ──────────────────────────────

	it("writes an idle placeholder and returns ok when current.json was missing", async () => {
		const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
		expect(result.action).toBe("ok");
		expect(result.item?.status).toBe("idle");
		expect(result.item?.producer).toBe("openclaw-hybrid-memory");
		const raw = await readFile(join(stateDir, "current.json"), "utf-8");
		expect(JSON.parse(raw).status).toBe("idle");
		expect(noopLogger.info).toHaveBeenCalled();
	});

	it("returns no-current when current.json is malformed", async () => {
		await mkdir(stateDir, { recursive: true });
		await writeFile(join(stateDir, "current.json"), "not valid json", "utf-8");
		const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
		expect(result.action).toBe("no-current");
	});

	it("returns no-current when current.json contains a non-object JSON value", async () => {
		await mkdir(stateDir, { recursive: true });
		await writeFile(
			join(stateDir, "current.json"),
			JSON.stringify("just a string"),
			"utf-8",
		);
		const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
		expect(result.action).toBe("no-current");
	});

	it("returns no-current when current.json contains a JSON array", async () => {
		await mkdir(stateDir, { recursive: true });
		await writeFile(
			join(stateDir, "current.json"),
			JSON.stringify([1, 2, 3]),
			"utf-8",
		);
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
		expect(noopLogger.info).toHaveBeenCalledWith(
			expect.stringContaining("cleared"),
		);
	});

	it("marks matching dispatch lease as lease-expired when stale entry is cleared", async () => {
		const leased = await acquireDispatchLease({
			stateDir,
			issue: 202,
			branch: "feat/issue-202",
		});
		expect(leased.acquired).toBe(true);
		expect(leased.lease).toBeDefined();

		const recentStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
		await writeCurrentJson({
			issue: 202,
			branch: "feat/issue-202",
			dispatchToken: leased.lease?.token,
			pid: 999999999, // dead -> stale
			started: recentStart,
			status: "running",
		});

		const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
		expect(result.action).toBe("cleared");

		const lease = await getDispatchLease(stateDir, 202);
		expect(lease?.state).toBe("lease-expired");
		expect(lease?.reason).toContain("PID 999999999");
	});

	it("clears metadata-only current.json, archives, and writes canonical idle (#1037)", async () => {
		await writeCurrentJson({
			updatedAt: "2026-04-04T20:44:39+02:00",
			repo: "markus-lassfolk/openclaw-hybrid-memory",
			maxForge: 3,
		} as unknown as TaskQueueItem);

		const result = await runTaskQueueWatchdog(makeConfig(), noopLogger);
		expect(result.action).toBe("cleared");
		expect(result.reason).toContain("metadata-only");
		expect(result.historyPath).toBeDefined();

		const idleRaw = await readFile(join(stateDir, "current.json"), "utf-8");
		const idle = JSON.parse(idleRaw) as TaskQueueItem;
		expect(idle.status).toBe("idle");
		expect(idle.producer).toBe(TASK_QUEUE_IDLE_PRODUCER);
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
		if (result.historyPath == null) throw new Error("expected historyPath");
		const historyContent = JSON.parse(
			await readFile(result.historyPath, "utf-8"),
		) as TaskQueueItem;
		expect(historyContent.issue).toBe(201);
		expect(historyContent.watchdogReason).toContain("PID 999999999");
		expect(historyContent.watchdogClearedAt).toBeDefined();
		expect(historyContent.retryCount).toBe(1);
	});

	// ── Max runtime ──────────────────────────────────────────────────────────

	it("clears entry when runtime exceeds the limit", async () => {
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
		await writeCurrentJson({
			issue: 300,
			title: "Slow task",
			pid: process.pid, // alive PID
			started: fiveHoursAgo,
			status: "running",
		});

		const result = await runTaskQueueWatchdog(
			makeConfig({ maxRuntimeMs: 4 * 60 * 60 * 1000 }),
			noopLogger,
		);
		expect(result.action).toBe("cleared");
		expect(result.reason).toContain("runtime exceeded 4h");
		expect(noopLogger.info).toHaveBeenCalledWith(
			expect.stringContaining("#300"),
		);
	});

	it("returns ok when runtime is within limit", async () => {
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		await writeCurrentJson({
			issue: 301,
			pid: process.pid,
			started: twoHoursAgo,
			status: "running",
		});

		const result = await runTaskQueueWatchdog(
			makeConfig({ maxRuntimeMs: 4 * 60 * 60 * 1000 }),
			noopLogger,
		);
		expect(result.action).toBe("ok");
	});

	// ── Quarantine on retry exhaustion ──────────────────────────────────────

	it("quarantines entry when retryCount reaches maxRetries", async () => {
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
		await writeCurrentJson({
			issue: 400,
			pid: 999999999,
			started: fiveHoursAgo,
			retryCount: 2, // already at limit
		});

		const result = await runTaskQueueWatchdog(
			makeConfig({ maxRetries: 2 }),
			noopLogger,
		);
		expect(result.action).toBe("quarantined");
		expect(noopLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining("quarantined"),
		);
	});

	it("quarantines entry when history already has maxRetries entries for the same issue", async () => {
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();

		// Pre-populate history with 2 cleared entries for issue #500
		await mkdir(historyDir, { recursive: true });
		const prevEntry: TaskQueueItem = { issue: 500, watchdogReason: "prev run" };
		await writeFile(
			join(historyDir, "2026-01-01T00-00-00-cleared.json"),
			JSON.stringify(prevEntry),
			"utf-8",
		);
		await writeFile(
			join(historyDir, "2026-01-01T01-00-00-cleared.json"),
			JSON.stringify(prevEntry),
			"utf-8",
		);

		await writeCurrentJson({
			issue: 500,
			pid: 999999999,
			started: fiveHoursAgo,
		});

		const result = await runTaskQueueWatchdog(
			makeConfig({ maxRetries: 2 }),
			noopLogger,
		);
		expect(result.action).toBe("quarantined");
	});

	it("quarantines issue-less entry when branch matches maxRetries history entries", async () => {
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();

		// Pre-populate history with 2 cleared entries matching the branch (no issue)
		await mkdir(historyDir, { recursive: true });
		const prevEntry: TaskQueueItem = {
			branch: "feat/no-issue",
			watchdogReason: "prev run",
		};
		await writeFile(
			join(historyDir, "2026-01-01T00-00-00-cleared.json"),
			JSON.stringify(prevEntry),
			"utf-8",
		);
		await writeFile(
			join(historyDir, "2026-01-01T01-00-00-cleared.json"),
			JSON.stringify(prevEntry),
			"utf-8",
		);

		await writeCurrentJson({
			branch: "feat/no-issue",
			pid: 999999999,
			started: fiveHoursAgo,
			// No issue number — should still quarantine via branch matching
		});

		const result = await runTaskQueueWatchdog(
			makeConfig({ maxRetries: 2 }),
			noopLogger,
		);
		expect(result.action).toBe("quarantined");
	});

	// ── Retry metadata ───────────────────────────────────────────────────────

	it("increments retryCount on each clear", async () => {
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
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
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
		await writeCurrentJson({
			issue: 601,
			pid: 999999999,
			started: fiveHoursAgo,
			retryCount: 0,
		});

		const result = await runTaskQueueWatchdog(
			makeConfig({ enableRequeue: true, maxRetries: 3 }),
			noopLogger,
		);
		expect(result.action).toBe("cleared");
		expect(result.requeued).toBe(true);
	});

	it("does not set requeued flag when enableRequeue is false (default)", async () => {
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
		await writeCurrentJson({
			issue: 602,
			pid: 999999999,
			started: fiveHoursAgo,
		});

		const result = await runTaskQueueWatchdog(
			makeConfig({ enableRequeue: false }),
			noopLogger,
		);
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
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
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
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
		await writeCurrentJson({
			issue: 999,
			pid: 999999999,
			started: fiveHoursAgo,
		});

		await runTaskQueueWatchdog(makeConfig(), noopLogger);
		expect(noopLogger.info).toHaveBeenCalledWith(
			expect.stringContaining("#999"),
		);
	});

	it("includes branch in log message when present", async () => {
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
		await writeCurrentJson({
			issue: 1001,
			branch: "feat/my-branch",
			pid: 999999999,
			started: fiveHoursAgo,
		});

		await runTaskQueueWatchdog(makeConfig(), noopLogger);
		expect(noopLogger.info).toHaveBeenCalledWith(
			expect.stringContaining("feat/my-branch"),
		);
	});

	it("works without a logger (no throw)", async () => {
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
		await writeCurrentJson({ pid: 999999999, started: fiveHoursAgo });
		await expect(runTaskQueueWatchdog(makeConfig())).resolves.toBeDefined();
	});
});
