/**
 * Structured per-cron-lane run outcome persistence (issue #2231).
 *
 * Every hybrid-mem cron job funnels through `maintenance validate-exit` at shell exit (see
 * cron-job-bash-harness.ts's `hm_validate` trap), so recordMaintenanceCronRunOutcome() gives
 * `maintenance status` a durable, local record of "last scheduled run" / "last successful run"
 * per cron lane — independent of whether GlitchTip telemetry is enabled/reachable.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFactsMigrations } from "../backends/migrations/facts-migrations.js";
import * as cronGuard from "../services/cron-guard.js";
import {
  getLastSuccessfulCronRun,
  mapMaintenanceCronStatusToRunStatus,
  recordMaintenanceCronRunOutcome,
  resolveMaintenanceCronRetryStatus,
} from "../services/maintenance-audit-journal.js";

function openTestDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "hm-audit-journal-"));
  const db = new DatabaseSync(join(dir, "facts.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      importance REAL NOT NULL DEFAULT 0.5,
      entity TEXT,
      key TEXT,
      value TEXT,
      source TEXT NOT NULL DEFAULT 'conversation',
      created_at INTEGER NOT NULL
    )
  `);
  runFactsMigrations(db);
  return db;
}

describe("mapMaintenanceCronStatusToRunStatus", () => {
  it("mirrors the bash harness's own ledger_status mapping", () => {
    // success -> ok, skipped -> skipped, partial -> failed, failed -> failed
    // (cron-job-bash-harness.ts's hm_validate `case "$maintenance_status"`).
    expect(mapMaintenanceCronStatusToRunStatus("success")).toBe("ran");
    expect(mapMaintenanceCronStatusToRunStatus("skipped")).toBe("skipped:quiet");
    expect(mapMaintenanceCronStatusToRunStatus("partial")).toBe("failed");
    expect(mapMaintenanceCronStatusToRunStatus("failed")).toBe("failed");
  });
});

describe("resolveMaintenanceCronRetryStatus", () => {
  let openclawDir: string;

  beforeEach(() => {
    openclawDir = mkdtempSync(join(tmpdir(), "hm-audit-journal-retry-"));
  });

  it("is not_applicable for a successful or skipped run", () => {
    expect(resolveMaintenanceCronRetryStatus("success", [], openclawDir)).toBe("not_applicable");
    expect(resolveMaintenanceCronRetryStatus("skipped", [], openclawDir)).toBe("not_applicable");
  });

  it("is scheduled_retry for a failed run with no pending retry-once marker", () => {
    expect(resolveMaintenanceCronRetryStatus("failed", ["distill"], openclawDir)).toBe("scheduled_retry");
    expect(resolveMaintenanceCronRetryStatus("partial", ["distill"], openclawDir)).toBe("scheduled_retry");
  });

  it("is retry_pending when a failing step has a #2094 forced retry-once marker pending", () => {
    cronGuard.markStepRetryOnce("distill", openclawDir);
    expect(resolveMaintenanceCronRetryStatus("failed", ["distill"], openclawDir)).toBe("retry_pending");
  });

  it("does not treat an unrelated step's retry-once marker as covering the failing step", () => {
    cronGuard.markStepRetryOnce("prune", openclawDir);
    expect(resolveMaintenanceCronRetryStatus("failed", ["distill"], openclawDir)).toBe("scheduled_retry");
  });
});

describe("recordMaintenanceCronRunOutcome / getLastSuccessfulCronRun", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by the test itself (e.g. the DB-error-swallowing test below).
    }
  });

  it("is a no-op when db is undefined (never throws)", () => {
    expect(() =>
      recordMaintenanceCronRunOutcome(undefined, { jobName: "maintenance-nightly", maintenanceStatus: "success" }),
    ).not.toThrow();
  });

  it("persists a successful run and it is returned by getLastSuccessfulCronRun", () => {
    recordMaintenanceCronRunOutcome(db, { jobName: "maintenance-nightly", maintenanceStatus: "success" });

    const row = getLastSuccessfulCronRun(db, "maintenance-nightly");
    expect(row).not.toBeNull();
    expect(row?.job).toBe("maintenance-nightly");
    expect(row?.status).toBe("ran");
  });

  it("does not surface a failed run as successful", () => {
    recordMaintenanceCronRunOutcome(db, {
      jobName: "nightly-doctor-repair",
      maintenanceStatus: "failed",
      primaryFailure: {
        stepName: "doctor-fix-reconcile",
        failureClass: "nonzero_exit",
        message: "nightly-doctor-repair:doctor-fix-reconcile exited non-zero",
      },
      failingStepNames: ["doctor-fix-reconcile"],
    });

    expect(getLastSuccessfulCronRun(db, "nightly-doctor-repair")).toBeNull();
  });

  it("stores phase/errorClass/retryStatus in metadata without leaking raw log/prompt content", () => {
    recordMaintenanceCronRunOutcome(db, {
      jobName: "maintenance-nightly",
      maintenanceStatus: "failed",
      primaryFailure: {
        stepName: "distill",
        failureClass: "nonzero_exit",
        message: "maintenance-nightly:distill exited non-zero",
      },
      failingStepNames: ["distill"],
    });

    const rows = db
      .prepare("SELECT job, status, error_summary, metadata_json FROM maintenance_runs WHERE job = ?")
      .all("maintenance-nightly") as Array<{
      job: string;
      status: string;
      error_summary: string | null;
      metadata_json: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error_summary).toBe("maintenance-nightly:distill exited non-zero");
    const metadata = JSON.parse(rows[0]?.metadata_json ?? "{}");
    expect(metadata.phase).toBe("distill");
    expect(metadata.errorClass).toBe("nonzero_exit");
    expect(metadata.retryStatus).toBe("scheduled_retry");
    expect(metadata.maintenanceStatus).toBe("failed");
  });

  it("distinguishes independent job lanes by job name", () => {
    recordMaintenanceCronRunOutcome(db, { jobName: "maintenance-nightly", maintenanceStatus: "success" });
    recordMaintenanceCronRunOutcome(db, {
      jobName: "nightly-doctor-repair",
      maintenanceStatus: "failed",
      primaryFailure: { stepName: "doctor-fix-reconcile", failureClass: "nonzero_exit", message: "failed" },
      failingStepNames: ["doctor-fix-reconcile"],
    });

    expect(getLastSuccessfulCronRun(db, "maintenance-nightly")).not.toBeNull();
    expect(getLastSuccessfulCronRun(db, "nightly-doctor-repair")).toBeNull();
  });

  it("swallows a DB error instead of throwing (never fails the cron job)", () => {
    db.close();
    expect(() =>
      recordMaintenanceCronRunOutcome(db, { jobName: "maintenance-nightly", maintenanceStatus: "success" }),
    ).not.toThrow();
  });
});
