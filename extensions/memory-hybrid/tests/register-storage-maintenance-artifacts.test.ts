/**
 * `storage classification-artifacts --apply` must never delete a fact's vector unless the fact
 * was actually superseded first — otherwise a supersede failure after a successful vector delete
 * leaves an active fact with no vector (an unrecoverable-by-itself "SQLite orphan").
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerStorageGroup } from "../cli/commands/manage/register-storage-maintenance.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";

describe("storage classification-artifacts --apply ordering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeProgram(bindings: Partial<ManageBindings>): Command {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerStorageGroup(mem, bindings as unknown as ManageBindings);
    return mem;
  }

  it("does not delete the vector for a fact whose supersede call fails", async () => {
    let facts = [
      { id: "artifact-ok", text: "noop", category: "noop", source: "test" },
      { id: "artifact-fails", text: "noop", category: "noop", source: "test" },
    ];
    const supersede = vi.fn((id: string) => {
      if (id === "artifact-fails") throw new Error("supersede boom");
      facts = facts.filter((f) => f.id !== id);
    });
    const vectorDelete = vi.fn().mockResolvedValue(undefined);
    const factsDb = {
      getBatch: vi.fn((offset: number, limit: number) => facts.slice(offset, offset + limit)),
      supersede,
    };
    const vectorDb = { delete: vectorDelete };
    const mem = makeProgram({ factsDb, vectorDb, ctx: { resolvedSqlitePath: null } } as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await mem.parseAsync(["classification-artifacts", "--apply"], { from: "user" });

    expect(supersede).toHaveBeenCalledWith("artifact-ok", null);
    expect(supersede).toHaveBeenCalledWith("artifact-fails", null);
    // Only the fact that was actually superseded should have its vector deleted.
    expect(vectorDelete).toHaveBeenCalledTimes(1);
    expect(vectorDelete).toHaveBeenCalledWith("artifact-ok");
  });
});
