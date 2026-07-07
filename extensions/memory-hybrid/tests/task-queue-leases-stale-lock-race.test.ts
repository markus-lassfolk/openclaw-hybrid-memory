/**
 * Regression test for the stale-lock-reclaim TOCTOU race in task-queue-leases.ts's
 * withRegistryLock: if a concurrent process refreshes/re-acquires the lock between our
 * staleness check and our unlink attempt, we must not delete that legitimate lock.
 */

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ lockPath: "", statCallCount: 0, unlinkCalls: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async stat(path: Parameters<typeof actual.stat>[0]) {
      if (typeof path === "string" && path === state.lockPath) {
        state.statCallCount++;
        if (state.statCallCount === 2) {
          // Simulate another process refreshing the lock's mtime between our staleness
          // check and our unlink attempt (e.g. it re-acquired after noticing staleness too).
          await actual.utimes(path, new Date(), new Date());
        } else if (state.statCallCount === 3) {
          // Simulate that same process finishing and cleaning up its lock shortly after,
          // so the acquisition loop can eventually succeed without our code deleting it.
          await actual.rm(path, { force: true });
        }
      }
      return actual.stat(path as string);
    },
    async unlink(path: Parameters<typeof actual.unlink>[0]) {
      if (typeof path === "string") state.unlinkCalls.push(path);
      return actual.unlink(path);
    },
  };
});

const { acquireDispatchLease } = await import("../services/task-queue-leases.js");

const dirs: string[] = [];

afterEach(async () => {
  state.lockPath = "";
  state.statCallCount = 0;
  state.unlinkCalls = [];
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("task-queue-leases stale-lock reclaim race (loop iteration 52 regression)", () => {
  it("does not delete a lock whose mtime changed between the staleness check and the unlink attempt", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "task-queue-leases-race-"));
    dirs.push(tmpDir);
    const stateDir = join(tmpDir, "state", "task-queue");
    await mkdir(stateDir, { recursive: true });
    const lockPath = join(stateDir, "dispatch-leases.lock");
    await writeFile(lockPath, "99999\n2020-01-01T00:00:00.000Z\n", "utf-8");
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lockPath, staleTime, staleTime);
    state.lockPath = lockPath;

    const result = await acquireDispatchLease({ stateDir, issue: 777, branch: "test/race" });

    expect(result.acquired).toBe(true);
    // The only unlink() of the lock path should be the final, legitimate release of the
    // lease we ourselves acquired. If the fix regresses, the stale-reclaim branch would
    // additionally unlink the concurrently-refreshed lock (a second, wrongful call) right
    // after the mocked touch on statCallCount === 2.
    expect(state.unlinkCalls.filter((p) => p === lockPath)).toHaveLength(1);

    const finalStat = await stat(lockPath).catch(() => null);
    expect(finalStat).toBeNull();
  });
});
