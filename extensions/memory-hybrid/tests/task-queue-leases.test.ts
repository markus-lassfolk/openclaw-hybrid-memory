import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  it("expires active leases by TTL and allows reacquire", async () => {
    const now = new Date("2026-03-16T20:50:00.000Z");
    const first = await acquireDispatchLease({
      stateDir,
      issue: 504,
      leaseTtlMs: 1000,
      now,
    });
    expect(first.acquired).toBe(true);

    const expired = await expireDispatchLeases(stateDir, new Date("2026-03-16T20:50:05.000Z"));
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
