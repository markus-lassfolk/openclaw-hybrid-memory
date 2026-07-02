/**
 * The backfill-* commands loop over session files calling functions that don't catch their own
 * readFileSync failures (synthesizeDailyLogFromSessionFile, scanSessionFileForMetadata,
 * backfillRecallEventsFromSessionFile). Without a per-file try/catch in the CLI loop, a single
 * unreadable session file aborted the entire batch instead of being reported as a distinct
 * failure alongside the files that were processed successfully.
 */
import { Command } from "commander";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBackfillMaintenanceCommands } from "../cli/commands/manage/register-backfill-maintenance.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

function makeProgram(sessionsDir: string, factsDb: InstanceType<typeof FactsDB>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  const cfg = hybridConfigSchema.parse({
    mode: "local",
    embedding: { provider: "ollama", model: "nomic-embed-text", dimensions: 3 },
    procedures: { sessionsDir, allAgentSessions: false },
  });
  registerBackfillMaintenanceCommands(mem, { factsDb, cfg } as unknown as ManageBindings, { onlyBackfill: true });
  return mem;
}

describe("backfill-* commands isolate per-file failures", () => {
  let sessionsDir: string;
  let db: InstanceType<typeof FactsDB>;

  afterEach(() => {
    db?.close();
    rmSync(sessionsDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function setupSessions() {
    sessionsDir = mkdtempSync(join(tmpdir(), "hm-backfill-sessions-"));
    db = new FactsDB(":memory:");
    writeFileSync(
      join(sessionsDir, "good-session.jsonl"),
      `${JSON.stringify({ type: "user", message: { role: "user", content: "hello there" } })}\n`,
      "utf-8",
    );
    // A directory named like a session transcript passes the .jsonl filename filter but makes
    // readFileSync throw EISDIR when a backfill helper tries to read it as a file.
    mkdirSync(join(sessionsDir, "broken-session.jsonl"), { recursive: true });
  }

  it("backfill-daily-logs reports the failed file instead of aborting the whole batch", async () => {
    setupSessions();
    const mem = makeProgram(sessionsDir, db);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["backfill-daily-logs", "--days", "9999", "--json"], { from: "user" });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as { files: number; failed: number };
    expect(payload.files).toBe(2);
    expect(payload.failed).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it("backfill-session-languages reports the failed file instead of aborting the whole batch", async () => {
    setupSessions();
    const mem = makeProgram(sessionsDir, db);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["backfill-session-languages", "--days", "9999", "--json"], { from: "user" });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as { files: number; failed: number };
    expect(payload.files).toBe(2);
    expect(payload.failed).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it("backfill-recall-events reports the failed file instead of aborting the whole batch", async () => {
    setupSessions();
    const mem = makeProgram(sessionsDir, db);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["backfill-recall-events", "--days", "9999", "--json"], { from: "user" });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as { files: number; failed: number };
    expect(payload.files).toBe(2);
    expect(payload.failed).toBe(1);
    expect(process.exitCode).toBe(1);
  });
});
