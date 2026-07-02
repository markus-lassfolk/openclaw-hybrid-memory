/**
 * `preserve <id> -t foo -t bar` must accumulate every --tag flag instead of keeping only the
 * last one (Commander needs an explicit collector function to accumulate repeated flags), and
 * the preserveUntil + preserveTags mutations must be atomic so a failure in one can't leave the
 * fact in a half-updated state while still reporting overall failure.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageBudgetAndProposals } from "../cli/commands/manage/register-budget-proposals.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

function makeProgram(factsDb: InstanceType<typeof FactsDB>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageBudgetAndProposals(mem, { factsDb, cfg: {} } as unknown as ManageBindings);
  return mem;
}

describe("preserve command", () => {
  let db: InstanceType<typeof FactsDB>;

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("accumulates every repeated -t/--tag flag instead of keeping only the last one", async () => {
    db = new FactsDB(":memory:");
    const fact = db.store({
      text: "preserve me",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const mem = makeProgram(db);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["preserve", fact.id, "-t", "alpha", "-t", "beta", "-t", "gamma"], { from: "user" });

    const updated = db.getById(fact.id);
    expect(updated?.preserveTags?.sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("rolls back preserveUntil when the tag mutation fails, instead of leaving a half-applied state", async () => {
    db = new FactsDB(":memory:");
    const fact = db.store({
      text: "preserve me",
      category: "fact",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    const originalPreserveUntil = db.getById(fact.id)?.preserveUntil ?? null;
    vi.spyOn(db, "setPreserveTags").mockImplementation(() => {
      throw new Error("tag write boom");
    });
    const mem = makeProgram(db);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(mem.parseAsync(["preserve", fact.id, "--until", "1y", "-t", "alpha"], { from: "user" })).rejects.toThrow(
      "tag write boom",
    );

    const updated = db.getById(fact.id);
    expect(updated?.preserveUntil ?? null).toBe(originalPreserveUntil);
  });
});
