// @ts-nocheck
/**
 * Regression tests for #2088: `hybrid-mem smoke e2e` CLI wiring.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { VectorDB } from "../backends/vector-db.js";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageSmoke } from "../cli/commands/manage/register-smoke.js";

const DIM = 3;

function makeFakeEmbeddings() {
  return {
    embed: vi.fn(async (text: string) => (text.includes("companion record") ? [0, 1, 0] : [1, 0, 0])),
    embedBatch: vi.fn(async (texts: string[]) =>
      texts.map((t) => (t.includes("companion record") ? [0, 1, 0] : [1, 0, 0])),
    ),
    dimensions: DIM,
    modelName: "fake-smoke-embed-3d",
  };
}

describe("smoke e2e CLI (#2088)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;
  let logs: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-smoke-cli-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vectorDb = new VectorDB(join(tmpDir, "lance"), DIM);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });
  });

  afterEach(() => {
    factsDb.close();
    vectorDb.close();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProgram(): Command {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerManageSmoke(mem, {
      factsDb,
      vectorDb,
      embeddings: makeFakeEmbeddings(),
    } as unknown as ManageBindings);
    return mem;
  }

  it("--json emits the full structured result and exits 0 on success", async () => {
    const mem = makeProgram();
    await mem.parseAsync(["smoke", "e2e", "--json"], { from: "user" });

    const result = JSON.parse(logs.join(""));
    expect(result.overall).toBe("pass");
    expect(result.steps.length).toBeGreaterThan(0);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("human-readable mode prints per-step lines and an overall verdict", async () => {
    const mem = makeProgram();
    await mem.parseAsync(["smoke", "e2e"], { from: "user" });

    expect(logs.some((l) => l.includes("Smoke E2E (run"))).toBe(true);
    expect(logs.some((l) => l.includes("store-facts"))).toBe(true);
    expect(logs.some((l) => l.includes("Overall: ✅ pass"))).toBe(true);
  });

  it("sets exit code 1 when a step fails, and prints manual-cleanup hints for leftovers", async () => {
    const mem = new Command("hybrid-mem");
    mem.exitOverride();
    registerManageSmoke(mem, {
      factsDb,
      vectorDb,
      embeddings: {
        ...makeFakeEmbeddings(),
        embed: vi.fn(async () => {
          throw new Error("embed down");
        }),
      },
    } as unknown as ManageBindings);

    await mem.parseAsync(["smoke", "e2e"], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(logs.some((l) => l.includes("Overall: ❌ fail"))).toBe(true);
    // Cleanup still succeeds even when an earlier step fails, so no manual-cleanup section should print.
    expect(logs.some((l) => l.includes("Manual remediation"))).toBe(false);
  });
});
