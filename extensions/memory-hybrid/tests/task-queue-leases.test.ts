import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireDispatchLease,
	expireDispatchLeases,
	getDispatchLease,
	readDispatchLeaseRegistry,
	transitionDispatchLease,
} from "../services/task-queue-leases.js";

describe("task queue dispatch leases", () => {
	let tmpDir: string;
	let stateDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "task-queue-leases-test-"));
		stateDir = join(tmpDir, "state", "task-queue");
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("acquires lease and blocks duplicate acquire while active", async () => {
		const first = await acquireDispatchLease({
			stateDir,
			issue: 499,
			branch: "feat/issue-499",
			runId: "run-1",
		});
		expect(first.acquired).toBe(true);
		expect(first.lease?.state).toBe("leased");

		const second = await acquireDispatchLease({
			stateDir,
			issue: 499,
			branch: "feat/issue-499",
			runId: "run-1",
		});
		expect(second.acquired).toBe(false);
		expect(second.existing?.state).toBe("leased");
	});

	it("blocks reacquire while a completed dispatch is cooling down", async () => {
		const first = await acquireDispatchLease({
			stateDir,
			issue: 502,
			branch: "feat/issue-502",
			now: new Date("2026-03-16T20:50:00.000Z"),
		});
		expect(first.acquired).toBe(true);
		expect(first.lease).toBeDefined();

		const fromDisk = await getDispatchLease(stateDir, 502);
		expect(fromDisk?.token).toBe(first.lease?.token);
		expect(fromDisk?.state).toBe("leased");

		const transitioned = await transitionDispatchLease({
			stateDir,
			issue: 502,
			token: first.lease?.token,
			toState: "completed",
			reason: "PR created",
			now: new Date("2026-03-16T20:51:00.000Z"),
		});
		expect(transitioned).toBe(true);

		const second = await acquireDispatchLease({
			stateDir,
			issue: 502,
			branch: "feat/issue-502-retry",
			runId: "run-2",
			now: new Date("2026-03-16T20:55:00.000Z"),
		});
		expect(second.acquired).toBe(false);
		expect(second.existing?.state).toBe("completed");
		expect(second.reason).toContain("cooling down");
	});

	it("allows reacquire after completed dispatch visibility cooldown elapses", async () => {
		const first = await acquireDispatchLease({
			stateDir,
			issue: 503,
			branch: "feat/issue-503",
			now: new Date("2026-03-16T20:50:00.000Z"),
		});
		expect(first.acquired).toBe(true);

		const transitioned = await transitionDispatchLease({
			stateDir,
			issue: 503,
			token: first.lease?.token,
			toState: "completed",
			reason: "PR created",
			now: new Date("2026-03-16T20:51:00.000Z"),
		});
		expect(transitioned).toBe(true);

		const second = await acquireDispatchLease({
			stateDir,
			issue: 503,
			branch: "feat/issue-503-retry",
			runId: "run-2",
			now: new Date("2026-03-16T21:02:00.000Z"),
		});
		expect(second.acquired).toBe(true);
		expect(second.lease?.attempt).toBe(2);
	});

	it("blocks reacquire for legacy completed leases without expiresAt (fallback cooldown)", async () => {
		// Seed the registry with a legacy completed lease
		const fs = await import("node:fs");
		const p = await import("node:path");
		const registryPath = p.join(stateDir, "dispatch-leases.json");

		const legacyRegistry = {
			version: 1,
			leases: {
				"504": {
					issue: 504,
					token: "legacy-token-123",
					state: "completed",
					leasedAt: "2026-03-16T20:50:00.000Z",
					updatedAt: "2026-03-16T20:51:00.000Z",
					completedAt: "2026-03-16T20:51:00.000Z",
					expiresAt: undefined, // Missing expiresAt
					attempt: 1,
					branch: "feat/issue-504",
					history: [],
				},
			},
		};
		fs.mkdirSync(p.dirname(registryPath), { recursive: true });
		fs.writeFileSync(registryPath, JSON.stringify(legacyRegistry));

		// Try to acquire within the 10-minute fallback cooldown window (20:55 is < 21:01)
		const withinCooldown = await acquireDispatchLease({
			stateDir,
			issue: 504,
			branch: "feat/issue-504-retry",
			runId: "run-2",
			now: new Date("2026-03-16T20:55:00.000Z"),
		});
		expect(withinCooldown.acquired).toBe(false);
		expect(withinCooldown.existing?.state).toBe("completed");
		expect(withinCooldown.reason).toContain("cooling down");

		// Try to acquire after the fallback cooldown elapses (21:02 is > 21:01)
		const afterCooldown = await acquireDispatchLease({
			stateDir,
			issue: 504,
			branch: "feat/issue-504-retry2",
			runId: "run-3",
			now: new Date("2026-03-16T21:02:00.000Z"),
		});
		expect(afterCooldown.acquired).toBe(true);
	});

	it("expires active leases by TTL and allows reacquire", async () => {
		const now = new Date("2026-03-16T20:50:00.000Z");
		const first = await acquireDispatchLease({
			stateDir,
			issue: 504,
			leaseTtlMs: 1000,
			now,
		});
		expect(first.acquired).toBe(true);

		const expired = await expireDispatchLeases(
			stateDir,
			new Date("2026-03-16T20:50:05.000Z"),
		);
		expect(expired).toBe(1);

		const lease = await getDispatchLease(stateDir, 504);
		expect(lease?.state).toBe("lease-expired");

		const second = await acquireDispatchLease({
			stateDir,
			issue: 504,
			now: new Date("2026-03-16T20:50:06.000Z"),
		});
		expect(second.acquired).toBe(true);
		expect(second.lease?.attempt).toBe(2);
	});

	it("keeps event trail for lease lifecycle", async () => {
		const acquired = await acquireDispatchLease({ stateDir, issue: 505 });
		expect(acquired.acquired).toBe(true);
		const token = acquired.lease?.token;
		expect(token).toBeDefined();

		const running = await transitionDispatchLease({
			stateDir,
			issue: 505,
			token,
			toState: "running",
			pid: 1234,
		});
		expect(running).toBe(true);

		const failed = await transitionDispatchLease({
			stateDir,
			issue: 505,
			token,
			toState: "failed",
			reason: "forge process exited 1",
		});
		expect(failed).toBe(true);

		const registry = await readDispatchLeaseRegistry(stateDir);
		expect(registry.events.length).toBeGreaterThanOrEqual(3);
		const last = registry.events[registry.events.length - 1];
		expect(last.issue).toBe(505);
		expect(last.state).toBe("failed");
	});
});
