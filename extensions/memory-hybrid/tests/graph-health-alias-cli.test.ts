// @ts-nocheck
/**
 * Regression test for `graph health` (#2087): operators reasonably looked for a graph-consistency
 * health report under `hybrid-mem graph`, alongside `graph repair`, but the only registered
 * command was the top-level `audit health`. `graph health` (register-storage-graph-audit.ts) is a
 * pure discoverability alias that delegates to the exact same `runAuditHealth` handler as
 * `audit health` — this asserts both produce an identical report for the same store.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageBindings } from "../cli/commands/manage/bindings.js";
import { registerManageStorageGraphAudit } from "../cli/commands/manage/register-storage-graph-audit.js";
import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

const BASE_CFG = hybridConfigSchema.parse({
  embedding: { provider: "openai", model: "text-embedding-3-small", apiKey: "sk-test-key-12345678" },
});

function makeProgram(factsDb: InstanceType<typeof FactsDB>): Command {
  const mem = new Command("hybrid-mem");
  mem.exitOverride();
  registerManageStorageGraphAudit(mem, {
    factsDb,
    vectorDb: {},
    getMemoryCategories: () => [],
    cfg: BASE_CFG,
    ctx: {},
  } as unknown as ManageBindings);
  return mem;
}

describe("graph health alias (#2087)", () => {
  let db: InstanceType<typeof FactsDB>;
  let tmpDir: string;

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers `health` as a subcommand of `graph`, alongside `repair`", () => {
    db = new FactsDB(":memory:");
    const mem = makeProgram(db);
    const graph = mem.commands.find((c) => c.name() === "graph");
    expect(graph).toBeDefined();
    const subcommandNames = graph?.commands.map((c) => c.name()) ?? [];
    expect(subcommandNames).toContain("health");
    expect(subcommandNames).toContain("repair");
  });

  it("produces the same JSON report as `audit health` for the same store", async () => {
    db = new FactsDB(":memory:");
    db.store({
      text: "Graph health alias fact",
      category: "technical",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    tmpDir = mkdtempSync(join(tmpdir(), "graph-health-alias-"));
    const graphOutputPath = join(tmpDir, "graph-health.json");
    const auditOutputPath = join(tmpDir, "audit-health.json");

    const memGraph = makeProgram(db);
    await memGraph.parseAsync(["graph", "health", "--json", "--output", graphOutputPath], { from: "user" });

    const memAudit = makeProgram(db);
    await memAudit.parseAsync(["audit", "health", "--json", "--output", auditOutputPath], { from: "user" });

    // generatedAt/elapsedMs are live timing fields — every other field must match exactly.
    const {
      generatedAt: _graphGeneratedAt,
      elapsedMs: _graphElapsedMs,
      ...graphReport
    } = JSON.parse(readFileSync(graphOutputPath, "utf-8"));
    const {
      generatedAt: _auditGeneratedAt,
      elapsedMs: _auditElapsedMs,
      ...auditReport
    } = JSON.parse(readFileSync(auditOutputPath, "utf-8"));
    expect(graphReport).toEqual(auditReport);
    expect(graphReport.schemaVersion).toBe(1);
  });
});
