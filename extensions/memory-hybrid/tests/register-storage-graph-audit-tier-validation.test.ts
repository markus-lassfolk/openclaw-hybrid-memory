/**
 * Regression test for cli/commands/manage/register-storage-graph-audit.ts's `list --tier`:
 *
 * `tier: opts?.tier as "hot" | "warm" | "cold" | "structural" | undefined` cast the flag with no
 * runtime validation, unlike the sibling `dump` command's `--order` flag in the same file.
 * `listFacts()` (backends/facts-db/fact-read-queries.ts) silently returns `[]` for any tier value
 * not in `DASHBOARD_TIER_FILTER`, so a typo'd `--tier` (e.g. "hott") printed "Recent facts" with
 * zero rows and exit code 0 instead of reporting the invalid flag.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageStorageGraphAudit } from "../cli/commands/manage/register-storage-graph-audit.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

function makeProgram(factsDb: InstanceType<typeof FactsDB>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageStorageGraphAudit(mem, { factsDb, cfg: {} } as unknown as ManageBindings);
  return mem;
}

describe("storage list --tier validation (regression)", () => {
  let db: InstanceType<typeof FactsDB>;

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("rejects an unrecognized --tier instead of silently returning zero results", async () => {
    db = new FactsDB(":memory:");
    db.store({
      text: "a hot fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const mem = makeProgram(db);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["list", "--tier", "hott"], { from: "user" });

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--tier must be one of"))).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("still accepts a valid --tier", async () => {
    db = new FactsDB(":memory:");
    db.store({
      text: "a warm fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const mem = makeProgram(db);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["list", "--tier", "warm"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Recent facts"))).toBe(true);
  });
});
