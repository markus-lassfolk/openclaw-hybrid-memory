/** Tests for the ranked procedure triage CLI wiring (#2147): `procedure triage --ranked` and `procedure promote-candidate`. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertProcedure } from "../backends/facts-db/procedures/crud.js";
import { FactsDB } from "../backends/facts-db.js";
import { LoomStore } from "../backends/loom-store.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageProcedureAndLifecycle } from "../cli/commands/manage/register-procedure-lifecycle.js";

let tmpDir: string;
let factsDb: FactsDB;
let loomStore: LoomStore;

function makeProgram(overrides: Partial<ManageBindings>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageProcedureAndLifecycle(mem, { cfg: {}, factsDb, loomStore, ...overrides } as unknown as ManageBindings);
  return mem;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "procedure-triage-cli-test-"));
  factsDb = new FactsDB(join(tmpDir, "memory.db"));
  loomStore = new LoomStore(join(tmpDir, "loom.db"));
});

afterEach(() => {
  factsDb.close();
  loomStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("procedure triage --ranked (#2147)", () => {
  it("emits a bounded, ranked JSON batch instead of the raw backlog", async () => {
    const db = factsDb.getRawDb();
    for (let i = 0; i < 10; i++) {
      upsertProcedure(db, { taskPattern: `task ${i}`, recipeJson: "{}", procedureType: "positive", successCount: 3 });
    }
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });

    const mem = makeProgram({});
    await mem.parseAsync(["procedure", "triage", "--ranked", "--batch", "5", "--json"], { from: "user" });

    const report = JSON.parse(logs.join("\n"));
    expect(report.backlog).toBe(10);
    expect(report.recommendedBatch.length).toBeLessThanOrEqual(5);
  });

  it("errors clearly when the Loom is disabled (no loomStore)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mem = makeProgram({ loomStore: null as unknown as LoomStore });
    await expect(mem.parseAsync(["procedure", "triage", "--ranked"], { from: "user" })).rejects.toThrow(
      /requires The Loom/,
    );
  });
});

describe("procedure promote-candidate (#2147)", () => {
  it("records a triage decision that suppresses the cluster on the next ranked triage", async () => {
    const db = factsDb.getRawDb();
    upsertProcedure(db, {
      taskPattern: "niche cli task",
      recipeJson: "{}",
      procedureType: "positive",
      successCount: 1,
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    const mem = makeProgram({});
    const first = loomStore.recordProcedureTriageDecision;
    void first;

    // Discover the cluster id via the service directly (CLI doesn't echo it back in non-JSON mode by default here).
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(msg));
    await mem.parseAsync(["procedure", "triage", "--ranked", "--json"], { from: "user" });
    const report = JSON.parse(logs.join(""));
    const clusterId = report.recommendedBatch[0]?.clusterId;
    expect(clusterId).toBeTruthy();

    await mem.parseAsync(
      ["procedure", "promote-candidate", clusterId, "--decision", "no_action", "--rationale", "too niche"],
      { from: "user" },
    );
    expect(loomStore.getProcedureTriageDecision(clusterId)?.decision).toBe("no_action");

    logs.length = 0;
    await mem.parseAsync(["procedure", "triage", "--ranked", "--json"], { from: "user" });
    const second = JSON.parse(logs.join(""));
    expect(second.recommendedBatch.find((c: { clusterId: string }) => c.clusterId === clusterId)).toBeUndefined();
  });

  it("dry-run does not record a decision", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mem = makeProgram({});
    await mem.parseAsync(["procedure", "promote-candidate", "cluster-x", "--decision", "no_action", "--dry-run"], {
      from: "user",
    });
    expect(loomStore.getProcedureTriageDecision("cluster-x")).toBeNull();
  });
});
