/**
 * Regression test (#2067-followup sweep) for --days flags that had zero validation:
 *
 * `register-self-correction-feedback.ts`'s self-correction-extract/self-correction-run/
 * extract-implicit/cost-report/analyze-feedback-phrases, and
 * `register-backfill-maintenance.ts`'s workflow-trace-quality/backfill-(various)/maintenance-coverage,
 * all did `Number.parseInt(opts.days, 10)` (or similar) with no validation. A non-numeric or
 * negative --days flowed into a `cutoff = Date.now() - days * 86400000` computation whose
 * `mtimeMs > cutoff` comparison is always false for NaN/a future cutoff, so the command silently
 * scanned zero session files and reported success (exit code 0) instead of rejecting the flag —
 * the same bug class already fixed for cli/distill.ts's --days flags (see
 * distill-days-flag-validation.test.ts). Both files now share the same parseDaysFlag() helper.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerBackfillMaintenanceCommands } from "../cli/commands/manage/register-backfill-maintenance.js";
import { registerManageSelfCorrectionFeedback } from "../cli/commands/manage/register-self-correction-feedback.js";

function makeSelfCorrectionBindings(overrides: Partial<ManageBindings>): ManageBindings {
  const bindings = {
    cfg: {},
    runSelfCorrectionExtract: vi.fn(),
    runSelfCorrectionRun: vi.fn(),
    runExtractImplicitFeedback: vi.fn(),
    runCrossAgentLearning: vi.fn(),
    runToolEffectiveness: vi.fn(),
    pruneCostLog: vi.fn(),
    runCostReport: vi.fn(),
    runAnalyzeFeedbackPhrases: vi.fn(),
    ...overrides,
  } as unknown as ManageBindings;
  bindings.ctx = bindings;
  return bindings;
}

function makeSelfCorrectionProgram(bindings: ManageBindings): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageSelfCorrectionFeedback(mem, bindings);
  return mem;
}

function makeBackfillProgram(bindings: ManageBindings): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerBackfillMaintenanceCommands(mem, bindings, { onlyWorkflowQa: true });
  return mem;
}

describe("--days flag validation for self-correction/feedback commands (regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("self-correction-extract rejects a non-numeric --days", async () => {
    const runSelfCorrectionExtract = vi.fn();
    const mem = makeSelfCorrectionProgram(makeSelfCorrectionBindings({ runSelfCorrectionExtract }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["self-correction-extract", "--days", "not-a-number"], { from: "user" });

    expect(runSelfCorrectionExtract).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("self-correction-run rejects a negative --days instead of silently reporting zero incidents", async () => {
    const runSelfCorrectionRun = vi.fn();
    const mem = makeSelfCorrectionProgram(makeSelfCorrectionBindings({ runSelfCorrectionRun }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["self-correction-run", "--days", "-3"], { from: "user" });

    expect(runSelfCorrectionRun).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("extract-implicit rejects a negative --days", async () => {
    const runExtractImplicitFeedback = vi.fn();
    const mem = makeSelfCorrectionProgram(makeSelfCorrectionBindings({ runExtractImplicitFeedback }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["extract-implicit", "--days", "-1"], { from: "user" });

    expect(runExtractImplicitFeedback).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("analyze-feedback-phrases (optional --days) rejects an invalid value but still allows omission", async () => {
    const runAnalyzeFeedbackPhrases = vi
      .fn()
      .mockResolvedValue({ sessionsScanned: 0, reinforcement: [], correction: [] });
    const mem = makeSelfCorrectionProgram(makeSelfCorrectionBindings({ runAnalyzeFeedbackPhrases }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["analyze-feedback-phrases", "--days", "abc"], { from: "user" });
    expect(runAnalyzeFeedbackPhrases).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await mem.parseAsync(["analyze-feedback-phrases"], { from: "user" });
    expect(runAnalyzeFeedbackPhrases).toHaveBeenCalledTimes(1);
  });
});

describe("--days flag validation for workflow-trace-quality (regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("workflow-trace-quality rejects a negative --days before touching the workflow store", async () => {
    const mem = makeBackfillProgram({} as ManageBindings);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["workflow-trace-quality", "--days", "-30"], { from: "user" });

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("workflow-trace-quality rejects a non-numeric --days", async () => {
    const mem = makeBackfillProgram({} as ManageBindings);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["workflow-trace-quality", "--days", "nope"], { from: "user" });

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--days must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
