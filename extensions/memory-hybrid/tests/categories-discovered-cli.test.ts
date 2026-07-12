// @ts-nocheck
/**
 * Regression test for #2100: `categories discovered [list|approve <label>|reject <label>]`
 * gives operators a discoverable review workflow for .discovered-categories.json instead of
 * only a raw-file bootstrap warning.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageStorageGraphAudit } from "../cli/commands/manage/register-storage-graph-audit.js";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

function makeProgram(factsDb: InstanceType<typeof FactsDB>, sqlitePath: string): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  const cfg = hybridConfigSchema.parse({
    embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test-key-12345678" },
    sqlitePath,
  });
  registerManageStorageGraphAudit(mem, {
    factsDb,
    vectorDb: {},
    getMemoryCategories: () => [],
    cfg,
    ctx: {},
  } as unknown as ManageBindings);
  return mem;
}

describe("categories discovered CLI (#2100)", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;
  let discoveredPath: string;

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-categories-discovered-cli-"));
    const sqlitePath = join(tmpDir, "facts.db");
    db = new FactsDB(sqlitePath);
    discoveredPath = join(tmpDir, ".discovered-categories.json");
    return sqlitePath;
  }

  it("reports no pending categories when the file does not exist", async () => {
    const sqlitePath = setup();
    const mem = makeProgram(db, sqlitePath);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["categories", "discovered"], { from: "user" });

    expect(lines.some((l) => l.includes("No discovered categories pending review"))).toBe(true);
  });

  it("lists pending labels and points at approve/reject commands", async () => {
    const sqlitePath = setup();
    writeFileSync(discoveredPath, JSON.stringify(["invoices", "travel"]), "utf-8");
    const mem = makeProgram(db, sqlitePath);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["categories", "discovered"], { from: "user" });

    expect(lines.some((l) => l.includes("invoices") && l.includes("travel"))).toBe(true);
    expect(lines.some((l) => l.includes("categories discovered approve"))).toBe(true);
    expect(lines.some((l) => l.includes("categories discovered reject"))).toBe(true);
  });

  it("--json emits path/pending/rejected", async () => {
    const sqlitePath = setup();
    writeFileSync(discoveredPath, JSON.stringify(["invoices"]), "utf-8");
    const mem = makeProgram(db, sqlitePath);
    let jsonOut = "";
    vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
      jsonOut = String(arg);
    });

    await mem.parseAsync(["categories", "discovered", "--json"], { from: "user" });

    const parsed = JSON.parse(jsonOut);
    expect(parsed.pending).toEqual(["invoices"]);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.path).toBe(discoveredPath);
  });

  it("approve removes the label from pending and prints a promotion pointer, not an auto-apply", async () => {
    const sqlitePath = setup();
    writeFileSync(discoveredPath, JSON.stringify(["invoices", "travel"]), "utf-8");
    const mem = makeProgram(db, sqlitePath);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });

    await mem.parseAsync(["categories", "discovered", "approve", "invoices"], { from: "user" });

    expect(process.exitCode ?? 0).toBe(0);
    expect(lines.some((l) => l.includes('Approved "invoices"'))).toBe(true);
    expect(lines.some((l) => l.includes("categories remap --from other --to invoices --apply"))).toBe(true);

    const listMem = makeProgram(db, sqlitePath);
    let jsonOut = "";
    vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
      jsonOut = String(arg);
    });
    await listMem.parseAsync(["categories", "discovered", "--json"], { from: "user" });
    expect(JSON.parse(jsonOut).pending).toEqual(["travel"]);
  });

  it("reject removes the label from pending and records it as rejected", async () => {
    const sqlitePath = setup();
    writeFileSync(discoveredPath, JSON.stringify(["invoices"]), "utf-8");
    const mem = makeProgram(db, sqlitePath);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await mem.parseAsync(["categories", "discovered", "reject", "invoices"], { from: "user" });

    expect(process.exitCode ?? 0).toBe(0);

    const listMem = makeProgram(db, sqlitePath);
    let jsonOut = "";
    vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
      jsonOut = String(arg);
    });
    await listMem.parseAsync(["categories", "discovered", "--json"], { from: "user" });
    const parsed = JSON.parse(jsonOut);
    expect(parsed.pending).toEqual([]);
    expect(parsed.rejected).toEqual(["invoices"]);
  });

  it("approving/rejecting a label that isn't pending exits non-zero with an error", async () => {
    const sqlitePath = setup();
    writeFileSync(discoveredPath, JSON.stringify(["travel"]), "utf-8");
    const mem = makeProgram(db, sqlitePath);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mem.parseAsync(["categories", "discovered", "approve", "nonexistent"], { from: "user" });

    expect(process.exitCode).toBe(1);
  });
});
