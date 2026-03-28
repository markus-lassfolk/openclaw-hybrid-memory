/**
 * Tests for issue #305 — Cron jobs lose lastRun state on gateway restart.
 *
 * Verifies that:
 *   1. syncCronLastRunFromGuards reads persistent guard files and updates
 *      state.lastRunAtMs in jobs.json for jobs with no or stale lastRunAtMs.
 *   2. Legacy /tmp/hybrid-mem-guard-*.txt files (epoch-seconds) are also
 *      handled correctly.
 *   3. buildGuardPrefix produces a guard message using the persistent
 *      ~/.openclaw/cron/guard/ path (not /tmp/).
 *   4. getGuardFilePath returns the expected persistent path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Functions under test
import {
  buildGuardPrefix,
  getGuardFilePath,
  readGuardTimestampMs,
  syncCronLastRunFromGuards,
  GUARD_SUBDIR,
} from "../services/cron-guard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpenclawDir(): string {
  const dir = join(tmpdir(), `oc-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCronStore(openclawDir: string, jobs: unknown[]): void {
  const cronDir = join(openclawDir, "cron");
  mkdirSync(cronDir, { recursive: true });
  writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({ jobs }, null, 2), "utf-8");
}

function readCronStore(openclawDir: string): { jobs: unknown[] } {
  const raw = readFileSync(join(openclawDir, "cron", "jobs.json"), "utf-8");
  return JSON.parse(raw) as { jobs: unknown[] };
}

function writeGuardFile(openclawDir: string, jobName: string, timestampMs: number): void {
  const guardDir = join(openclawDir, GUARD_SUBDIR);
  mkdirSync(guardDir, { recursive: true });
  writeFileSync(join(guardDir, `${jobName}.ms`), String(timestampMs), "utf-8");
}

const noop = { info: () => {}, warn: () => {} };

// ---------------------------------------------------------------------------
// buildGuardPrefix
// ---------------------------------------------------------------------------

describe("buildGuardPrefix", () => {
  it("uses persistent ~/.openclaw/cron/guard/ path (not /tmp/)", () => {
    const prefix = buildGuardPrefix("nightly-memory-sweep", 72_000_000);
    expect(prefix).toContain("cron/guard");
    expect(prefix).not.toContain("/tmp/");
  });

  it("references issue #305", () => {
    const prefix = buildGuardPrefix("weekly-reflection", 432_000_000);
    expect(prefix).toContain("#305");
  });

  it("includes the job name and guard window in the prefix", () => {
    const prefix = buildGuardPrefix("self-correction-analysis", 72_000_000);
    expect(prefix).toContain("self-correction-analysis");
    expect(prefix).toContain("72000000");
    expect(prefix).toContain("20h");
  });

  it("ends with double newline (separates guard from job content)", () => {
    const prefix = buildGuardPrefix("monthly-consolidation", 2_160_000_000);
    expect(prefix.endsWith("\n\n")).toBe(true);
  });

  it("includes instructions for writing guard file after completion", () => {
    const prefix = buildGuardPrefix("nightly-dream-cycle", 72_000_000);
    expect(prefix.toLowerCase()).toMatch(/write|mkdir/);
  });
});

// ---------------------------------------------------------------------------
// getGuardFilePath
// ---------------------------------------------------------------------------

describe("getGuardFilePath", () => {
  it("returns a path ending in {jobName}.ms", () => {
    const p = getGuardFilePath("nightly-memory-sweep", "/home/user/.openclaw");
    expect(p).toMatch(/nightly-memory-sweep\.ms$/);
  });

  it("includes the guard subdirectory", () => {
    const p = getGuardFilePath("weekly-reflection", "/home/user/.openclaw");
    expect(p).toContain("cron");
    expect(p).toContain("guard");
  });

  it("is under the provided openclawDir", () => {
    const p = getGuardFilePath("monthly-consolidation", "/custom/dir");
    expect(p.startsWith("/custom/dir")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readGuardTimestampMs
// ---------------------------------------------------------------------------

describe("readGuardTimestampMs", () => {
  let openclawDir: string;

  beforeEach(() => {
    openclawDir = makeOpenclawDir();
  });

  afterEach(() => {
    rmSync(openclawDir, { recursive: true, force: true });
  });

  it("returns null when guard file does not exist", () => {
    expect(readGuardTimestampMs("missing-job", openclawDir)).toBeNull();
  });

  it("reads epoch-ms timestamp", () => {
    const ts = Date.now();
    writeGuardFile(openclawDir, "nightly-memory-sweep", ts);
    expect(readGuardTimestampMs("nightly-memory-sweep", openclawDir)).toBe(ts);
  });

  it("converts epoch-seconds (< 2e12) to epoch-ms", () => {
    // Simulate legacy `date +%s` output
    const secs = Math.floor(Date.now() / 1000);
    const guardDir = join(openclawDir, GUARD_SUBDIR);
    mkdirSync(guardDir, { recursive: true });
    writeFileSync(join(guardDir, "legacy-job.ms"), String(secs), "utf-8");
    const result = readGuardTimestampMs("legacy-job", openclawDir);
    expect(result).toBe(secs * 1000);
  });

  it("returns null for invalid file content", () => {
    const guardDir = join(openclawDir, GUARD_SUBDIR);
    mkdirSync(guardDir, { recursive: true });
    writeFileSync(join(guardDir, "bad-job.ms"), "not-a-number", "utf-8");
    expect(readGuardTimestampMs("bad-job", openclawDir)).toBeNull();
  });

  it("returns null for zero value", () => {
    const guardDir = join(openclawDir, GUARD_SUBDIR);
    mkdirSync(guardDir, { recursive: true });
    writeFileSync(join(guardDir, "zero-job.ms"), "0", "utf-8");
    expect(readGuardTimestampMs("zero-job", openclawDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syncCronLastRunFromGuards
// ---------------------------------------------------------------------------

describe("syncCronLastRunFromGuards", () => {
  let openclawDir: string;

  beforeEach(() => {
    openclawDir = makeOpenclawDir();
  });

  afterEach(() => {
    rmSync(openclawDir, { recursive: true, force: true });
  });

  it("does nothing when jobs.json does not exist", () => {
    // Should not throw
    expect(() => syncCronLastRunFromGuards(noop, openclawDir)).not.toThrow();
  });

  it("does nothing when guard directory is empty and no matching /tmp/ file", () => {
    // Use a UUID-suffixed name to avoid matching any real /tmp/hybrid-mem-guard-*.txt files
    const uniqueName = `test-job-no-guard-${randomUUID()}`;
    writeCronStore(openclawDir, [{ name: uniqueName, enabled: true }]);
    syncCronLastRunFromGuards(noop, openclawDir);
    const store = readCronStore(openclawDir);
    const job = (store.jobs as Array<Record<string, unknown>>)[0];
    expect(job.state).toBeUndefined();
  });

  it("back-fills lastRunAtMs when job has no state", () => {
    const ts = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    writeCronStore(openclawDir, [{ name: "nightly-memory-sweep", enabled: true }]);
    writeGuardFile(openclawDir, "nightly-memory-sweep", ts);

    syncCronLastRunFromGuards(noop, openclawDir);

    const store = readCronStore(openclawDir);
    const job = (store.jobs as Array<Record<string, unknown>>)[0];
    const state = job.state as Record<string, unknown>;
    expect(state.lastRunAtMs).toBe(ts);
  });

  it("updates lastRunAtMs when guard timestamp is newer", () => {
    const oldTs = Date.now() - 24 * 60 * 60 * 1000; // 24h ago
    const newTs = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    writeCronStore(openclawDir, [{ name: "weekly-reflection", enabled: true, state: { lastRunAtMs: oldTs } }]);
    writeGuardFile(openclawDir, "weekly-reflection", newTs);

    syncCronLastRunFromGuards(noop, openclawDir);

    const store = readCronStore(openclawDir);
    const job = (store.jobs as Array<Record<string, unknown>>)[0];
    const state = job.state as Record<string, unknown>;
    expect(state.lastRunAtMs).toBe(newTs);
  });

  it("does NOT downgrade lastRunAtMs when guard timestamp is older", () => {
    const recentTs = Date.now() - 1 * 60 * 60 * 1000; // 1h ago
    const olderTs = Date.now() - 12 * 60 * 60 * 1000; // 12h ago
    writeCronStore(openclawDir, [{ name: "monthly-consolidation", enabled: true, state: { lastRunAtMs: recentTs } }]);
    writeGuardFile(openclawDir, "monthly-consolidation", olderTs);

    syncCronLastRunFromGuards(noop, openclawDir);

    const store = readCronStore(openclawDir);
    const job = (store.jobs as Array<Record<string, unknown>>)[0];
    const state = job.state as Record<string, unknown>;
    expect(state.lastRunAtMs).toBe(recentTs);
  });

  it("preserves other state fields when updating lastRunAtMs", () => {
    const ts = Date.now() - 3 * 60 * 60 * 1000;
    writeCronStore(openclawDir, [
      {
        name: "self-correction-analysis",
        enabled: true,
        state: { nextRunAtMs: Date.now() + 1_000_000, lastStatus: "ok", consecutiveErrors: 0 },
      },
    ]);
    writeGuardFile(openclawDir, "self-correction-analysis", ts);

    syncCronLastRunFromGuards(noop, openclawDir);

    const store = readCronStore(openclawDir);
    const job = (store.jobs as Array<Record<string, unknown>>)[0];
    const state = job.state as Record<string, unknown>;
    expect(state.lastRunAtMs).toBe(ts);
    expect(state.lastStatus).toBe("ok");
    expect(state.consecutiveErrors).toBe(0);
    expect(typeof state.nextRunAtMs).toBe("number");
  });

  it("handles multiple jobs independently", () => {
    const ts1 = Date.now() - 2 * 60 * 60 * 1000;
    const ts2 = Date.now() - 5 * 60 * 60 * 1000;
    const recentTs = Date.now() - 1000;
    writeCronStore(openclawDir, [
      { name: "nightly-memory-sweep", enabled: true },
      { name: "weekly-reflection", enabled: true },
      { name: "monthly-consolidation", enabled: true, state: { lastRunAtMs: recentTs } },
    ]);
    writeGuardFile(openclawDir, "nightly-memory-sweep", ts1);
    writeGuardFile(openclawDir, "weekly-reflection", ts2);
    // monthly-consolidation has no guard file — should not be changed

    syncCronLastRunFromGuards(noop, openclawDir);

    const store = readCronStore(openclawDir);
    const jobs = store.jobs as Array<Record<string, unknown>>;
    expect((jobs[0].state as Record<string, unknown>).lastRunAtMs).toBe(ts1);
    expect((jobs[1].state as Record<string, unknown>).lastRunAtMs).toBe(ts2);
    // monthly-consolidation: lastRunAtMs unchanged
    const monthlyState = jobs[2].state as Record<string, unknown>;
    expect(monthlyState.lastRunAtMs).toBe(recentTs);
  });

  it("normalizes job name with spaces (spaces → hyphens) for guard file lookup", () => {
    const ts = Date.now() - 1 * 60 * 60 * 1000;
    writeCronStore(openclawDir, [{ name: "nightly memory sweep", enabled: true }]);
    // Guard file uses hyphens
    writeGuardFile(openclawDir, "nightly-memory-sweep", ts);

    syncCronLastRunFromGuards(noop, openclawDir);

    const store = readCronStore(openclawDir);
    const job = (store.jobs as Array<Record<string, unknown>>)[0];
    const state = job.state as Record<string, unknown>;
    expect(state.lastRunAtMs).toBe(ts);
  });

  it("converts epoch-seconds guard file to epoch-ms when syncing", () => {
    const secs = Math.floor(Date.now() / 1000) - 3600; // 1h ago in seconds
    const expectedMs = secs * 1000;
    writeCronStore(openclawDir, [{ name: "nightly-dream-cycle", enabled: true }]);
    // Write seconds (legacy format)
    const guardDir = join(openclawDir, GUARD_SUBDIR);
    mkdirSync(guardDir, { recursive: true });
    writeFileSync(join(guardDir, "nightly-dream-cycle.ms"), String(secs), "utf-8");

    syncCronLastRunFromGuards(noop, openclawDir);

    const store = readCronStore(openclawDir);
    const job = (store.jobs as Array<Record<string, unknown>>)[0];
    const state = job.state as Record<string, unknown>;
    expect(state.lastRunAtMs).toBe(expectedMs);
  });

  it("logs info when jobs are updated", () => {
    const ts = Date.now() - 60_000;
    writeCronStore(openclawDir, [{ name: "weekly-deep-maintenance", enabled: true }]);
    writeGuardFile(openclawDir, "weekly-deep-maintenance", ts);

    const messages: string[] = [];
    syncCronLastRunFromGuards({ info: (m) => messages.push(m), warn: noop.warn }, openclawDir);

    expect(messages.some((m) => m.includes("synced") && m.includes("1"))).toBe(true);
  });

  it("does not write jobs.json when nothing changes", () => {
    const recentTs = Date.now() - 1000;
    writeCronStore(openclawDir, [{ name: "nightly-memory-sweep", enabled: true, state: { lastRunAtMs: recentTs } }]);
    writeGuardFile(openclawDir, "nightly-memory-sweep", recentTs - 100); // older → no update

    const before = readFileSync(join(openclawDir, "cron", "jobs.json"), "utf-8");
    syncCronLastRunFromGuards(noop, openclawDir);
    const after = readFileSync(join(openclawDir, "cron", "jobs.json"), "utf-8");

    expect(after).toBe(before);
  });

  it("skips jobs.json when file is malformed", () => {
    const cronDir = join(openclawDir, "cron");
    mkdirSync(cronDir, { recursive: true });
    writeFileSync(join(cronDir, "jobs.json"), "{ invalid json", "utf-8");
    writeGuardFile(openclawDir, "nightly-memory-sweep", Date.now());
    // Should not throw
    expect(() => syncCronLastRunFromGuards(noop, openclawDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Guard-prefix migration (ensureMaintenanceCronJobs normalizeExisting)
// Tested indirectly: the new buildGuardPrefix must not contain /tmp/
// ---------------------------------------------------------------------------

describe("guard prefix format — persistent path", () => {
  it("buildGuardPrefix output does not mention /tmp/", () => {
    const jobs = [
      "nightly-memory-sweep",
      "self-correction-analysis",
      "weekly-reflection",
      "weekly-extract-procedures",
      "weekly-deep-maintenance",
      "weekly-persona-proposals",
      "monthly-consolidation",
      "nightly-dream-cycle",
    ];
    for (const name of jobs) {
      const prefix = buildGuardPrefix(name, 72_000_000);
      expect(prefix, `${name} guard prefix should not use /tmp/`).not.toContain("/tmp/");
      expect(prefix, `${name} guard prefix should use cron/guard/`).toContain("cron/guard");
    }
  });
});
