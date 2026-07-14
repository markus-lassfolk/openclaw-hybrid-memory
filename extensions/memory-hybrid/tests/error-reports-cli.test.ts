// @ts-nocheck
/**
 * Regression tests for #2082: `error-reports status|peek|flush` gives operators a cheap,
 * focused way to inspect/drain the error-reporter's persistent pending queue instead of running
 * expensive `verify`/`doctor` or restarting the gateway.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageErrorReports } from "../cli/commands/manage/register-error-reports.js";
import { hybridConfigSchema } from "../config.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function makeProgram(sqlitePath: string, errorReporting?: Record<string, unknown>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  const cfg = hybridConfigSchema.parse({
    embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test-key-12345678" },
    sqlitePath,
  });
  if (errorReporting) {
    (cfg as unknown as { errorReporting: unknown }).errorReporting = errorReporting;
  }
  registerManageErrorReports(mem, { cfg, ctx: {} } as unknown as ManageBindings);
  return mem;
}

function queuePathFor(sqlitePath: string): string {
  return join(sqlitePath.replace(/[^/]+$/, ""), ".error_reports.pending.jsonl");
}

function writeRecord(queuePath: string, id: string, enqueuedAt: number, message: string): void {
  const line = JSON.stringify({
    id,
    enqueuedAt,
    event: { event_id: id, timestamp: enqueuedAt / 1000, exception: { values: [{ type: "Error", value: message }] } },
  });
  const existing = existsSync(queuePath) ? readFileSync(queuePath, "utf-8") : "";
  writeFileSync(queuePath, `${existing}${line}\n`);
}

describe("error-reports CLI (#2082)", () => {
  let tmpDir: string;
  let sqlitePath: string;
  let queuePath: string;
  let logs: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-error-reports-cli-"));
    sqlitePath = join(tmpDir, "facts.db");
    queuePath = queuePathFor(sqlitePath);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("status", () => {
    it("reports zero pending and no reporter activity for a fresh queue", async () => {
      const mem = makeProgram(sqlitePath);
      await mem.parseAsync(["error-reports", "status"], { from: "user" });

      expect(logs.some((l) => l.includes(`Queue path:        ${queuePath}`))).toBe(true);
      expect(logs.some((l) => l.includes("Pending count:     0"))).toBe(true);
      expect(logs.some((l) => l.includes("Reporter active:   false"))).toBe(true);
      expect(logs.some((l) => l.includes("Reporting enabled: true"))).toBe(true);
      expect(logs.some((l) => l.includes("Consent given:     true"))).toBe(true);
    });

    it("shows oldest/newest enqueue timestamps and a next-step hint when reports are pending", async () => {
      writeRecord(queuePath, "a", 1_000, "first");
      writeRecord(queuePath, "b", 3_000, "second");
      const mem = makeProgram(sqlitePath);
      await mem.parseAsync(["error-reports", "status"], { from: "user" });

      expect(logs.some((l) => l.includes("Pending count:     2"))).toBe(true);
      expect(logs.some((l) => l.includes(new Date(1_000).toISOString()))).toBe(true);
      expect(logs.some((l) => l.includes(new Date(3_000).toISOString()))).toBe(true);
      expect(logs.some((l) => l.includes("error-reports peek"))).toBe(true);
      expect(logs.some((l) => l.includes("error-reports flush"))).toBe(true);
    });

    it("resolves the queue path via ctx.resolvedSqlitePath, not the raw (possibly unresolved) cfg.sqlitePath (QA follow-up)", async () => {
      // cfg.sqlitePath deliberately does NOT point at the real tmp dir (mirrors a config with an
      // unexpanded `~/...` path) — only ctx.resolvedSqlitePath does. Before the fix, resolveQueuePath()
      // read b.cfg.sqlitePath directly and would have looked in the wrong place.
      writeRecord(queuePath, "a", 1_000, "first");
      const mem = new Command("hybrid-mem");
      mem.exitOverride();
      const cfg = hybridConfigSchema.parse({
        embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test-key-12345678" },
        sqlitePath: "~/.openclaw/memory/facts.db",
      });
      registerManageErrorReports(mem, {
        cfg,
        ctx: {},
        resolvedSqlitePath: sqlitePath,
      } as unknown as ManageBindings);
      await mem.parseAsync(["error-reports", "status", "--json"], { from: "user" });

      const parsed = JSON.parse(logs.join(""));
      expect(parsed.queuePath).toBe(queuePath);
      expect(parsed.pendingCount).toBe(1);
    });

    it("--json emits a structured status object", async () => {
      writeRecord(queuePath, "a", 1_000, "first");
      const mem = makeProgram(sqlitePath);
      await mem.parseAsync(["error-reports", "status", "--json"], { from: "user" });

      const parsed = JSON.parse(logs.join(""));
      expect(parsed.queuePath).toBe(queuePath);
      expect(parsed.pendingCount).toBe(1);
      expect(parsed.reporterActiveInProcess).toBe(false);
      expect(parsed.reportingEnabled).toBe(true);
      expect(parsed.consentGiven).toBe(true);
    });

    it("reflects errorReporting.enabled=false and consent=false", async () => {
      const mem = makeProgram(sqlitePath, { enabled: false, consent: false, mode: "community" });
      await mem.parseAsync(["error-reports", "status", "--json"], { from: "user" });
      const parsed = JSON.parse(logs.join(""));
      expect(parsed.reportingEnabled).toBe(false);
      expect(parsed.consentGiven).toBe(false);
    });
  });

  describe("peek", () => {
    it("reports no pending reports on an empty queue", async () => {
      const mem = makeProgram(sqlitePath);
      await mem.parseAsync(["error-reports", "peek"], { from: "user" });
      expect(logs.some((l) => l.includes("No pending reports on disk"))).toBe(true);
    });

    it("shows oldest-first entries with type/message and subsystem/operation", async () => {
      const line = JSON.stringify({
        id: "a",
        enqueuedAt: 1_000,
        event: {
          event_id: "a",
          exception: { values: [{ type: "RangeError", value: "boom" }] },
          tags: { subsystem: "tests", operation: "peek-test" },
        },
      });
      writeFileSync(queuePath, `${line}\n`);
      const mem = makeProgram(sqlitePath);
      await mem.parseAsync(["error-reports", "peek"], { from: "user" });

      expect(logs.some((l) => l.includes("RangeError: boom"))).toBe(true);
      expect(logs.some((l) => l.includes("subsystem=tests operation=peek-test id=a"))).toBe(true);
    });

    it("--limit caps the number of entries returned", async () => {
      writeRecord(queuePath, "a", 1_000, "one");
      writeRecord(queuePath, "b", 2_000, "two");
      writeRecord(queuePath, "c", 3_000, "three");
      const mem = makeProgram(sqlitePath);
      await mem.parseAsync(["error-reports", "peek", "--limit", "2", "--json"], { from: "user" });

      const parsed = JSON.parse(logs.join(""));
      expect(parsed.entries.map((e: { id: string }) => e.id)).toEqual(["a", "b"]);
    });

    it("rejects a non-numeric --limit", async () => {
      const mem = makeProgram(sqlitePath);
      await expect(mem.parseAsync(["error-reports", "peek", "--limit", "abc"], { from: "user" })).rejects.toThrow();
    });

    it("collapses duplicate-fingerprint entries, matching what flush() would actually deliver (QA follow-up)", async () => {
      // Two records with the identical exception type+message (same fingerprint) — the live
      // reporter's own queue-load dedups these to one; the disk-level CLI reader must match.
      writeRecord(queuePath, "a", 1_000, "same error");
      writeRecord(queuePath, "b", 2_000, "same error");
      writeRecord(queuePath, "c", 3_000, "different error");
      const mem = makeProgram(sqlitePath);
      await mem.parseAsync(["error-reports", "peek", "--json"], { from: "user" });

      const parsed = JSON.parse(logs.join(""));
      expect(parsed.entries.map((e: { id: string }) => e.id)).toEqual(["a", "c"]);
    });
  });

  describe("flush", () => {
    it("explains why no flush was attempted when reporting is disabled, and exits non-zero", async () => {
      const mem = makeProgram(sqlitePath, { enabled: false, consent: true, mode: "community" });
      await mem.parseAsync(["error-reports", "flush"], { from: "user" });

      expect(logs.some((l) => l.includes("No flush attempted") && l.includes("disabled"))).toBe(true);
      expect(process.exitCode).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("delivers queued reports and reports the before/after pending count", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
      // Recent timestamp so the report is not aged out by the retention window (#2113).
      writeRecord(queuePath, "a", Date.now(), "queued failure");
      const mem = makeProgram(sqlitePath, {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testkey@example.com/1",
      });

      await mem.parseAsync(["error-reports", "flush", "--timeout", "1000"], { from: "user" });

      expect(logs.some((l) => l.includes("Pending before: 1"))).toBe(true);
      expect(logs.some((l) => l.includes("Pending after:  0"))).toBe(true);
      expect(logs.some((l) => l.includes("Delivered 1 report(s)"))).toBe(true);
      expect(process.exitCode ?? 0).toBe(0);
    });

    it("--json emits attempted/pendingBefore/pendingAfter/flushed", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
      // Recent timestamp so the report is not aged out by the retention window (#2113).
      writeRecord(queuePath, "a", Date.now(), "queued failure");
      const mem = makeProgram(sqlitePath, {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testkey@example.com/1",
      });

      await mem.parseAsync(["error-reports", "flush", "--timeout", "1000", "--json"], { from: "user" });

      const parsed = JSON.parse(logs.join(""));
      expect(parsed).toMatchObject({ attempted: true, pendingBefore: 1, pendingAfter: 0, flushed: true });
    });

    it("rejects a non-numeric --timeout", async () => {
      const mem = makeProgram(sqlitePath);
      await expect(
        mem.parseAsync(["error-reports", "flush", "--timeout", "not-a-number"], { from: "user" }),
      ).rejects.toThrow();
    });
  });
});
