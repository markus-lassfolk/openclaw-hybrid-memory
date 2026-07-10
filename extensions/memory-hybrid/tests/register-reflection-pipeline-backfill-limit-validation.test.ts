/**
 * Regression test (#2067-followup) for cli/commands/manage/register-reflection-pipeline.ts's
 * `backfill --limit`:
 *
 * A non-numeric --limit (e.g. "abc") parsed to NaN via Number.parseInt and was passed straight
 * through to runBackfillForCli, whose cap check is `limit > 0 && stored >= limit` -- `NaN > 0`
 * is false, so the intended cap silently never applied and the backfill ran unbounded instead of
 * rejecting the bad flag (fail-open, not fail-closed like most of this codebase's other
 * unvalidated-NaN bugs).
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageReflectionPipeline } from "../cli/commands/manage/register-reflection-pipeline.js";

function makeProgram(overrides: Partial<ManageBindings>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageReflectionPipeline(
    mem,
    {
      cfg: {},
      reflectionConfig: { defaultWindow: 14, model: "test-model" },
      ...overrides,
    } as unknown as ManageBindings,
    { onlyIngest: true },
  );
  return mem;
}

describe("register-reflection-pipeline 'backfill --limit' validation (#2067-followup)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("rejects a non-numeric --limit instead of silently backfilling unbounded", async () => {
    const runBackfill = vi.fn(async () => ({ stored: 0, skipped: 0, candidates: 0, files: 0, dryRun: false }));
    const mem = makeProgram({ runBackfill });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["backfill", "--limit", "abc"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it("rejects a --limit of 0 instead of silently backfilling unbounded", async () => {
    const runBackfill = vi.fn(async () => ({ stored: 0, skipped: 0, candidates: 0, files: 0, dryRun: false }));
    const mem = makeProgram({ runBackfill });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["backfill", "--limit", "0"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it("still backfills normally with a valid --limit", async () => {
    const runBackfill = vi.fn(async () => ({ stored: 5, skipped: 1, candidates: 6, files: 2, dryRun: false }));
    const mem = makeProgram({ runBackfill });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["backfill", "--limit", "5"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    expect(runBackfill).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }), expect.anything());
  });

  it("still backfills normally with no --limit at all (unbounded by explicit choice)", async () => {
    const runBackfill = vi.fn(async () => ({ stored: 5, skipped: 1, candidates: 6, files: 2, dryRun: false }));
    const mem = makeProgram({ runBackfill });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["backfill"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    expect(runBackfill).toHaveBeenCalledWith(expect.objectContaining({ limit: undefined }), expect.anything());
  });
});
