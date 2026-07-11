/**
 * Regression test (#2067-followup) for cli/commands/manage/register-storage-maintenance.ts's
 * `storage re-index` command:
 *
 * Several failure branches (shadow table creation, aborted migration, insufficient migrated
 * rows, shadow table swap) called the raw global `process.exit(1)` directly instead of setting
 * `process.exitCode = 1` and returning. A raw `process.exit()` call bypasses withExit's
 * `isStandaloneCliProcess()` guard entirely and terminates the whole host process -- fatal when
 * `hybrid-mem re-index` is invoked in-process (e.g. from the gateway or from a test), not just
 * the intended CLI subcommand. Now all four branches set `process.exitCode = 1` and `return`,
 * letting withExit decide whether an actual process.exit() is warranted.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageStorageMaintenance } from "../cli/commands/manage/register-storage-maintenance.js";

function makeProgram(bindings: Record<string, unknown>): Command {
  const mem = new Command("hybrid-mem");
  registerManageStorageMaintenance(mem, bindings as never);
  return mem;
}

describe("storage re-index exit code (#2067-followup)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("sets process.exitCode instead of killing the host process when shadow table creation fails", async () => {
    const factsDb = { getCount: () => 1, getAll: () => [{ id: "f1" }] };
    const vectorDb = { createShadowTable: vi.fn().mockRejectedValue(new Error("lance unavailable")) };
    const mem = makeProgram({
      factsDb,
      vectorDb,
      embeddings: { modelName: "test-model" },
      ctx: { resolvedSqlitePath: null },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // A raw process.exit(1) here (instead of process.exitCode = 1; return;) would previously
    // terminate the entire embedding host process. vitest guards process.exit() by throwing --
    // if the bug regresses, this call rejects instead of resolving.
    await mem.parseAsync(["re-index"], { from: "user" });

    expect(vectorDb.createShadowTable).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
