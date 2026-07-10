/**
 * Regression test for cli/commands/manage/register-reflection-pipeline.ts's `find-duplicates`
 * and `consolidate` commands:
 *
 * Neither validated `--threshold`/`--limit` before passing them straight through. A malformed
 * `--threshold` (e.g. negative or >1) made almost every fact pair "similar", and `consolidate`
 * merges each resulting cluster via LLM and deletes the source facts — with no confirmation flag.
 * A negative `--limit` also flowed straight into a raw SQL `LIMIT` clause
 * (`getFactsForConsolidation`), and SQLite treats a negative `LIMIT` as "no limit". Both flags are
 * now validated the same way the sibling `reflect-meta --collapse-implicit-feedback --threshold`
 * and `register-storage-graph-audit.ts` commands already do.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageReflectionPipeline } from "../cli/commands/manage/register-reflection-pipeline.js";

function makeMinimalBindings(overrides: Partial<ManageBindings>): ManageBindings {
  const bindings = {
    factsDb: { getRawDb: () => ({}) },
    cfg: {},
    reflectionConfig: { defaultWindow: 7, model: "test-model" },
    ...overrides,
  } as unknown as ManageBindings;
  bindings.ctx = bindings;
  return bindings;
}

function makeProgram(bindings: ManageBindings): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageReflectionPipeline(mem, bindings);
  return mem;
}

describe("find-duplicates/consolidate --threshold/--limit validation (regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("find-duplicates rejects a negative --threshold instead of treating every pair as similar", async () => {
    const runFindDuplicates = vi.fn();
    const mem = makeProgram(makeMinimalBindings({ runFindDuplicates }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["find-duplicates", "--threshold", "-0.5"], { from: "user" });

    expect(runFindDuplicates).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--threshold must be a number"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("find-duplicates rejects a --threshold greater than 1", async () => {
    const runFindDuplicates = vi.fn();
    const mem = makeProgram(makeMinimalBindings({ runFindDuplicates }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["find-duplicates", "--threshold", "5"], { from: "user" });

    expect(runFindDuplicates).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--threshold must be a number"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("find-duplicates rejects a negative --limit instead of letting SQLite treat it as unbounded", async () => {
    const runFindDuplicates = vi.fn();
    const mem = makeProgram(makeMinimalBindings({ runFindDuplicates }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["find-duplicates", "--limit", "-1"], { from: "user" });

    expect(runFindDuplicates).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--limit must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("consolidate rejects a negative --threshold before acquiring the step lock or merging anything", async () => {
    const runConsolidate = vi.fn();
    const mem = makeProgram(makeMinimalBindings({ runConsolidate }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["consolidate", "--threshold", "0"], { from: "user" });

    expect(runConsolidate).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--threshold must be a number"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("consolidate rejects a non-numeric --limit", async () => {
    const runConsolidate = vi.fn();
    const mem = makeProgram(makeMinimalBindings({ runConsolidate }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["consolidate", "--limit", "not-a-number"], { from: "user" });

    expect(runConsolidate).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--limit must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("still accepts valid --threshold/--limit values for both commands", async () => {
    const runFindDuplicates = vi.fn().mockResolvedValue({ pairs: [], candidatesCount: 0, skippedStructured: 0 });
    const runConsolidate = vi
      .fn()
      .mockResolvedValue({ clustersFound: 0, merged: 0, deleted: 0, clustersFailed: 0, vectorFailures: 0 });
    const mem = makeProgram(makeMinimalBindings({ runFindDuplicates, runConsolidate }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["find-duplicates", "--threshold", "0.9", "--limit", "50"], { from: "user" });
    await mem.parseAsync(["consolidate", "--threshold", "0.9", "--limit", "5", "--dry-run"], { from: "user" });

    expect(runFindDuplicates).toHaveBeenCalledTimes(1);
    expect(runConsolidate).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });
});
