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
});
