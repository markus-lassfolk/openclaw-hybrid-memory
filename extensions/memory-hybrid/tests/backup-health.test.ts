/**
 * Tests for Issue #2230 — backup health/heartbeat alerting.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackupHealthAlertPolicy,
  classifyBackupFailureReason,
  evaluateAndMaybeAlertBackupHealth,
  evaluateBackupHealth,
  readBackupStateFile,
  recordBackupOutcome,
} from "../services/backup-health.js";

const POLICY: BackupHealthAlertPolicy = { enabled: true, staleAfterHours: 192, dedupeWindowHours: 24 };

describe("classifyBackupFailureReason", () => {
  it("classifies the literal DorisVM disk-full error message", () => {
    expect(classifyBackupFailureReason("SQLite backup failed: Error: database or disk is full")).toBe("disk_full");
  });

  it("classifies ENOSPC / no space left variants", () => {
    expect(classifyBackupFailureReason("Error: ENOSPC: no space left on device, write")).toBe("disk_full");
  });

  it("classifies permission errors", () => {
    expect(classifyBackupFailureReason("EACCES: permission denied, open '/backups/x'")).toBe("permission_denied");
  });

  it("classifies missing-path errors", () => {
    expect(classifyBackupFailureReason("ENOENT: no such file or directory, mkdir '/does/not/exist'")).toBe(
      "path_not_found",
    );
  });

  it("classifies integrity failures", () => {
    expect(classifyBackupFailureReason("SQLite integrity check failed before backup")).toBe("integrity_check_failed");
  });

  it("falls back to unknown for unrecognized messages", () => {
    expect(classifyBackupFailureReason("something unexpected happened")).toBe("unknown");
    expect(classifyBackupFailureReason(undefined)).toBe("unknown");
    expect(classifyBackupFailureReason(null)).toBe("unknown");
  });
});

describe("evaluateBackupHealth", () => {
  const now = Date.parse("2026-08-02T12:00:00Z");

  it("returns 'unknown' when no state has ever been recorded", () => {
    const health = evaluateBackupHealth(null, now, POLICY);
    expect(health.status).toBe("unknown");
    expect(health.lastSuccessAt).toBeNull();
    expect(health.remediation.length).toBeGreaterThan(0);
  });

  it("returns 'ok' for a fresh successful run", () => {
    const health = evaluateBackupHealth({ ok: true, timestamp: new Date(now).toISOString() }, now, POLICY);
    expect(health.status).toBe("ok");
    expect(health.reasonCategory).toBeNull();
    expect(health.ageSinceLastSuccessHours).toBeCloseTo(0, 1);
    expect(health.consecutiveFailures).toBe(0);
  });

  it("returns 'failed' with a classified reason category for a failed run (disk-full)", () => {
    const health = evaluateBackupHealth(
      {
        ok: false,
        timestamp: new Date(now).toISOString(),
        error: "SQLite backup failed: Error: database or disk is full",
        consecutiveFailures: 2,
      },
      now,
      POLICY,
    );
    expect(health.status).toBe("failed");
    expect(health.reasonCategory).toBe("disk_full");
    expect(health.consecutiveFailures).toBe(2);
    expect(health.remediation.some((r) => r.toLowerCase().includes("disk"))).toBe(true);
  });

  it("returns 'stale' when the last success is older than the configured staleAfterHours, even without an explicit failure", () => {
    const ninetyHoursAgo = new Date(now - 200 * 60 * 60 * 1000).toISOString();
    const health = evaluateBackupHealth({ ok: true, timestamp: ninetyHoursAgo }, now, POLICY);
    expect(health.status).toBe("stale");
    expect(health.ageSinceLastSuccessHours).toBeGreaterThan(POLICY.staleAfterHours);
  });

  it("carries forward lastSuccessAt from a prior success across a subsequent failure", () => {
    const successAt = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const health = evaluateBackupHealth(
      { ok: false, timestamp: new Date(now).toISOString(), error: "boom", lastSuccessAt: successAt },
      now,
      POLICY,
    );
    expect(health.status).toBe("failed");
    expect(health.lastSuccessAt).toBe(successAt);
    expect(health.ageSinceLastSuccessHours).toBeCloseTo(48, 0);
  });
});

describe("recordBackupOutcome", () => {
  let dir: string;
  let stateFile: string;

  beforeEach(() => {
    dir = join(tmpdir(), `backup-health-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    stateFile = join(dir, "memory-backup-last.json");
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a fresh success and resets consecutiveFailures to 0", () => {
    const state = recordBackupOutcome(stateFile, {
      ok: true,
      timestamp: "2026-08-02T04:00:00Z",
      backupDir: "/backups/x",
      sqliteSize: 100,
      lancedbSize: 200,
      durationMs: 10,
      integrityOk: true,
      snapshotSkewMs: 0,
    });
    expect(state.ok).toBe(true);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastSuccessAt).toBe("2026-08-02T04:00:00Z");
    expect(readBackupStateFile(stateFile)?.ok).toBe(true);
  });

  it("increments consecutiveFailures across repeated failures and classifies the reason", () => {
    recordBackupOutcome(stateFile, {
      ok: false,
      timestamp: "2026-07-26T04:00:00Z",
      error: "SQLite backup failed: Error: database or disk is full",
    });
    const second = recordBackupOutcome(stateFile, {
      ok: false,
      timestamp: "2026-07-27T04:00:00Z",
      error: "SQLite backup failed: Error: database or disk is full",
    });
    expect(second.consecutiveFailures).toBe(2);
    expect(second.reasonCategory).toBe("disk_full");
  });

  it("carries forward lastSuccessAt from a prior success into a subsequent failure record", () => {
    recordBackupOutcome(stateFile, {
      ok: true,
      timestamp: "2026-07-20T04:00:00Z",
      backupDir: "/backups/x",
      sqliteSize: 1,
      lancedbSize: 1,
      durationMs: 1,
      integrityOk: true,
      snapshotSkewMs: 0,
    });
    const failed = recordBackupOutcome(stateFile, {
      ok: false,
      timestamp: "2026-07-26T04:00:00Z",
      error: "disk is full",
    });
    expect(failed.lastSuccessAt).toBe("2026-07-20T04:00:00Z");
    expect(failed.consecutiveFailures).toBe(1);
  });

  it("a fresh success clears prior alert bookkeeping (#2230 recovery)", () => {
    recordBackupOutcome(stateFile, { ok: false, timestamp: "2026-07-26T04:00:00Z", error: "disk is full" });
    // Simulate an alert having fired for the failure.
    evaluateAndMaybeAlertBackupHealth(stateFile, POLICY, Date.parse("2026-07-26T05:00:00Z"));
    expect(readBackupStateFile(stateFile)?.lastAlertedFingerprint).toBeDefined();

    const success = recordBackupOutcome(stateFile, {
      ok: true,
      timestamp: "2026-08-02T04:00:00Z",
      backupDir: "/backups/x",
      sqliteSize: 1,
      lancedbSize: 1,
      durationMs: 1,
      integrityOk: true,
      snapshotSkewMs: 0,
    });
    expect(success.lastAlertedAt).toBeUndefined();
    expect(success.lastAlertedFingerprint).toBeUndefined();
  });
});

describe("evaluateAndMaybeAlertBackupHealth (dedup + recovery, #2230)", () => {
  let dir: string;
  let stateFile: string;

  beforeEach(() => {
    dir = join(tmpdir(), `backup-health-alert-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    stateFile = join(dir, "memory-backup-last.json");
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("alerts on a disk-full failure and persists dedup bookkeeping", () => {
    recordBackupOutcome(stateFile, {
      ok: false,
      timestamp: "2026-07-26T04:00:10Z",
      error: "SQLite backup failed: Error: database or disk is full",
    });
    const nowMs = Date.parse("2026-07-26T04:05:00Z");
    const result = evaluateAndMaybeAlertBackupHealth(stateFile, POLICY, nowMs);

    expect(result.alerted).toBe(true);
    expect(result.health.status).toBe("failed");
    expect(result.health.reasonCategory).toBe("disk_full");
    expect(result.alertMessage).toContain("disk_full");

    const persisted = readBackupStateFile(stateFile);
    expect(persisted?.lastAlertedFingerprint).toBe("failed:disk_full");
    expect(persisted?.lastAlertedAt).toBeDefined();
  });

  it("deduplicates repeated alerts for the same persisting failure within the dedupe window", () => {
    recordBackupOutcome(stateFile, {
      ok: false,
      timestamp: "2026-07-26T04:00:10Z",
      error: "SQLite backup failed: Error: database or disk is full",
    });
    const first = evaluateAndMaybeAlertBackupHealth(stateFile, POLICY, Date.parse("2026-07-26T04:05:00Z"));
    expect(first.alerted).toBe(true);

    // Heartbeat ticks again a few hours later — still failed, still well within the 24h dedupe window.
    const second = evaluateAndMaybeAlertBackupHealth(stateFile, POLICY, Date.parse("2026-07-26T10:00:00Z"));
    expect(second.alerted).toBe(false);
    expect(second.health.status).toBe("failed");

    // And again just under the window boundary.
    const third = evaluateAndMaybeAlertBackupHealth(stateFile, POLICY, Date.parse("2026-07-27T03:59:00Z"));
    expect(third.alerted).toBe(false);
  });

  it("re-alerts once the dedupe window has elapsed for a persisting failure", () => {
    recordBackupOutcome(stateFile, {
      ok: false,
      timestamp: "2026-07-26T04:00:10Z",
      error: "SQLite backup failed: Error: database or disk is full",
    });
    evaluateAndMaybeAlertBackupHealth(stateFile, POLICY, Date.parse("2026-07-26T04:05:00Z"));

    const later = evaluateAndMaybeAlertBackupHealth(stateFile, POLICY, Date.parse("2026-07-27T05:00:00Z"));
    expect(later.alerted).toBe(true);
  });

  it("recovery: a later successful backup clears the stale failure state from health output", () => {
    recordBackupOutcome(stateFile, {
      ok: false,
      timestamp: "2026-07-26T04:00:10Z",
      error: "SQLite backup failed: Error: database or disk is full",
    });
    evaluateAndMaybeAlertBackupHealth(stateFile, POLICY, Date.parse("2026-07-26T04:05:00Z"));

    recordBackupOutcome(stateFile, {
      ok: true,
      timestamp: "2026-08-02T04:00:00Z",
      backupDir: "/backups/x",
      sqliteSize: 1,
      lancedbSize: 1,
      durationMs: 1,
      integrityOk: true,
      snapshotSkewMs: 0,
    });

    const result = evaluateAndMaybeAlertBackupHealth(stateFile, POLICY, Date.parse("2026-08-02T04:01:00Z"));
    expect(result.health.status).toBe("ok");
    expect(result.alerted).toBe(false);
  });

  it("never alerts when alerting is disabled in policy", () => {
    recordBackupOutcome(stateFile, {
      ok: false,
      timestamp: "2026-07-26T04:00:10Z",
      error: "disk is full",
    });
    const result = evaluateAndMaybeAlertBackupHealth(
      stateFile,
      { ...POLICY, enabled: false },
      Date.parse("2026-07-26T04:05:00Z"),
    );
    expect(result.alerted).toBe(false);
    expect(result.health.status).toBe("failed"); // still reports health, just doesn't alert
  });

  it("does not alert (or write a state file) when no backup has ever run", () => {
    const result = evaluateAndMaybeAlertBackupHealth(stateFile, POLICY, Date.now());
    expect(result.alerted).toBe(false);
    expect(result.health.status).toBe("unknown");
    expect(existsSync(stateFile)).toBe(false);
  });

  it("alerts on staleness alone when the last success is older than staleAfterHours, with no explicit failed run", () => {
    recordBackupOutcome(stateFile, {
      ok: true,
      timestamp: "2026-07-01T04:00:00Z",
      backupDir: "/backups/x",
      sqliteSize: 1,
      lancedbSize: 1,
      durationMs: 1,
      integrityOk: true,
      snapshotSkewMs: 0,
    });
    const result = evaluateAndMaybeAlertBackupHealth(stateFile, POLICY, Date.parse("2026-08-02T04:00:00Z"));
    expect(result.health.status).toBe("stale");
    expect(result.alerted).toBe(true);
  });
});
