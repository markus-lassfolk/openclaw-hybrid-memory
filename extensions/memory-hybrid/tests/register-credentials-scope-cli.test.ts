/**
 * `credentials migrate-to-vault` must set a non-zero exit code when migration reports errors,
 * and `scope prune` must clean up vectors for the facts it actually deleted (not a pre-delete
 * snapshot) and must set a non-zero exit code when that vector cleanup fails.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerManageCredentialsAndScope } from "../cli/commands/manage/register-credentials-scope.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

function makeProgram(bindings: Record<string, unknown>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageCredentialsAndScope(mem, bindings as unknown as ManageBindings);
  return mem;
}

describe("credentials migrate-to-vault exit code", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("sets process.exitCode when migration reports errors", async () => {
    const runMigrateToVault = vi.fn().mockResolvedValue({ migrated: 2, skipped: 0, errors: ["boom"] });
    const mem = makeProgram({ runMigrateToVault, factsDb: {}, vectorDb: {} });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["credentials", "migrate-to-vault"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });

  it("leaves process.exitCode unset when migration has no errors", async () => {
    const runMigrateToVault = vi.fn().mockResolvedValue({ migrated: 2, skipped: 0, errors: [] });
    const mem = makeProgram({ runMigrateToVault, factsDb: {}, vectorDb: {} });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["credentials", "migrate-to-vault"], { from: "user" });

    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("scope prune vector cleanup", () => {
  let db: InstanceType<typeof FactsDB>;

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function storeGlobalFact(text: string) {
    return db.store({
      text,
      category: "other",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "conversation",
      scope: "global",
    });
  }

  it("cleans up vectors for the facts actually deleted, not a stale pre-delete snapshot", async () => {
    db = new FactsDB(":memory:");
    const fact = storeGlobalFact("existing global fact");

    // listScopedFactIdsPendingPrune (used only for --dry-run) is spied to prove the actual,
    // non-dry-run delete path no longer depends on it for vector cleanup — a stale snapshot from
    // this helper could otherwise miss a fact added between listing and the real delete.
    const staleSnapshotSpy = vi.spyOn(db, "listScopedFactIdsPendingPrune");
    const deleteSpy = vi.fn().mockResolvedValue(true);

    const mem = makeProgram({ factsDb: db, vectorDb: { delete: deleteSpy } });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["scope", "prune", "--scope", "global", "--yes"], { from: "user" });

    expect(staleSnapshotSpy).not.toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledWith(fact.id);
    expect(db.getById(fact.id)).toBeNull();
  });

  it("sets process.exitCode when post-delete vector cleanup fails", async () => {
    db = new FactsDB(":memory:");
    storeGlobalFact("fact to prune");

    const mem = makeProgram({
      factsDb: db,
      vectorDb: {
        delete: vi.fn().mockRejectedValue(new Error("lance down")),
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["scope", "prune", "--scope", "global", "--yes"], { from: "user" });

    expect(process.exitCode).toBe(2);
  });
});
