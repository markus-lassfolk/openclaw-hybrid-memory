/**
 * Tests for the Dispatch Lease Registry — Issue #634
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DispatchLeaseRegistry,
  type DispatchLease,
  type DispatchLeaseStatus,
} from "../services/dispatch-lease.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLease(
  overrides: Partial<DispatchLease> & { issueNumber: number },
): DispatchLease {
  const now = new Date().toISOString();
  return {
    token: `test-token-${overrides.issueNumber}`,
    status: "leased",
    dispatchedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let registry: DispatchLeaseRegistry;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "dispatch-lease-test-"));
  registry = new DispatchLeaseRegistry({ leasesDir: tmpDir, defaultTtlMs: 60_000 });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// acquireLease
// ---------------------------------------------------------------------------

describe("acquireLease", () => {
  it("acquires a new lease when none exists", async () => {
    const result = await registry.acquireLease({ issueNumber: 42 });

    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error("Expected acquired=true");

    expect(result.lease.issueNumber).toBe(42);
    expect(result.lease.status).toBe("leased");
    expect(typeof result.lease.token).toBe("string");
    expect(result.lease.token.length).toBeGreaterThan(0);
    expect(result.lease.dispatchedAt).toBeTruthy();
    expect(result.lease.expiresAt).toBeTruthy();
  });

  it("stores the branch when provided", async () => {
    const result = await registry.acquireLease({
      issueNumber: 43,
      branch: "copilot/fix-43",
    });

    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error("Expected acquired=true");
    expect(result.lease.branch).toBe("copilot/fix-43");
  });

  it("persists the lease to disk", async () => {
    await registry.acquireLease({ issueNumber: 44 });

    const raw = await readFile(join(tmpDir, "issue-44.json"), "utf-8");
    const stored = JSON.parse(raw) as DispatchLease;
    expect(stored.issueNumber).toBe(44);
    expect(stored.status).toBe("leased");
  });

  it("blocks a second dispatch for the same issue while lease is active", async () => {
    const first = await registry.acquireLease({ issueNumber: 45 });
    expect(first.acquired).toBe(true);

    const second = await registry.acquireLease({ issueNumber: 45 });
    expect(second.acquired).toBe(false);
    if (second.acquired) throw new Error("Expected acquired=false");
    expect(second.existing.issueNumber).toBe(45);
    expect(second.existing.status).toBe("leased");
  });

  it("allows re-acquisition after a completed lease", async () => {
    const first = await registry.acquireLease({ issueNumber: 46 });
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error();

    await registry.releaseLease(46, first.lease.token, "completed");

    const second = await registry.acquireLease({ issueNumber: 46 });
    expect(second.acquired).toBe(true);
    if (!second.acquired) throw new Error();
    expect(second.lease.token).not.toBe(first.lease.token);
  });

  it("allows re-acquisition after a failed lease", async () => {
    const first = await registry.acquireLease({ issueNumber: 47 });
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error();

    await registry.releaseLease(47, first.lease.token, "failed", "build error");

    const second = await registry.acquireLease({ issueNumber: 47 });
    expect(second.acquired).toBe(true);
  });

  it("allows re-acquisition after an expired lease", async () => {
    // Plant an already-expired lease
    const expiredLease = makeLease({
      issueNumber: 48,
      status: "leased",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await writeFile(
      join(tmpDir, "issue-48.json"),
      JSON.stringify(expiredLease),
      "utf-8",
    );

    const result = await registry.acquireLease({ issueNumber: 48 });
    expect(result.acquired).toBe(true);
  });

  it("allows re-acquisition after a lease-expired status", async () => {
    const expiredStatusLease = makeLease({
      issueNumber: 49,
      status: "lease-expired" as DispatchLeaseStatus,
    });
    await writeFile(
      join(tmpDir, "issue-49.json"),
      JSON.stringify(expiredStatusLease),
      "utf-8",
    );

    const result = await registry.acquireLease({ issueNumber: 49 });
    expect(result.acquired).toBe(true);
  });

  it("generates a unique token per acquisition", async () => {
    const first = await registry.acquireLease({ issueNumber: 50 });
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error();
    await registry.releaseLease(50, first.lease.token, "completed");

    const second = await registry.acquireLease({ issueNumber: 50 });
    expect(second.acquired).toBe(true);
    if (!second.acquired) throw new Error();

    expect(first.lease.token).not.toBe(second.lease.token);
  });

  it("respects custom ttlMs", async () => {
    const result = await registry.acquireLease({ issueNumber: 51, ttlMs: 5000 });
    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error();

    const expiresAt = new Date(result.lease.expiresAt).getTime();
    const now = Date.now();
    // Should expire in ~5 seconds, not 60s
    expect(expiresAt - now).toBeLessThan(10_000);
    expect(expiresAt - now).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// updateLease
// ---------------------------------------------------------------------------

describe("updateLease", () => {
  it("transitions leased → running", async () => {
    const acq = await registry.acquireLease({ issueNumber: 100 });
    expect(acq.acquired).toBe(true);
    if (!acq.acquired) throw new Error();

    const updated = await registry.updateLease(100, acq.lease.token, {
      status: "running",
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("running");
    expect(updated?.completedAt).toBeUndefined();
  });

  it("sets completedAt when transitioning to a terminal status", async () => {
    const acq = await registry.acquireLease({ issueNumber: 101 });
    expect(acq.acquired).toBe(true);
    if (!acq.acquired) throw new Error();

    const updated = await registry.updateLease(101, acq.lease.token, {
      status: "completed",
      details: "PR #99 merged",
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("completed");
    expect(updated?.completedAt).toBeTruthy();
    expect(updated?.details).toBe("PR #99 merged");
  });

  it("returns null when token does not match", async () => {
    await registry.acquireLease({ issueNumber: 102 });

    const result = await registry.updateLease(102, "wrong-token", {
      status: "running",
    });
    expect(result).toBeNull();
  });

  it("returns null when no lease exists", async () => {
    const result = await registry.updateLease(103, "any-token", {
      status: "running",
    });
    expect(result).toBeNull();
  });

  it("persists the update to disk", async () => {
    const acq = await registry.acquireLease({ issueNumber: 104 });
    if (!acq.acquired) throw new Error();

    await registry.updateLease(104, acq.lease.token, {
      status: "running",
      branch: "copilot/fix-104",
    });

    const raw = await readFile(join(tmpDir, "issue-104.json"), "utf-8");
    const stored = JSON.parse(raw) as DispatchLease;
    expect(stored.status).toBe("running");
    expect(stored.branch).toBe("copilot/fix-104");
  });
});

// ---------------------------------------------------------------------------
// releaseLease
// ---------------------------------------------------------------------------

describe("releaseLease", () => {
  it("marks lease as completed", async () => {
    const acq = await registry.acquireLease({ issueNumber: 200 });
    if (!acq.acquired) throw new Error();

    const released = await registry.releaseLease(200, acq.lease.token, "completed");
    expect(released).not.toBeNull();
    expect(released?.status).toBe("completed");
    expect(released?.completedAt).toBeTruthy();
  });

  it("marks lease as failed with details", async () => {
    const acq = await registry.acquireLease({ issueNumber: 201 });
    if (!acq.acquired) throw new Error();

    const released = await registry.releaseLease(
      201,
      acq.lease.token,
      "failed",
      "forge exit code 1",
    );
    expect(released).not.toBeNull();
    expect(released?.status).toBe("failed");
    expect(released?.details).toBe("forge exit code 1");
  });

  it("returns null for wrong token", async () => {
    await registry.acquireLease({ issueNumber: 202 });
    const result = await registry.releaseLease(202, "bad-token", "completed");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getActiveLease / isLeased
// ---------------------------------------------------------------------------

describe("getActiveLease", () => {
  it("returns the lease when active", async () => {
    const acq = await registry.acquireLease({ issueNumber: 300 });
    if (!acq.acquired) throw new Error();

    const active = await registry.getActiveLease(300);
    expect(active).not.toBeNull();
    expect(active?.issueNumber).toBe(300);
  });

  it("returns null when no lease file exists", async () => {
    const active = await registry.getActiveLease(301);
    expect(active).toBeNull();
  });

  it("returns null after the lease is released as completed", async () => {
    const acq = await registry.acquireLease({ issueNumber: 302 });
    if (!acq.acquired) throw new Error();
    await registry.releaseLease(302, acq.lease.token, "completed");

    const active = await registry.getActiveLease(302);
    expect(active).toBeNull();
  });

  it("returns null for an expired lease (past expiresAt)", async () => {
    const expiredLease = makeLease({
      issueNumber: 303,
      status: "leased",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await writeFile(
      join(tmpDir, "issue-303.json"),
      JSON.stringify(expiredLease),
      "utf-8",
    );

    const active = await registry.getActiveLease(303);
    expect(active).toBeNull();
  });
});

describe("isLeased", () => {
  it("returns true for an active lease", async () => {
    await registry.acquireLease({ issueNumber: 400 });
    expect(await registry.isLeased(400)).toBe(true);
  });

  it("returns false when no lease exists", async () => {
    expect(await registry.isLeased(401)).toBe(false);
  });

  it("returns false after completing the lease", async () => {
    const acq = await registry.acquireLease({ issueNumber: 402 });
    if (!acq.acquired) throw new Error();
    await registry.releaseLease(402, acq.lease.token, "completed");
    expect(await registry.isLeased(402)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// expireStaleLeases
// ---------------------------------------------------------------------------

describe("expireStaleLeases", () => {
  it("returns empty array when leasesDir does not exist", async () => {
    const reg = new DispatchLeaseRegistry({
      leasesDir: join(tmpDir, "nonexistent"),
    });
    const result = await reg.expireStaleLeases();
    expect(result).toEqual([]);
  });

  it("marks past-deadline leased entries as lease-expired", async () => {
    const expiredLease = makeLease({
      issueNumber: 500,
      status: "leased",
      expiresAt: new Date(Date.now() - 2000).toISOString(),
    });
    await writeFile(
      join(tmpDir, "issue-500.json"),
      JSON.stringify(expiredLease),
      "utf-8",
    );

    const expired = await registry.expireStaleLeases();
    expect(expired).toHaveLength(1);
    expect(expired[0].issueNumber).toBe(500);
    expect(expired[0].status).toBe("lease-expired");

    const stored = JSON.parse(
      await readFile(join(tmpDir, "issue-500.json"), "utf-8"),
    ) as DispatchLease;
    expect(stored.status).toBe("lease-expired");
  });

  it("marks past-deadline running entries as lease-expired", async () => {
    const runningLease = makeLease({
      issueNumber: 501,
      status: "running",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await writeFile(
      join(tmpDir, "issue-501.json"),
      JSON.stringify(runningLease),
      "utf-8",
    );

    const expired = await registry.expireStaleLeases();
    expect(expired.some((l) => l.issueNumber === 501)).toBe(true);
  });

  it("does not affect active (non-expired) leases", async () => {
    await registry.acquireLease({ issueNumber: 502 }); // 60s TTL

    const expired = await registry.expireStaleLeases();
    expect(expired.every((l) => l.issueNumber !== 502)).toBe(true);

    const active = await registry.getActiveLease(502);
    expect(active).not.toBeNull();
  });

  it("does not re-expire already-terminal leases", async () => {
    const completedLease = makeLease({
      issueNumber: 503,
      status: "completed",
      expiresAt: new Date(Date.now() - 5000).toISOString(),
    });
    await writeFile(
      join(tmpDir, "issue-503.json"),
      JSON.stringify(completedLease),
      "utf-8",
    );

    const expired = await registry.expireStaleLeases();
    expect(expired.every((l) => l.issueNumber !== 503)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deleteLease
// ---------------------------------------------------------------------------

describe("deleteLease", () => {
  it("removes the lease file from disk", async () => {
    await registry.acquireLease({ issueNumber: 600 });

    await registry.deleteLease(600);

    const active = await registry.getActiveLease(600);
    expect(active).toBeNull();
  });

  it("does not throw when the lease does not exist", async () => {
    await expect(registry.deleteLease(601)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listLeases
// ---------------------------------------------------------------------------

describe("listLeases", () => {
  it("returns an empty array when directory does not exist", async () => {
    const reg = new DispatchLeaseRegistry({
      leasesDir: join(tmpDir, "nonexistent"),
    });
    expect(await reg.listLeases()).toEqual([]);
  });

  it("lists all leases sorted newest first", async () => {
    // Write three leases with different dispatchedAt timestamps
    const older = makeLease({
      issueNumber: 700,
      dispatchedAt: new Date(Date.now() - 10_000).toISOString(),
    });
    const newer = makeLease({
      issueNumber: 701,
      dispatchedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const newest = makeLease({
      issueNumber: 702,
      dispatchedAt: new Date().toISOString(),
    });

    for (const lease of [older, newer, newest]) {
      await writeFile(
        join(tmpDir, `issue-${lease.issueNumber}.json`),
        JSON.stringify(lease),
        "utf-8",
      );
    }

    const list = await registry.listLeases();
    expect(list).toHaveLength(3);
    expect(list[0].issueNumber).toBe(702);
    expect(list[1].issueNumber).toBe(701);
    expect(list[2].issueNumber).toBe(700);
  });

  it("skips unreadable files without throwing", async () => {
    await registry.acquireLease({ issueNumber: 703 });
    // Write a corrupt file
    await writeFile(join(tmpDir, "issue-704.json"), "not-json", "utf-8");

    const list = await registry.listLeases();
    const numbers = list.map((l) => l.issueNumber);
    expect(numbers).toContain(703);
    expect(numbers).not.toContain(704);
  });
});

// ---------------------------------------------------------------------------
// Cross-issue isolation
// ---------------------------------------------------------------------------

describe("cross-issue isolation", () => {
  it("leasing issue A does not block leasing issue B", async () => {
    const a = await registry.acquireLease({ issueNumber: 800 });
    const b = await registry.acquireLease({ issueNumber: 801 });

    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });

  it("completing issue A does not affect issue B's active lease", async () => {
    const a = await registry.acquireLease({ issueNumber: 900 });
    const b = await registry.acquireLease({ issueNumber: 901 });
    if (!a.acquired || !b.acquired) throw new Error();

    await registry.releaseLease(900, a.lease.token, "completed");

    expect(await registry.isLeased(901)).toBe(true);
  });
});
