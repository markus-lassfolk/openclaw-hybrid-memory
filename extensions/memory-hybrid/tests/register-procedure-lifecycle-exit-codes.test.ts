/**
 * Regression test for cli/commands/manage/register-procedure-lifecycle.ts's exit codes:
 *
 * - `uninstall`'s `config_error` branch logged via console.error but never set
 *   process.exitCode, so a corrupted/unwritable openclaw.json during uninstall exited 0 even
 *   though the plugin's enabled:false flag was never actually written.
 * - `backup`'s `integrityOk: false` branch only printed a warning but never set
 *   process.exitCode, unlike the sibling `backup verify` subcommand which correctly does
 *   `if (!res.integrityOk) process.exitCode = 1;` for the identical condition.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageProcedureAndLifecycle } from "../cli/commands/manage/register-procedure-lifecycle.js";

function makeProgram(overrides: Partial<ManageBindings>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageProcedureAndLifecycle(mem, { cfg: {}, ...overrides } as unknown as ManageBindings);
  return mem;
}

describe("register-procedure-lifecycle exit codes (regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("uninstall sets exit code 1 on config_error instead of silently exiting 0", async () => {
    const runUninstall = vi.fn(async () => ({
      outcome: "config_error" as const,
      error: "EACCES: permission denied",
      pluginId: "memory-hybrid",
      cleaned: ["state.db"],
    }));
    const mem = makeProgram({ runUninstall });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["uninstall"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("uninstall leaves exit code unset on config_updated (still succeeds normally)", async () => {
    const runUninstall = vi.fn(async () => ({
      outcome: "config_updated" as const,
      pluginId: "memory-hybrid",
      cleaned: ["state.db"],
    }));
    const mem = makeProgram({ runUninstall });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["uninstall"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
  });

  it("backup sets exit code 1 when integrityOk is false instead of only warning", async () => {
    const runBackup = vi.fn(async () => ({
      ok: true as const,
      backupDir: "/tmp/backup",
      sqliteSize: 1024,
      lancedbSize: 2048,
      durationMs: 42,
      integrityOk: false,
      snapshotSkewMs: 0,
    }));
    const mem = makeProgram({ runBackup });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await mem.parseAsync(["backup"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("backup leaves exit code unset when integrityOk is true", async () => {
    const runBackup = vi.fn(async () => ({
      ok: true as const,
      backupDir: "/tmp/backup",
      sqliteSize: 1024,
      lancedbSize: 2048,
      durationMs: 42,
      integrityOk: true,
      snapshotSkewMs: 0,
    }));
    const mem = makeProgram({ runBackup });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["backup"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
  });
});

describe("register-procedure-lifecycle 'list --limit' validation (#2067-followup)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("rejects a non-numeric --limit instead of silently listing 0 of 0 procedures", async () => {
    const listProcedures = vi.fn(() => []);
    const mem = makeProgram({ factsDb: { listProcedures } as unknown as ManageBindings["factsDb"] });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["procedure", "list", "--limit", "abc"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(listProcedures).not.toHaveBeenCalled();
  });

  it("rejects a --limit of 0 instead of silently listing 0 of 0 procedures", async () => {
    const listProcedures = vi.fn(() => []);
    const mem = makeProgram({ factsDb: { listProcedures } as unknown as ManageBindings["factsDb"] });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["procedure", "list", "--limit", "0"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(listProcedures).not.toHaveBeenCalled();
  });

  it("still lists procedures normally with a valid --limit", async () => {
    const listProcedures = vi.fn(() => [
      {
        id: "proc-fixture-a",
        procedureType: "positive",
        taskPattern: "run the test-fixture workflow",
        successRate: 0.5,
        version: 1,
      },
    ]);
    const mem = makeProgram({ factsDb: { listProcedures } as unknown as ManageBindings["factsDb"] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["procedure", "list", "--limit", "5"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    expect(listProcedures).toHaveBeenCalledWith(15);
  });
});
