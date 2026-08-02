/**
 * `maintenance validate-exit` now persists a structured per-cron-lane run outcome locally
 * (issue #2231), independent of whether GlitchTip telemetry (errorReporting.consent) is enabled —
 * this is local audit-journal bookkeeping, not external reporting.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFactsMigrations } from "../backends/migrations/facts-migrations.js";
import {
  registerValidateCronExit,
  type ValidateCronExitContext,
} from "../cli/commands/manage/register-validate-cron-exit.js";
import { getLastSuccessfulCronRun } from "../services/maintenance-audit-journal.js";

function openTestDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-journal-"));
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

// Minimal, permissive context — reporting is deliberately disabled in most of these tests so the
// local-persistence behavior can be verified independently of errorReporting consent.
function disabledReportingCfg(): ValidateCronExitContext["cfg"] {
  return {
    errorReporting: { enabled: false, consent: false } as ValidateCronExitContext["cfg"]["errorReporting"],
    maintenance: {
      failureReporting: { enabled: true },
    } as ValidateCronExitContext["cfg"]["maintenance"],
  };
}

describe("validate-cron-exit persists structured cron-lane run outcomes (#2231)", () => {
  const origArgv = process.argv.slice();
  let db: DatabaseSync | undefined;

  afterEach(() => {
    process.argv = origArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    try {
      db?.close();
    } catch {
      // already closed by a previous test in this suite — nothing to clean up.
    }
    db = undefined;
  });

  function stubOpenclawArgv() {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
  }

  it("records a successful run even when telemetry reporting is disabled", async () => {
    stubOpenclawArgv();
    const testDb = openTestDb();
    db = testDb;
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "maintenance-nightly-20260729T020000Z-1.exit.txt");
    const logPath = join(dir, "maintenance-nightly-20260729T020000Z-1.log");
    writeFileSync(exitPath, "2026-07-29T02:00:00Z prune exit=0\n");
    writeFileSync(logPath, "all good\n");

    const mem = new Command("hybrid-mem");
    registerValidateCronExit(mem, {
      cfg: disabledReportingCfg(),
      versionInfo: { pluginVersion: "1.0.0-test" },
      journalDb: testDb,
    });

    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      ["validate-cron-exit", "--exit-path", exitPath, "--log-path", logPath, "--required-steps", "prune", "--json"],
      { from: "user" },
    );

    await vi.waitFor(() => {
      const row = getLastSuccessfulCronRun(testDb, "maintenance-nightly");
      expect(row).not.toBeNull();
    });
  });

  it("records a failed run with the first failing step's phase/errorClass, not a successful one", async () => {
    stubOpenclawArgv();
    const testDb = openTestDb();
    db = testDb;
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "nightly-doctor-repair-20260729T031500Z-1.exit.txt");
    const logPath = join(dir, "nightly-doctor-repair-20260729T031500Z-1.log");
    writeFileSync(exitPath, "2026-07-29T03:15:00Z doctor-fix-reconcile exit=1\n");
    writeFileSync(logPath, "doctor-fix-reconcile failed\n");

    const mem = new Command("hybrid-mem");
    registerValidateCronExit(mem, {
      cfg: disabledReportingCfg(),
      versionInfo: { pluginVersion: "1.0.0-test" },
      journalDb: testDb,
    });

    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      [
        "validate-cron-exit",
        "--exit-path",
        exitPath,
        "--log-path",
        logPath,
        "--required-steps",
        "doctor-fix-reconcile",
        "--json",
      ],
      { from: "user" },
    );

    await vi.waitFor(() => {
      const rows = testDb
        .prepare("SELECT job, status, error_summary, metadata_json FROM maintenance_runs WHERE job = ?")
        .all("nightly-doctor-repair") as Array<{ job: string; status: string; metadata_json: string | null }>;
      expect(rows.length).toBeGreaterThan(0);
    });

    expect(getLastSuccessfulCronRun(testDb, "nightly-doctor-repair")).toBeNull();
    const rows = testDb
      .prepare("SELECT job, status, error_summary, metadata_json FROM maintenance_runs WHERE job = ?")
      .all("nightly-doctor-repair") as Array<{ job: string; status: string; metadata_json: string | null }>;
    expect(rows[0]?.status).toBe("failed");
    const metadata = JSON.parse(rows[0]?.metadata_json ?? "{}");
    expect(metadata.phase).toBe("doctor-fix-reconcile");
  });

  it("does not attempt local persistence when no journalDb is provided (backward compatible)", async () => {
    stubOpenclawArgv();
    const dir = mkdtempSync(join(tmpdir(), "hm-val-cron-"));
    const exitPath = join(dir, "success.exit");
    const logPath = join(dir, "success.log");
    writeFileSync(exitPath, "2026-07-29T02:00:00Z prune exit=0\n");
    writeFileSync(logPath, "all good\n");

    const mem = new Command("hybrid-mem");
    registerValidateCronExit(mem, {
      cfg: disabledReportingCfg(),
      versionInfo: { pluginVersion: "1.0.0-test" },
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(
      ["validate-cron-exit", "--exit-path", exitPath, "--log-path", logPath, "--required-steps", "prune", "--json"],
      { from: "user" },
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
  });
});
