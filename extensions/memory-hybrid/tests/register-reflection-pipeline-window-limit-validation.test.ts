/**
 * Regression test (#2067-followup) for cli/commands/manage/register-reflection-pipeline.ts:
 *
 * `reflect --window`, `reflect-identity --window`, and `classify --limit` parsed their flag with
 * raw Number.parseInt and never checked Number.isFinite. A non-numeric value (e.g. "abc") parses
 * to NaN, which propagates through downstream clamps/slices to silently match zero rows instead
 * of erroring -- the command then reports "0 facts"/"0 insights" with exit code 0 instead of
 * rejecting the bad flag, the same anti-pattern the codebase's shared parseDaysFlag() helper was
 * built to prevent elsewhere.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageReflectionPipeline } from "../cli/commands/manage/register-reflection-pipeline.js";

function makeProgram(overrides: Partial<ManageBindings>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageReflectionPipeline(mem, {
    cfg: {},
    reflectionConfig: { defaultWindow: 14, model: "test-model" },
    ...overrides,
  } as unknown as ManageBindings);
  return mem;
}

describe("register-reflection-pipeline --window/--limit validation (#2067-followup)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("reflect rejects a non-numeric --window instead of silently analyzing 0 facts", async () => {
    const runReflection = vi.fn(async () => ({
      factsAnalyzed: 0,
      patternsExtracted: 0,
      patternsStored: 0,
      window: 14,
    }));
    const mem = makeProgram({ runReflection });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["reflect", "--window", "abc"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(runReflection).not.toHaveBeenCalled();
  });

  it("reflect still runs normally with a valid --window", async () => {
    const runReflection = vi.fn(async () => ({
      factsAnalyzed: 3,
      patternsExtracted: 1,
      patternsStored: 1,
      window: 7,
    }));
    const mem = makeProgram({ runReflection });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["reflect", "--window", "7"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    expect(runReflection).toHaveBeenCalledWith(expect.objectContaining({ window: 7 }));
  });

  it("reflect-identity rejects a non-numeric --window instead of silently extracting 0 insights", async () => {
    const runReflectIdentity = vi.fn(async () => ({
      insightsExtracted: 0,
      insightsStored: 0,
      questionsAsked: 0,
    }));
    const mem = makeProgram({ runReflectIdentity });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["reflect-identity", "--window", "abc"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(runReflectIdentity).not.toHaveBeenCalled();
  });

  it("classify rejects a non-numeric --limit instead of silently reclassifying 0/0 facts", async () => {
    const runClassify = vi.fn(async () => ({ reclassified: 0, total: 0, batchFailures: 0 }));
    const mem = makeProgram({ runClassify });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["classify", "--limit", "abc"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(runClassify).not.toHaveBeenCalled();
  });

  it("classify still runs normally with a valid --limit", async () => {
    const runClassify = vi.fn(async () => ({ reclassified: 2, total: 2, batchFailures: 0 }));
    const mem = makeProgram({ runClassify });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["classify", "--limit", "5"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    expect(runClassify).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });
});
