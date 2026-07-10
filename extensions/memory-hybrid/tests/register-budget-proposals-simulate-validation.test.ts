/**
 * Regression test for cli/commands/manage/register-budget-proposals.ts's `budget simulate`:
 *
 * `budgetVal = Number.parseInt(opts?.budget ?? String(DEFAULT_BUDGET), 10)` had no
 * Number.isFinite/positivity check. A negative or non-numeric --budget makes
 * `trimToBudget()`'s `currentTokens <= tokenBudget` guard always false (any comparison against
 * NaN is false; a negative budget is smaller than any real token count), so the trim loop runs
 * to (near) exhaustion of the non-preserved pool instead of the CLI rejecting the invalid flag.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageBudgetAndProposals } from "../cli/commands/manage/register-budget-proposals.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

function makeProgram(factsDb: InstanceType<typeof FactsDB>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageBudgetAndProposals(mem, { factsDb, cfg: {} } as unknown as ManageBindings);
  return mem;
}

describe("budget simulate --budget validation (regression)", () => {
  let db: InstanceType<typeof FactsDB>;

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("rejects a negative --budget instead of simulating trimming nearly everything", async () => {
    db = new FactsDB(":memory:");
    for (let i = 0; i < 5; i++) {
      db.store({
        text: `low-importance fact ${i}`,
        category: "fact",
        importance: 0.2,
        entity: null,
        key: null,
        value: null,
        source: "test",
      });
    }
    const mem = makeProgram(db);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["budget", "simulate", "--budget", "-100"], { from: "user" });

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--budget must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric --budget", async () => {
    db = new FactsDB(":memory:");
    const mem = makeProgram(db);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["budget", "simulate", "--budget", "not-a-number"], { from: "user" });

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--budget must be a positive integer"))).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("still accepts a valid positive --budget", async () => {
    db = new FactsDB(":memory:");
    db.store({
      text: "some fact",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const mem = makeProgram(db);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["budget", "simulate", "--budget", "1000"], { from: "user" });

    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("Budget Simulation"))).toBe(true);
  });
});
