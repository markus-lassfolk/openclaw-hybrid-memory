/**
 * Regression tests (loop iteration 75) for two bugs in cli/commands/manage/register-storage-maintenance.ts:
 *
 * 1. `--json` mode on rebuild-aliases / repair-vectors / classification-artifacts returned before
 *    the error-check block that sets `process.exitCode = 2`, so a run with real errors reported
 *    them faithfully in the JSON body but exited 0 — silently defeating any automation/CI script
 *    gating on the command's exit code.
 * 2. `classification-artifacts --apply`'s pagination intentionally keeps offset at 0 while a batch
 *    supersedes at least one fact (the active set shrinks under it) — but a still-active *verified*
 *    fact in that same window gets re-fetched and re-processed on every such iteration, and without
 *    a dedup guard was pushed into verifiedSkippedIds once per re-fetch instead of once overall.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerStorageGroup } from "../cli/commands/manage/register-storage-maintenance.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";

describe("storage classification-artifacts / rebuild-aliases (loop iteration 75 regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function makeProgram(bindings: Partial<ManageBindings>): Command {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerStorageGroup(mem, bindings as unknown as ManageBindings);
    return mem;
  }

  it("does not push a verified fact into verifiedSkippedIds more than once across offset-pinned re-fetches", async () => {
    let facts = [
      { id: "verified-fact", text: "noop", category: "noop", source: "test" },
      { id: "artifact-a", text: "noop", category: "noop", source: "test" },
    ];
    const supersede = vi.fn((id: string) => {
      facts = facts.filter((f) => f.id !== id);
    });
    const vectorDelete = vi.fn().mockResolvedValue(undefined);
    const rawDb = {
      prepare: () => ({
        get: (id: string) => (id === "verified-fact" ? { 1: 1 } : undefined),
      }),
    };
    const factsDb = {
      getBatch: vi.fn((offset: number, limit: number) => facts.slice(offset, offset + limit)),
      supersede,
      getRawDb: () => rawDb,
    };
    const vectorDb = { delete: vectorDelete };
    const mem = makeProgram({ factsDb, vectorDb, ctx: { resolvedSqlitePath: null } } as never);
    let jsonOutput = "";
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      if (typeof msg === "string") jsonOutput += msg;
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await mem.parseAsync(["classification-artifacts", "--apply", "--json"], { from: "user" });

    // "verified-fact" must never actually be superseded, and artifact-a must have been (proving
    // the batch re-fetch at offset 0 genuinely happened, exercising the duplication window).
    expect(supersede).not.toHaveBeenCalledWith("verified-fact", null);
    expect(supersede).toHaveBeenCalledWith("artifact-a", null);

    const report = JSON.parse(jsonOutput) as { verifiedSkippedIds: string[] };
    expect(report.verifiedSkippedIds).toEqual(["verified-fact"]);
  });

  it("sets process.exitCode when classification-artifacts --apply --json has vector-delete errors", async () => {
    let facts = [{ id: "artifact-a", text: "noop", category: "noop", source: "test" }];
    // Must actually remove the fact from the active set on supersede, mirroring real FactsDB
    // behavior — otherwise the offset-pinned retry (offset stays 0 while a batch supersedes
    // something) re-processes the same fact forever.
    const supersede = vi.fn((id: string) => {
      facts = facts.filter((f) => f.id !== id);
    });
    const vectorDelete = vi.fn().mockRejectedValue(new Error("vector delete boom"));
    const factsDb = {
      getBatch: vi.fn((offset: number, limit: number) => facts.slice(offset, offset + limit)),
      supersede,
    };
    const vectorDb = { delete: vectorDelete };
    const mem = makeProgram({ factsDb, vectorDb, ctx: { resolvedSqlitePath: null } } as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await mem.parseAsync(["classification-artifacts", "--apply", "--json"], { from: "user" });

    expect(process.exitCode).toBe(2);
  });

  it("sets process.exitCode when rebuild-aliases --json reports errors", async () => {
    const aliasDb = {
      getLanceDiagnostics: vi.fn().mockResolvedValue({ schemaValid: true, configuredDim: 4, lanceDim: 4 }),
      rebuildLanceFromSqlite: vi.fn().mockResolvedValue({
        stored: 1,
        skipped: 0,
        reEmbedded: 0,
        errors: ["alias xyz: embed failed"],
      }),
    };
    const mem = makeProgram({ aliasDb, embeddings: {} } as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await mem.parseAsync(["rebuild-aliases", "--json"], { from: "user" });

    expect(process.exitCode).toBe(2);
  });
});
