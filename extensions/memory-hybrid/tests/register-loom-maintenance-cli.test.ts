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

describe("hybrid-mem Loom CLI parity commands", () => {
  it("exposes direct live-check require/satisfy and loop update commands", async () => {
    const claim = loomStore.assertClaim({ entity: "Doris", predicate: "auth", value: "unknown" });
    const loop = loomStore.createOpenLoop({ title: "Verify auth", loopType: "needs_verification" });

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(String(msg)));

    const mem = makeProgram({});
    await mem.parseAsync(["live-checks", "require", claim.id.slice(0, 8), "--reason", "mutable", "--check", "whoami"], {
      from: "user",
    });
    await mem.parseAsync(["loops", "update", loop.id.slice(0, 8), "--status", "blocked", "--next", "wait"], {
      from: "user",
    });

    expect(loomStore.getClaim(claim.id)?.liveCheckRequired).toBe(true);
    expect(loomStore.getClaim(claim.id)?.suggestedChecks[0]?.text).toBe("whoami");
    expect(loomStore.getOpenLoop(loop.id)?.status).toBe("blocked");
    expect(loomStore.getOpenLoop(loop.id)?.nextAction).toBe("wait");
    expect(logs.join("\n")).toContain("requires a live check");
    expect(logs.join("\n")).toContain("Updated");
  });

  it("verifies evidence capsules and updates drift findings from the CLI", async () => {
    const capsule = loomStore.createEvidenceCapsule({
      content: {
        title: "proof",
        claim: "claim",
        evidence: [],
        commandsRun: [],
        artifacts: [],
        unverifiedItems: [],
        riskFlags: [],
        limits: undefined,
        redactionCount: 0,
        redacted: false,
      },
    });
    const finding = loomStore.createDriftFinding({ driftType: "deprecated_command", oldText: "old-cmd" });

    vi.spyOn(console, "log").mockImplementation(() => {});

    const mem = makeProgram({});
    await mem.parseAsync(["evidence", "verify", capsule.id.slice(0, 8), "--at", "2026-01-01T00:00:00.000Z"], {
      from: "user",
    });
    await mem.parseAsync(["drift", "update", finding.id.slice(0, 8), "--status", "acknowledged"], { from: "user" });

    expect(loomStore.getEvidenceCapsule(capsule.id)?.verifiedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(loomStore.getDriftFinding(finding.id)?.status).toBe("acknowledged");
  });

  it("keeps drift scout report-only by default and rejects conflicting dry-run/apply flags", async () => {
    storeFact("Run `old-cmd` for reports.");
    const cfgWithDrift = parseConfig({
      embedding: { provider: "ollama", model: "nomic-embed-text" },
      loom: { drift: { deprecatedCommands: { "old-cmd": "new-cmd" } } },
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const mem = makeProgram({ cfg: cfgWithDrift as never });
    await mem.parseAsync(["drift", "scout", "--dry-run", "--json"], { from: "user" });
    expect(factsDb.getAll({ includeSuperseded: true })[0]?.text).toContain("old-cmd");

    await expect(mem.parseAsync(["drift", "scout", "--dry-run", "--apply-safe"], { from: "user" })).rejects.toThrow(
      /Choose either --dry-run or --apply-safe/,
    );
  });

  it("documents debug/verbose and exposes no blanket force flag in Loom help", () => {
    const mem = makeProgram({});
    const liveChecks = mem.commands.find((c) => c.name() === "live-checks");
    expect(liveChecks).toBeTruthy();
    const help = liveChecks?.helpInformation() ?? "";
    expect(help).toContain("--verbose");
    expect(help).toContain("--debug");
    expect(help).not.toContain("--force");
  });
});
