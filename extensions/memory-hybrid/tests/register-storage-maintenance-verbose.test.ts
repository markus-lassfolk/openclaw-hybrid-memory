/**
 * `compact` and `vectordb-optimize` previously had no --verbose option and no heartbeat/progress
 * output at all — an operator watching a cron log during a long blocking call would see nothing
 * and assume the process hung. These tests assert the new `-v/--verbose` flag produces
 * start/complete heartbeat lines (via the shared runMaintenanceHeartbeat house pattern), and that
 * heartbeat lines stay silent without --verbose.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageStorageMaintenance } from "../cli/commands/manage/register-storage-maintenance.js";

describe("compact --verbose heartbeat", () => {
  const origArgv = process.argv.slice();

  afterEach(() => {
    process.argv = origArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function makeProgram(bindings: Record<string, unknown>): Command {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const mem = new Command("hybrid-mem");
    registerManageStorageMaintenance(mem, bindings as never);
    return mem;
  }

  it("emits start/complete heartbeat lines when --verbose is passed", async () => {
    const runCompaction = vi.fn().mockResolvedValue({ hot: 1, warm: 2, cold: 3, structural: 0 });
    const mem = makeProgram({
      factsDb: {},
      vectorDb: {},
      ctx: { resolvedSqlitePath: null },
      runCompaction,
    });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await mem.parseAsync(["tier-compact", "--verbose"], { from: "user" });

    expect(runCompaction).toHaveBeenCalledWith({ apply: true });
    expect(logs.some((l) => l.includes("compact — start"))).toBe(true);
    expect(logs.some((l) => l.includes("compact — complete in"))).toBe(true);
  });

  it("stays silent (no heartbeat lines) without --verbose", async () => {
    const runCompaction = vi.fn().mockResolvedValue({ hot: 1, warm: 2, cold: 3, structural: 0 });
    const mem = makeProgram({
      factsDb: {},
      vectorDb: {},
      ctx: { resolvedSqlitePath: null },
      runCompaction,
    });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await mem.parseAsync(["tier-compact"], { from: "user" });

    expect(runCompaction).toHaveBeenCalledWith({ apply: true });
    expect(logs.some((l) => l.includes("compact — start"))).toBe(false);
    expect(logs.some((l) => l.includes("compact — complete in"))).toBe(false);
    // The final result line must still be printed regardless of verbosity.
    expect(logs.some((l) => l.includes("Tier compaction (apply)"))).toBe(true);
  });
});

describe("vectordb-optimize --verbose heartbeat", () => {
  const origArgv = process.argv.slice();

  afterEach(() => {
    process.argv = origArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function makeProgram(bindings: Record<string, unknown>): Command {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const mem = new Command("hybrid-mem");
    registerManageStorageMaintenance(mem, bindings as never);
    return mem;
  }

  it("emits start/complete heartbeat lines when --verbose is passed", async () => {
    const optimize = vi.fn().mockResolvedValue({ compacted: 2, removedFragments: 1, freedBytes: 1024 });
    const mem = makeProgram({
      factsDb: {},
      vectorDb: { optimize },
      ctx: { resolvedSqlitePath: null },
    });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await mem.parseAsync(["vectordb-optimize", "--verbose"], { from: "user" });

    expect(optimize).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("vectordb-optimize — start"))).toBe(true);
    expect(logs.some((l) => l.includes("vectordb-optimize — complete in"))).toBe(true);
  });

  it("stays silent (no heartbeat lines) without --verbose", async () => {
    const optimize = vi.fn().mockResolvedValue({ compacted: 2, removedFragments: 1, freedBytes: 1024 });
    const mem = makeProgram({
      factsDb: {},
      vectorDb: { optimize },
      ctx: { resolvedSqlitePath: null },
    });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await mem.parseAsync(["vectordb-optimize"], { from: "user" });

    expect(optimize).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("vectordb-optimize — start"))).toBe(false);
    expect(logs.some((l) => l.includes("vectordb-optimize — complete in"))).toBe(false);
    // The final result line must still be printed regardless of verbosity.
    expect(logs.some((l) => l.includes("LanceDB: compacted 2 fragments"))).toBe(true);
  });
});
