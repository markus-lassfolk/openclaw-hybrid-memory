// @ts-nocheck
/**
 * Regression test for #2098: `digest pending` only accepted `--format json`, unlike sibling
 * commands (`digest autopilot`, `digest autopilot-cron`) which already use `--json`. Add a
 * `--json` boolean alias that behaves identically to `--format json`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    personaProposals: { enabled: false },
  });
  registerManageDigest(mem, { factsDb, cfg } as unknown as ManageBindings);
  return mem;
}

describe("digest pending --json alias (#2098)", () => {
  let tmpDir: string;
  let db: InstanceType<typeof FactsDB>;

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--json produces the same output as --format json", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-digest-json-"));
    const sqlitePath = join(tmpDir, "facts.db");
    db = new FactsDB(sqlitePath);

    const jsonFlagOutput: string[] = [];
    const memJsonFlag = makeProgram(db, sqlitePath);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      jsonFlagOutput.push(String(chunk));
      return true;
    });
    await memJsonFlag.parseAsync(["digest", "pending", "--json"], { from: "user" });
    vi.restoreAllMocks();

    const formatFlagOutput: string[] = [];
    const memFormatFlag = makeProgram(db, sqlitePath);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      formatFlagOutput.push(String(chunk));
      return true;
    });
    await memFormatFlag.parseAsync(["digest", "pending", "--format", "json"], { from: "user" });
    vi.restoreAllMocks();

    // generatedAt is a live timestamp — every other field must match exactly.
    const { generatedAt: _jsonGeneratedAt, ...jsonFlagParsed } = JSON.parse(jsonFlagOutput.join(""));
    const { generatedAt: _formatGeneratedAt, ...formatFlagParsed } = JSON.parse(formatFlagOutput.join(""));
    expect(jsonFlagParsed).toEqual(formatFlagParsed);
    expect(jsonFlagParsed.schemaVersion).toBe(1);
    expect(jsonFlagParsed.personaProposals.ageHygiene).toBeDefined();
  });

  it("--json takes precedence when both --json and --format md are passed", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-digest-json-"));
    const sqlitePath = join(tmpDir, "facts.db");
    db = new FactsDB(sqlitePath);

    const output: string[] = [];
    const mem = makeProgram(db, sqlitePath);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    await mem.parseAsync(["digest", "pending", "--json", "--format", "md"], { from: "user" });

    expect(() => JSON.parse(output.join(""))).not.toThrow();
  });

  it("without --json, --format md still renders markdown", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-digest-json-"));
    const sqlitePath = join(tmpDir, "facts.db");
    db = new FactsDB(sqlitePath);

    const output: string[] = [];
    const mem = makeProgram(db, sqlitePath);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    await mem.parseAsync(["digest", "pending"], { from: "user" });

    expect(output.join("")).toContain("# Hybrid-memory pending digest");
  });
});
