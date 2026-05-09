/**
 * Tests for cron maintenance reconciler.
 *
 * Verifies that false-OK cron run ledger entries (status:"ok" despite failed maintenance)
 * are correctly identified and repaired.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CronRunLedgerEntry,
  extractArtifactPathsFromSummary,
  findMaintenanceArtifacts,
  parseCronRunLedger,
  reconcileAllCronRunLedgers,
  reconcileCronRunLedger,
  writeCronRunLedger,
} from "../services/cron-maintenance-reconciler.js";

let tmpDir: string;
let cronRunsDir: string;
let logDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cron-reconcile-test-"));
  cronRunsDir = join(tmpDir, "runs");
  logDir = join(tmpDir, "logs");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseCronRunLedger", () => {
  it("should parse valid JSONL ledger", () => {
    const ledgerPath = join(tmpDir, "test.jsonl");
    const entries = [
      { ts: 1000, jobId: "test-job", action: "started" as const },
      { ts: 1100, jobId: "test-job", action: "finished" as const, status: "ok" as const },
    ];
    writeFileSync(ledgerPath, entries.map((e) => JSON.stringify(e)).join("\n"));

    const parsed = parseCronRunLedger(ledgerPath);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].ts).toBe(1000);
    expect(parsed[1].status).toBe("ok");
  });

  it("should return empty array for missing file", () => {
    const parsed = parseCronRunLedger("/nonexistent/path.jsonl");
    expect(parsed).toEqual([]);
  });

  it("should skip empty lines", () => {
    const ledgerPath = join(tmpDir, "test.jsonl");
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({ ts: 1000, jobId: "test", action: "started" })}\n\n${JSON.stringify({ ts: 1100, jobId: "test", action: "finished" })}\n`,
    );

    const parsed = parseCronRunLedger(ledgerPath);
    expect(parsed).toHaveLength(2);
  });

  it("should skip invalid JSON lines and keep valid ones", () => {
    const ledgerPath = join(tmpDir, "test.jsonl");
    const good = JSON.stringify({ ts: 1000, jobId: "test", action: "started" });
    writeFileSync(ledgerPath, `${good}\nnot-json{{{`);

    const parsed = parseCronRunLedger(ledgerPath);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].ts).toBe(1000);
  });
});

describe("writeCronRunLedger", () => {
  it("should write entries as JSONL", () => {
    const ledgerPath = join(tmpDir, "test.jsonl");
    const entries: CronRunLedgerEntry[] = [
      { ts: 1000, jobId: "test", action: "started" },
      { ts: 1100, jobId: "test", action: "finished", status: "ok" },
    ];

    writeCronRunLedger(ledgerPath, entries);

    const content = readFileSync(ledgerPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).ts).toBe(1000);
    expect(JSON.parse(lines[1]).status).toBe("ok");
  });
});

describe("extractArtifactPathsFromSummary", () => {
  it("should extract HM_EXIT and HM_LOG paths", () => {
    const summary =
      "FAILED\n\nHM_EXIT: /home/user/.openclaw/logs/cron-hybrid-mem/job-20260509T024520Z-14763.exit.txt\nHM_LOG: /home/user/.openclaw/logs/cron-hybrid-mem/job-20260509T024520Z-14763.log\n\nMissing steps: dream-cycle";

    const paths = extractArtifactPathsFromSummary(summary);
    expect(paths.exitPath).toContain("job-20260509T024520Z-14763.exit.txt");
    expect(paths.logPath).toContain("job-20260509T024520Z-14763.log");
  });

  it("should handle alternative path keywords", () => {
    const summary = "exitPath: /tmp/test.exit.txt\nlogPath: /tmp/test.log";
    const paths = extractArtifactPathsFromSummary(summary);
    expect(paths.exitPath).toBe("/tmp/test.exit.txt");
    expect(paths.logPath).toBe("/tmp/test.log");
  });

  it("should return undefined if paths not found", () => {
    const summary = "Some summary without paths";
    const paths = extractArtifactPathsFromSummary(summary);
    expect(paths.exitPath).toBeUndefined();
    expect(paths.logPath).toBeUndefined();
  });
});

describe("findMaintenanceArtifacts", () => {
  beforeEach(() => {
    // Create logDir
    rmSync(logDir, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
  });

  it("should find matching exit and log files", () => {
    writeFileSync(join(logDir, "test-job-20260509T024520Z-12345.exit.txt"), "");
    writeFileSync(join(logDir, "test-job-20260509T024520Z-12345.log"), "");

    const artifacts = findMaintenanceArtifacts(logDir);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].runId).toBe("20260509T024520Z-12345");
    expect(artifacts[0].exitPath).toContain("exit.txt");
    expect(artifacts[0].logPath).toContain(".log");
  });

  it("should filter by job slug", () => {
    writeFileSync(join(logDir, "job-a-20260509T024520Z-12345.exit.txt"), "");
    writeFileSync(join(logDir, "job-a-20260509T024520Z-12345.log"), "");
    writeFileSync(join(logDir, "job-b-20260509T024521Z-12346.exit.txt"), "");
    writeFileSync(join(logDir, "job-b-20260509T024521Z-12346.log"), "");

    const artifacts = findMaintenanceArtifacts(logDir, "job-a");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].exitPath).toContain("job-a");
  });

  it("should only include exits that have matching logs", () => {
    writeFileSync(join(logDir, "test-job-20260509T024520Z-12345.exit.txt"), "");
    // No matching .log file

    const artifacts = findMaintenanceArtifacts(logDir);
    expect(artifacts).toHaveLength(0);
  });

  it("should return empty array for missing directory", () => {
    const artifacts = findMaintenanceArtifacts("/nonexistent/dir");
    expect(artifacts).toEqual([]);
  });
});

describe("reconcileCronRunLedger", () => {
  it("should identify and correct false-OK entry", () => {
    // Create ledger with false-OK entry
    const ledgerPath = join(cronRunsDir, "test-job.jsonl");
    rmSync(cronRunsDir, { recursive: true, force: true });
    mkdirSync(cronRunsDir, { recursive: true });
    writeFileSync(ledgerPath, "");

    const entries: CronRunLedgerEntry[] = [
      { ts: 1778296560189, jobId: "test-job", action: "started" },
      {
        ts: 1778296560189,
        jobId: "test-job",
        action: "finished",
        status: "ok",
        summary: `FAILED\n\nHM_EXIT: ${join(logDir, "test-job-20260509T024520Z-14763.exit.txt")}\nHM_LOG: ${join(logDir, "test-job-20260509T024520Z-14763.log")}\n\nMissing steps: dream-cycle`,
      },
    ];
    writeCronRunLedger(ledgerPath, entries);

    // Create artifacts showing failed validation
    rmSync(logDir, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "test-job-20260509T024520Z-14763.exit.txt"), ""); // Empty = failed
    writeFileSync(join(logDir, "test-job-20260509T024520Z-14763.log"), "Error: timeout");

    const result = reconcileCronRunLedger(ledgerPath, logDir, ["dream-cycle"], false);

    expect(result.examined).toBe(1);
    expect(result.falseOk).toBe(1);
    expect(result.corrected).toBe(1);
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0].originalStatus).toBe("ok");
    expect(result.corrections[0].newStatus).toBe("error");

    // Verify ledger was updated
    const updated = parseCronRunLedger(ledgerPath);
    const finishedEntry = updated.find((e) => e.action === "finished");
    expect(finishedEntry?.status).toBe("error");
    expect(finishedEntry?.summary).toContain("[RECONCILED]");
  });

  it("should not modify entries that are genuinely OK", () => {
    const ledgerPath = join(cronRunsDir, "test-job.jsonl");
    rmSync(cronRunsDir, { recursive: true, force: true });
    mkdirSync(cronRunsDir, { recursive: true });
    writeFileSync(ledgerPath, "");

    const entries: CronRunLedgerEntry[] = [
      {
        ts: 1778296560189,
        jobId: "test-job",
        action: "finished",
        status: "ok",
        summary: `SUCCESS\n\nHM_EXIT: ${join(logDir, "test-job-20260509T024520Z-14763.exit.txt")}`,
      },
    ];
    writeCronRunLedger(ledgerPath, entries);

    // Create artifacts showing successful validation
    rmSync(logDir, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, "test-job-20260509T024520Z-14763.exit.txt"),
      "2026-05-09T02:45:20Z prune exit=0\n2026-05-09T02:45:21Z distill exit=0\n",
    );
    writeFileSync(join(logDir, "test-job-20260509T024520Z-14763.log"), "All OK");

    const result = reconcileCronRunLedger(ledgerPath, logDir, ["prune", "distill"], false);

    expect(result.examined).toBe(1);
    expect(result.falseOk).toBe(0);
    expect(result.corrected).toBe(0);

    // Verify ledger was not modified
    const updated = parseCronRunLedger(ledgerPath);
    const finishedEntry = updated.find((e) => e.action === "finished");
    expect(finishedEntry?.status).toBe("ok");
    expect(finishedEntry?.summary).not.toContain("[RECONCILED]");
  });

  it("should skip entries that are already error status", () => {
    const ledgerPath = join(cronRunsDir, "test-job.jsonl");
    rmSync(cronRunsDir, { recursive: true, force: true });
    mkdirSync(cronRunsDir, { recursive: true });
    writeFileSync(ledgerPath, "");

    const entries: CronRunLedgerEntry[] = [
      {
        ts: 1778296560189,
        jobId: "test-job",
        action: "finished",
        status: "error",
        summary: "Already marked as error",
      },
    ];
    writeCronRunLedger(ledgerPath, entries);

    const result = reconcileCronRunLedger(ledgerPath, logDir, ["prune"], false);

    expect(result.examined).toBe(0);
    expect(result.falseOk).toBe(0);
  });

  it("should match artifacts by run id when finish time is long after run start", () => {
    const ledgerPath = join(cronRunsDir, "hybrid-mem:nightly-dream-cycle.jsonl");
    rmSync(cronRunsDir, { recursive: true, force: true });
    mkdirSync(cronRunsDir, { recursive: true });
    rmSync(logDir, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });

    const runPrefix = "20260509T024520Z";
    const runTs = Date.UTC(2026, 4, 9, 2, 45, 20);
    const finishTs = runTs + 45 * 60 * 1000;

    writeCronRunLedger(ledgerPath, [
      {
        ts: finishTs,
        jobId: "hybrid-mem:nightly-dream-cycle",
        action: "finished",
        status: "ok",
        summary: "No HM paths in summary",
      },
    ]);

    const slug = "nightly-dream-cycle";
    writeFileSync(join(logDir, `${slug}-${runPrefix}-999.exit.txt`), "");
    writeFileSync(join(logDir, `${slug}-${runPrefix}-999.log`), "timeout");

    const result = reconcileCronRunLedger(ledgerPath, logDir, ["dream-cycle"], false);

    expect(result.examined).toBe(1);
    expect(result.falseOk).toBe(1);
    expect(result.corrected).toBe(1);
  });

  it("should respect dry-run mode", () => {
    const ledgerPath = join(cronRunsDir, "test-job.jsonl");
    rmSync(cronRunsDir, { recursive: true, force: true });
    mkdirSync(cronRunsDir, { recursive: true });
    writeFileSync(ledgerPath, "");

    const entries: CronRunLedgerEntry[] = [
      {
        ts: 1778296560189,
        jobId: "test-job",
        action: "finished",
        status: "ok",
        summary: `HM_EXIT: ${join(logDir, "test-job-20260509T024520Z-14763.exit.txt")}\nHM_LOG: ${join(logDir, "test-job-20260509T024520Z-14763.log")}`,
      },
    ];
    writeCronRunLedger(ledgerPath, entries);

    // Create failed artifacts
    rmSync(logDir, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "test-job-20260509T024520Z-14763.exit.txt"), "");
    writeFileSync(join(logDir, "test-job-20260509T024520Z-14763.log"), "");

    const result = reconcileCronRunLedger(ledgerPath, logDir, ["prune"], true); // dry-run=true

    expect(result.falseOk).toBe(1);
    expect(result.corrected).toBe(0); // Not corrected in dry-run

    // Verify ledger was NOT modified
    const updated = parseCronRunLedger(ledgerPath);
    const finishedEntry = updated.find((e) => e.action === "finished");
    expect(finishedEntry?.status).toBe("ok"); // Still "ok"
  });
});

describe("reconcileAllCronRunLedgers", () => {
  it("should reconcile multiple job ledgers", () => {
    rmSync(cronRunsDir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
    mkdirSync(cronRunsDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    // Create ledgers for two jobs
    const ledger1Path = join(cronRunsDir, "hybrid-mem:job-a.jsonl");
    const ledger2Path = join(cronRunsDir, "hybrid-mem:job-b.jsonl");
    writeFileSync(ledger1Path, "");
    writeFileSync(ledger2Path, "");

    writeCronRunLedger(ledger1Path, [
      {
        ts: 1000,
        jobId: "hybrid-mem:job-a",
        action: "finished",
        status: "ok",
        summary: `HM_EXIT: ${join(logDir, "job-a-20260509T024520Z-1.exit.txt")}\nHM_LOG: ${join(logDir, "job-a-20260509T024520Z-1.log")}`,
      },
    ]);

    writeCronRunLedger(ledger2Path, [
      {
        ts: 2000,
        jobId: "hybrid-mem:job-b",
        action: "finished",
        status: "ok",
        summary: `HM_EXIT: ${join(logDir, "job-b-20260509T024521Z-2.exit.txt")}\nHM_LOG: ${join(logDir, "job-b-20260509T024521Z-2.log")}`,
      },
    ]);

    // Create failed artifacts
    writeFileSync(join(logDir, "job-a-20260509T024520Z-1.exit.txt"), "");
    writeFileSync(join(logDir, "job-a-20260509T024520Z-1.log"), "");
    writeFileSync(join(logDir, "job-b-20260509T024521Z-2.exit.txt"), "");
    writeFileSync(join(logDir, "job-b-20260509T024521Z-2.log"), "");

    const result = reconcileAllCronRunLedgers(
      cronRunsDir,
      logDir,
      {
        "hybrid-mem:job-a": ["prune"],
        "hybrid-mem:job-b": ["distill"],
      },
      false,
    );

    expect(result.examined).toBe(2);
    expect(result.falseOk).toBe(2);
    expect(result.corrected).toBe(2);
    expect(result.corrections).toHaveLength(2);
  });

  it("should skip jobs without required steps mapping", () => {
    rmSync(cronRunsDir, { recursive: true, force: true });
    mkdirSync(cronRunsDir, { recursive: true });

    const ledgerPath = join(cronRunsDir, "unknown-job.jsonl");
    writeFileSync(ledgerPath, "");
    writeCronRunLedger(ledgerPath, [
      {
        ts: 1000,
        jobId: "unknown-job",
        action: "finished",
        status: "ok",
      },
    ]);

    const result = reconcileAllCronRunLedgers(cronRunsDir, logDir, {}, false);

    expect(result.examined).toBe(0);
  });
});
