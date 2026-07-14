import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEnv } from "../utils/env-manager.js";

type ErrorReporterModule = typeof import("../services/error-reporter.js");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function readQueueRecords(
  queuePath: string,
): Array<{ id: string; event: Record<string, unknown>; enqueuedAt: number }> {
  if (!existsSync(queuePath)) return [];
  const content = readFileSync(queuePath, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => JSON.parse(line) as { id: string; event: Record<string, unknown>; enqueuedAt: number });
}

describe("error reporter persistent pending queue", () => {
  let tempDir: string;
  let queuePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "error-reporter-pending-"));
    queuePath = join(tempDir, ".error_reports.pending.jsonl");
    setEnv("ERROR_REPORTING_DSN", undefined);
    setEnv("OPENCLAW_NODE_NAME", undefined);
    fetchMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("persists unsent reports when delivery fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;

    await reporter.initErrorReporter(
      {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testkey@example.com/1",
        maxBreadcrumbs: 0,
        sampleRate: 1,
        pendingQueuePath: queuePath,
      },
      "test-build",
    );

    const eventId = reporter.capturePluginError(new Error("Persistent failure test"), {
      operation: "queue-persist",
      subsystem: "tests",
    });

    expect(eventId).toBeTruthy();
    await expect(reporter.flushErrorReporter(500)).resolves.toBe(false);

    const records = readQueueRecords(queuePath);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(eventId);
    expect((records[0].event.event_id as string) ?? "").toBe(eventId);
  });

  it("replays queued reports on next initialization", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    let reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;

    await reporter.initErrorReporter(
      {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testkey@example.com/1",
        maxBreadcrumbs: 0,
        sampleRate: 1,
        pendingQueuePath: queuePath,
      },
      "test-build",
    );

    reporter.capturePluginError(new Error("Replay me after restart"), {
      operation: "queue-replay",
      subsystem: "tests",
    });
    await expect(reporter.flushErrorReporter(500)).resolves.toBe(false);
    expect(readQueueRecords(queuePath)).toHaveLength(1);

    vi.resetModules();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });

    reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    await reporter.initErrorReporter(
      {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testkey@example.com/1",
        maxBreadcrumbs: 0,
        sampleRate: 1,
        pendingQueuePath: queuePath,
      },
      "test-build",
    );

    await expect(reporter.flushErrorReporter(1000)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(readQueueRecords(queuePath)).toHaveLength(0);
  });

  it("prunes oldest reports when pending queue exceeds cap", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;

    await reporter.initErrorReporter(
      {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testkey@example.com/1",
        maxBreadcrumbs: 0,
        sampleRate: 1,
        pendingQueuePath: queuePath,
        maxPendingReports: 2,
      },
      "test-build",
    );

    reporter.capturePluginError(new Error("pending-1"), { operation: "queue-prune-1", subsystem: "tests" });
    reporter.capturePluginError(new Error("pending-2"), { operation: "queue-prune-2", subsystem: "tests" });
    reporter.capturePluginError(new Error("pending-3"), { operation: "queue-prune-3", subsystem: "tests" });

    await expect(reporter.flushErrorReporter(1000)).resolves.toBe(false);
    const records = readQueueRecords(queuePath);
    expect(records).toHaveLength(2);
    const messages = records
      .map((record) => {
        const exception = (record.event.exception as { values?: Array<{ value?: string }> } | undefined)?.values?.[0];
        return exception?.value ?? "";
      })
      .sort();
    expect(messages).toEqual(["pending-2", "pending-3"]);
  });

  it("resolvePendingErrorReportCount reads on-disk queue when reporter is cold", async () => {
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    writeFileSync(
      queuePath,
      `${JSON.stringify({ id: "a", event: {}, enqueuedAt: 1 })}\n${JSON.stringify({ id: "b", event: {}, enqueuedAt: 2 })}\n`,
    );
    expect(reporter.countPendingErrorReportsOnDisk(queuePath)).toBe(2);
    expect(reporter.resolvePendingErrorReportCount(join(tempDir, "memory.db"))).toBe(2);
  });

  // Regression: #2113 — a permanently unreachable endpoint must not pin the same reports in the
  // queue forever. Reports older than the retention window are aged out on load so the queue
  // eventually empties even when delivery never succeeds.
  it("ages out stale pending reports older than the retention window on load", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    // Two records: one ancient (epoch ms 1, ~1970) and one enqueued now. Give them distinct
    // fingerprints so neither is dropped as a duplicate.
    const ancient = {
      id: "ancient",
      enqueuedAt: 1,
      event: { event_id: "ancient", exception: { values: [{ type: "Error", value: "old failure" }] } },
    };
    const fresh = {
      id: "fresh",
      enqueuedAt: Date.now(),
      event: { event_id: "fresh", exception: { values: [{ type: "Error", value: "recent failure" }] } },
    };
    writeFileSync(queuePath, `${JSON.stringify(ancient)}\n${JSON.stringify(fresh)}\n`);

    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    await reporter.initErrorReporter(
      {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testkey@example.com/1",
        maxBreadcrumbs: 0,
        sampleRate: 1,
        pendingQueuePath: queuePath,
      },
      "test-build",
    );

    // Only the fresh record should survive; the ancient one is aged out.
    const records = readQueueRecords(queuePath);
    expect(records.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("respects a custom maxPendingReportAgeMs when aging out reports", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const now = Date.now();
    const stale = {
      id: "stale",
      enqueuedAt: now - 10_000,
      event: { event_id: "stale", exception: { values: [{ type: "Error", value: "stale failure" }] } },
    };
    const recent = {
      id: "recent",
      enqueuedAt: now - 500,
      event: { event_id: "recent", exception: { values: [{ type: "Error", value: "recent failure" }] } },
    };
    writeFileSync(queuePath, `${JSON.stringify(stale)}\n${JSON.stringify(recent)}\n`);

    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    await reporter.initErrorReporter(
      {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testkey@example.com/1",
        maxBreadcrumbs: 0,
        sampleRate: 1,
        pendingQueuePath: queuePath,
        maxPendingReportAgeMs: 2_000,
      },
      "test-build",
    );

    const records = readQueueRecords(queuePath);
    expect(records.map((r) => r.id)).toEqual(["recent"]);
  });

  it("classifies a connectivity failure as a transient network failure kind", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    await reporter.initErrorReporter(
      {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testkey@example.com/1",
        maxBreadcrumbs: 0,
        sampleRate: 1,
        pendingQueuePath: queuePath,
      },
      "test-build",
    );

    reporter.capturePluginError(new Error("connectivity classify test"), {
      operation: "classify",
      subsystem: "tests",
    });
    await expect(reporter.flushErrorReporter(500)).resolves.toBe(false);
    expect(reporter.getLastErrorReportSendFailureKind()).toBe("network");
  });

  it("classifies an HTTP rejection distinctly from a network failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "server error" });
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    await reporter.initErrorReporter(
      {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testkey@example.com/1",
        maxBreadcrumbs: 0,
        sampleRate: 1,
        pendingQueuePath: queuePath,
      },
      "test-build",
    );

    reporter.capturePluginError(new Error("http classify test"), { operation: "classify", subsystem: "tests" });
    await expect(reporter.flushErrorReporter(500)).resolves.toBe(false);
    expect(reporter.getLastErrorReportSendFailureKind()).toBe("http");
  });
});

describe("describePendingTelemetryDrain (#2113)", () => {
  let mod: ErrorReporterModule;

  beforeEach(async () => {
    vi.resetModules();
    mod = (await import("../services/error-reporter.js")) as ErrorReporterModule;
  });

  it("reports a transient offline endpoint at info level for the startup phase", () => {
    const state = mod.describePendingTelemetryDrain({ phase: "startup", pendingCount: 4, failureKind: "network" });
    expect(state.level).toBe("info");
    expect(state.message).toMatch(/unreachable/i);
    expect(state.message).toContain("4 report(s)");
    expect(state.message).not.toMatch(/incomplete/i);
  });

  it("reports a transient offline endpoint at info level for the shutdown phase", () => {
    const state = mod.describePendingTelemetryDrain({ phase: "shutdown", pendingCount: 2, failureKind: "network" });
    expect(state.level).toBe("info");
    expect(state.message).toMatch(/memory-hybrid:/);
    expect(state.message).toMatch(/unreachable/i);
  });

  it("keeps the louder warn wording for a non-network startup drain failure", () => {
    const state = mod.describePendingTelemetryDrain({ phase: "startup", pendingCount: 3, failureKind: "http" });
    expect(state.level).toBe("warn");
    expect(state.message).toMatch(/Startup drain incomplete/);
    expect(state.message).toContain("hybrid-mem verify");
  });

  it("keeps the louder warn wording for a non-network shutdown flush failure", () => {
    const state = mod.describePendingTelemetryDrain({ phase: "shutdown", pendingCount: 5, failureKind: "other" });
    expect(state.level).toBe("warn");
    expect(state.message).toMatch(/flush incomplete/i);
    expect(state.message).toMatch(/retry on next startup/i);
  });
});

describe("error-reports CLI helpers (#2082)", () => {
  let tempDir: string;
  let queuePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "error-reporter-cli-helpers-"));
    queuePath = join(tempDir, ".error_reports.pending.jsonl");
    setEnv("ERROR_REPORTING_DSN", undefined);
    fetchMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function writeRecord(id: string, enqueuedAt: number, message: string, tags?: Record<string, string>): void {
    const line = JSON.stringify({
      id,
      enqueuedAt,
      event: {
        event_id: id,
        timestamp: enqueuedAt / 1000,
        exception: { values: [{ type: "Error", value: message }] },
        tags: tags ?? {},
      },
    });
    const existing = existsSync(queuePath) ? readFileSync(queuePath, "utf-8") : "";
    writeFileSync(queuePath, `${existing}${line}\n`);
  }

  it("readPendingErrorReportEntries returns [] when the queue file does not exist", async () => {
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    expect(reporter.readPendingErrorReportEntries(queuePath)).toEqual([]);
    expect(reporter.readPendingErrorReportEntries(undefined)).toEqual([]);
  });

  it("readPendingErrorReportEntries parses metadata oldest-first and honors limit", async () => {
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    writeRecord("c", 3000, "third failure", { subsystem: "tests", operation: "op-c" });
    writeRecord("a", 1000, "first failure", { subsystem: "tests", operation: "op-a" });
    writeRecord("b", 2000, "second failure", { subsystem: "tests", operation: "op-b" });

    const all = reporter.readPendingErrorReportEntries(queuePath);
    expect(all.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(all[0]).toMatchObject({
      id: "a",
      enqueuedAt: 1000,
      type: "Error",
      message: "first failure",
      subsystem: "tests",
      operation: "op-a",
    });

    const limited = reporter.readPendingErrorReportEntries(queuePath, 2);
    expect(limited.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("readPendingErrorReportEntries skips unparseable lines instead of throwing", async () => {
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    writeRecord("a", 1000, "ok record");
    writeFileSync(queuePath, `${readFileSync(queuePath, "utf-8")}not json\n`);
    const entries = reporter.readPendingErrorReportEntries(queuePath);
    expect(entries.map((e) => e.id)).toEqual(["a"]);
  });

  it("readPendingErrorReportEnqueueRange returns null when the queue is empty", async () => {
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    expect(reporter.readPendingErrorReportEnqueueRange(queuePath)).toBeNull();
  });

  it("readPendingErrorReportEnqueueRange returns oldest/newest enqueuedAt across records", async () => {
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    writeRecord("b", 2000, "middle");
    writeRecord("a", 1000, "oldest");
    writeRecord("c", 3000, "newest");
    expect(reporter.readPendingErrorReportEnqueueRange(queuePath)).toEqual({ oldest: 1000, newest: 3000 });
  });

  it("attemptOneShotErrorReportFlush declines when reporting is disabled", async () => {
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    const result = await reporter.attemptOneShotErrorReportFlush(
      { enabled: false, mode: "community", consent: true, sampleRate: 1 },
      queuePath,
      "test-build",
      500,
    );
    expect(result).toMatchObject({ attempted: false, pendingBefore: 0, pendingAfter: 0, flushed: false });
    expect(result.reason).toMatch(/disabled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("attemptOneShotErrorReportFlush declines self-hosted mode without a DSN", async () => {
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    const result = await reporter.attemptOneShotErrorReportFlush(
      { enabled: true, mode: "self-hosted", consent: true, sampleRate: 1 },
      queuePath,
      "test-build",
      500,
    );
    expect(result.attempted).toBe(false);
    expect(result.reason).toMatch(/DSN/);
  });

  it("attemptOneShotErrorReportFlush delivers queued records without touching module-level reporter state", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    // Recent timestamp so the report is not aged out by the retention window (#2113).
    writeRecord("a", Date.now(), "queued failure");

    expect(reporter.isErrorReporterActive()).toBe(false);
    const result = await reporter.attemptOneShotErrorReportFlush(
      { enabled: true, dsn: "https://testkey@example.com/1", mode: "community", consent: true, sampleRate: 1 },
      queuePath,
      "test-build",
      1000,
    );

    expect(result.attempted).toBe(true);
    expect(result.pendingBefore).toBe(1);
    expect(result.pendingAfter).toBe(0);
    expect(result.flushed).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    // A one-shot flush must not initialize the module-level singleton reporter.
    expect(reporter.isErrorReporterActive()).toBe(false);
    expect(reporter.getPendingErrorReportCount()).toBe(0);
  });

  it("attemptOneShotErrorReportFlush reports pendingAfter unchanged when delivery fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const reporter = (await import("../services/error-reporter.js")) as ErrorReporterModule;
    // Recent timestamp so the report is not aged out by the retention window (#2113).
    writeRecord("a", Date.now(), "queued failure");

    const result = await reporter.attemptOneShotErrorReportFlush(
      { enabled: true, dsn: "https://testkey@example.com/1", mode: "community", consent: true, sampleRate: 1 },
      queuePath,
      "test-build",
      500,
    );

    expect(result.attempted).toBe(true);
    expect(result.pendingBefore).toBe(1);
    expect(result.pendingAfter).toBe(1);
    expect(result.flushed).toBe(false);
  });
});
