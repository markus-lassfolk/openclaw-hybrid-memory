// @ts-nocheck
/**
 * Regression tests for #2098's `digest batch-reject` CLI command: validation errors, dry-run
 * preview output, --json output, and --yes actually rejecting through the real ProposalsDB.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalsDB } from "../backends/proposals-db.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageDigest } from "../cli/commands/manage/register-digest.js";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

function makeProgram(factsDb: InstanceType<typeof FactsDB>, sqlitePath: string): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  const cfg = hybridConfigSchema.parse({
    embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test-key-12345678" },
    sqlitePath,
    personaProposals: { enabled: true },
  });
  registerManageDigest(mem, { factsDb, cfg } as unknown as ManageBindings);
  return mem;
}

describe("digest batch-reject CLI (#2098)", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-digest-batch-reject-"));
    const sqlitePath = join(tmpDir, "facts.db");
    db = new FactsDB(sqlitePath);
    return { mem: makeProgram(db, sqlitePath), sqlitePath };
  }

  it("rejects an invalid --queue value", async () => {
    const { mem } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mem.parseAsync(["digest", "batch-reject", "--queue", "bogus", "--older-than", "30d"], { from: "user" });
    expect(process.exitCode).toBe(1);
  });

  it("requires at least one filter", async () => {
    const { mem } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mem.parseAsync(["digest", "batch-reject", "--queue", "persona"], { from: "user" });
    expect(process.exitCode).toBe(1);
  });

  it("rejects a malformed --older-than instead of silently defaulting", async () => {
    const { mem } = setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await mem.parseAsync(["digest", "batch-reject", "--queue", "persona", "--older-than", "banana"], {
      from: "user",
    });
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("--older-than"))).toBe(true);
  });

  it("rejects an out-of-range --max-confidence", async () => {
    const { mem } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mem.parseAsync(["digest", "batch-reject", "--queue", "persona", "--max-confidence", "1.5"], {
      from: "user",
    });
    expect(process.exitCode).toBe(1);
  });

  it("dry-run previews candidates without mutating, then --yes applies and rejects only those ids", async () => {
    const { mem } = setup();
    const store = new ProposalsDB(join(tmpDir, "proposals.db"));
    const stale = store.create({
      targetFile: "A.md",
      title: "Stale one",
      observation: "o",
      suggestedChange: "c",
      confidence: 0.9,
      evidenceSessions: [],
    });
    const fresh = store.create({
      targetFile: "B.md",
      title: "Fresh one",
      observation: "o",
      suggestedChange: "c",
      confidence: 0.9,
      evidenceSessions: [],
    });
    store.close();
    const raw = new (await import("node:sqlite")).DatabaseSync(join(tmpDir, "proposals.db"));
    raw
      .prepare("UPDATE proposals SET created_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000) - 45 * 86400, stale.id);
    raw.close();

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    await mem.parseAsync(["digest", "batch-reject", "--queue", "persona", "--older-than", "30d"], { from: "user" });
    expect(logs.some((l) => l.includes("Would reject 1/2"))).toBe(true);
    expect(logs.some((l) => l.includes(stale.id))).toBe(true);

    const afterDryRun = new ProposalsDB(join(tmpDir, "proposals.db"));
    expect(afterDryRun.get(stale.id)?.status).toBe("pending");
    afterDryRun.close();

    logs.length = 0;
    await mem.parseAsync(["digest", "batch-reject", "--queue", "persona", "--older-than", "30d", "--yes"], {
      from: "user",
    });
    expect(logs.some((l) => l.includes("Rejected 1/1"))).toBe(true);

    const afterApply = new ProposalsDB(join(tmpDir, "proposals.db"));
    expect(afterApply.get(stale.id)?.status).toBe("rejected");
    expect(afterApply.get(fresh.id)?.status).toBe("pending");
    afterApply.close();
  });

  it("--json emits structured preview output in dry-run mode", async () => {
    const { mem } = setup();
    const store = new ProposalsDB(join(tmpDir, "proposals.db"));
    store.create({
      targetFile: "A.md",
      title: "Low conf",
      observation: "o",
      suggestedChange: "c",
      confidence: 0.1,
      evidenceSessions: [],
    });
    store.close();

    let jsonOut = "";
    vi.spyOn(console, "log").mockImplementation((arg) => {
      jsonOut = String(arg);
    });

    await mem.parseAsync(["digest", "batch-reject", "--queue", "persona", "--max-confidence", "0.3", "--json"], {
      from: "user",
    });

    const parsed = JSON.parse(jsonOut);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.queue).toBe("persona");
    expect(parsed.candidates).toHaveLength(1);
  });
});
