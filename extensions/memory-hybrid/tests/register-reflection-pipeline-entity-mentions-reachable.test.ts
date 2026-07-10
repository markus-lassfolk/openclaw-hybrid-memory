/**
 * Regression test (#2067-followup) for cli/commands/manage/register-reflection-pipeline.ts:
 *
 * The `entity-mentions audit`/`entity-mentions cleanup` subcommands were registered inside
 * `if (registerReflect) { if (registerIngest) { ... } }`. Every real caller of
 * registerManageReflectionPipeline() passes exactly one of `onlyReflect`/`onlyQuality`/
 * `onlyIngest`, which makes `registerReflect` and `registerIngest` mutually exclusive in
 * practice -- so the nested condition was never satisfied and `entity-mentions` was
 * unreachable from any real CLI invocation. It has been moved into the top-level
 * `if (registerIngest)` block (the same one that registers `backfill`/`ingest`/etc.) so it is
 * reachable whenever ingest commands are registered, independent of `registerReflect`.
 */
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageReflectionPipeline } from "../cli/commands/manage/register-reflection-pipeline.js";

// `{ onlyIngest: true }` mirrors the *only* real call site that wires up entity-mentions'
// sibling ingest commands (register-corrections-and-pipeline.ts). Registering with no opts at
// all would make both registerReflect and registerIngest true regardless of which block the
// command lives in, masking the bug this test guards against.
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

describe("register-reflection-pipeline entity-mentions reachability (#2067-followup)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("registers 'entity-mentions audit' and invokes factsDb.auditEntityMentions", async () => {
    const auditEntityMentions = vi.fn(() => ({
      factsScanned: 5,
      rowsScanned: 10,
      accepted: 8,
      rejected: 2,
      duplicates: 0,
      reclassified: 0,
      rejectReasons: {},
    }));
    const mem = makeProgram({ factsDb: { auditEntityMentions } as unknown as ManageBindings["factsDb"] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["entity-mentions", "audit", "--limit", "50"], { from: "user" });

    expect(auditEntityMentions).toHaveBeenCalledWith(50);
    expect(process.exitCode).toBeUndefined();
  });

  it("registers 'entity-mentions cleanup' and invokes factsDb.cleanupEntityMentions", async () => {
    const cleanupEntityMentions = vi.fn(() => ({
      factsScanned: 5,
      changedFacts: 1,
      removedRows: 1,
      duplicates: 0,
      rejected: 0,
      reclassified: 0,
      rejectReasons: {},
    }));
    const mem = makeProgram({ factsDb: { cleanupEntityMentions } as unknown as ManageBindings["factsDb"] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["entity-mentions", "cleanup", "--limit", "50", "--apply"], { from: "user" });

    expect(cleanupEntityMentions).toHaveBeenCalledWith({ limit: 50, apply: true });
    expect(process.exitCode).toBeUndefined();
  });
});
