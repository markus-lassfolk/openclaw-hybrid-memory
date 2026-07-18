/** Tests for the manual-run Loom CLI: `belief sweep-stale` and `loom maintenance` (#2150 follow-up). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { LoomStore } from "../backends/loom-store.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageLoom } from "../cli/commands/manage/register-loom.js";
import { parseConfig } from "../config/parsers/index.js";

let tmpDir: string;
let factsDb: FactsDB;
let loomStore: LoomStore;

const cfg = parseConfig({ embedding: { provider: "ollama", model: "nomic-embed-text" } });

function makeProgram(overrides: Partial<ManageBindings>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageLoom(mem, { cfg, factsDb, loomStore, ...overrides } as unknown as ManageBindings);
  return mem;
}

function storeFact(text: string): { id: string } {
  return factsDb.store({
    text,
    category: "project",
    importance: 0.5,
    source: "conversation",
    entity: null,
    key: null,
    value: null,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "loom-maint-cli-test-"));
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

describe("hybrid-mem belief sweep-stale (#2150)", () => {
  it("degrades stale claims and reports the count as JSON", async () => {
    const claim = loomStore.assertClaim({ entity: "Z", predicate: "k", value: "v" });
    loomStore.verifyClaim(claim.id, { at: "2020-01-01T00:00:00.000Z" });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(String(msg)));

    const mem = makeProgram({});
    await mem.parseAsync(["belief", "sweep-stale", "--json"], { from: "user" });

    expect(JSON.parse(logs.join("\n")).degraded).toBe(1);
    expect(loomStore.getClaim(claim.id)?.status).toBe("stale");
  });

  it("errors clearly when the Loom is disabled (no loomStore)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mem = makeProgram({ loomStore: null as unknown as LoomStore });
    await expect(mem.parseAsync(["belief", "sweep-stale"], { from: "user" })).rejects.toThrow(/Loom is disabled/);
  });
});

describe("hybrid-mem loom maintenance (#2150)", () => {
  it("runs the sweep + drift scan and is report-only by default", async () => {
    const claim = loomStore.assertClaim({ entity: "Z", predicate: "k", value: "v" });
    loomStore.verifyClaim(claim.id, { at: "2020-01-01T00:00:00.000Z" });
    const fact = storeFact("Run `hybrid-mem old-cmd` for the weekly report.");

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(String(msg)));

    // No drift map configured in cfg, so pass one via a config override to exercise the scan path.
    const cfgWithDrift = parseConfig({
      embedding: { provider: "ollama", model: "nomic-embed-text" },
      loom: { drift: { deprecatedCommands: { "old-cmd": "new-cmd" } } },
    });
    const mem = makeProgram({ cfg: cfgWithDrift as never });
    await mem.parseAsync(["loom", "maintenance", "--json"], { from: "user" });

    const result = JSON.parse(logs.join("\n"));
    expect(result.ran).toBe(true);
    expect(result.staleDegraded).toBe(1);
    expect(result.driftApplied).toBe(0); // report-only
    // Fact text left untouched in report-only mode.
    expect(factsDb.getAll({ includeSuperseded: true }).find((f) => f.id === fact.id)?.text).toContain("old-cmd");
  });
});
