import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageStorageMaintenance } from "../cli/commands/manage/register-storage-maintenance.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

function registerRecordStorageSampleCommand(factsDb: InstanceType<typeof FactsDB>): Command {
  const mem = new Command("hybrid-mem");
  registerManageStorageMaintenance(mem, {
    factsDb,
    vectorDb: {},
    aliasDb: {},
    versionInfo: { version: "test" },
    embeddings: {},
    mergeResults: vi.fn(),
    getMemoryCategories: () => ["fact"],
    cfg: {
      memory: {
        categories: ["fact"],
      },
    },
    runCompaction: vi.fn(),
    tieringEnabled: false,
    ctx: {
      resolvedSqlitePath: null,
      richStatsExtras: {
        getStorageSizes: () => ({ lanceBytes: 1234 }),
      },
    },
    listCommands: () => [],
    auditStore: null,
    runExport: vi.fn(),
    merge: vi.fn(),
    BACKFILL_DECAY_MARKER: ".backfill-decay-done",
  } as any);
  return mem;
}

describe("record-storage-sample CLI (#1683)", () => {
  const origArgv = process.argv.slice();

  afterEach(() => {
    process.argv = origArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("emits a parseable skipped marker when the same-day guard blocks a rerun", async () => {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const factsDb = new FactsDB(":memory:");
    const mem = registerRecordStorageSampleCommand(factsDb);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["record-storage-sample"], { from: "user" });
    await mem.parseAsync(["record-storage-sample"], { from: "user" });

    const lastMessage = String(logSpy.mock.calls.at(-1)?.[0] ?? "");
    const rows = factsDb.getRawDb()?.prepare("SELECT COUNT(*) AS c FROM storage_growth_history").get() as { c: number };

    expect(lastMessage).toContain("status=skipped_already_sampled_today");
    expect(rows.c).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    factsDb.close();
  });

  it("supports --force to record another same-day sample", async () => {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const factsDb = new FactsDB(":memory:");
    const mem = registerRecordStorageSampleCommand(factsDb);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["record-storage-sample"], { from: "user" });
    await mem.parseAsync(["record-storage-sample", "--force"], { from: "user" });

    const lastMessage = String(logSpy.mock.calls.at(-1)?.[0] ?? "");
    const rows = factsDb.getRawDb()?.prepare("SELECT COUNT(*) AS c FROM storage_growth_history").get() as { c: number };

    expect(lastMessage).toContain("status=success_recorded");
    expect(rows.c).toBe(2);
    factsDb.close();
  });

  it("supports --dry-run --json without writing a row", async () => {
    process.argv = ["node", "/usr/bin/openclaw", "hybrid-mem"];
    const factsDb = new FactsDB(":memory:");
    const mem = registerRecordStorageSampleCommand(factsDb);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["record-storage-sample", "--dry-run", "--json"], { from: "user" });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      status?: string;
      inserted?: boolean;
      dryRun?: boolean;
      sample?: { lanceBytes?: number | null };
    };
    const rows = factsDb.getRawDb()?.prepare("SELECT COUNT(*) AS c FROM storage_growth_history").get() as { c: number };

    expect(payload.status).toBe("dry_run");
    expect(payload.inserted).toBe(false);
    expect(payload.dryRun).toBe(true);
    expect(payload.sample?.lanceBytes).toBe(1234);
    expect(rows.c).toBe(0);
    factsDb.close();
  });
});
