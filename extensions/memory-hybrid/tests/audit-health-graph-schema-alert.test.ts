// @ts-nocheck
/**
 * Regression test for #2226 ("Add alerting: When graph_schema_ok === false, emit a GlitchTip
 * error or set a non-zero health exit code"). Exercises the actual `audit health` CLI handler
 * (runAuditHealth in register-storage-graph-audit.ts) end-to-end — not just buildAuditHealthReport
 * in isolation — so both halves of the fix are covered together:
 *
 *  1. capturePluginError is called (subsystem "storage-graph-audit") so the failure reaches
 *     GlitchTip instead of only living in an in-memory report object nobody inspects.
 *  2. `--strict` sets a non-zero exit code instead of exiting 0 despite the broken schema.
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

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return { ...actual, capturePluginError: vi.fn() };
});

import { capturePluginError } from "../services/error-reporter.js";

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

describe("audit health graph-schema alerting (#2226)", () => {
  let db: InstanceType<typeof FactsDB>;
  let tmpDir: string;

  afterEach(() => {
    db?.close();
    vi.clearAllMocks();
    process.exitCode = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not call capturePluginError for graph schema on a healthy store", async () => {
    db = new FactsDB(":memory:");
    const mem = makeProgram(db);

    await mem.parseAsync(["audit-health", "--json"], { from: "user" });

    const graphSchemaCalls = vi
      .mocked(capturePluginError)
      .mock.calls.filter((call) => call[1]?.subsystem === "storage-graph-audit");
    expect(graphSchemaCalls).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
  });

  it("reports graphSchema.ok=false, alerts via capturePluginError, and exits non-zero under --strict when memory_links is missing", async () => {
    db = new FactsDB(":memory:");
    db.getRawDb().exec("DROP TABLE memory_links");

    tmpDir = mkdtempSync(join(tmpdir(), "audit-health-graph-schema-"));
    const outputPath = join(tmpDir, "audit-health.json");

    const mem = makeProgram(db);
    await mem.parseAsync(["audit-health", "--json", "--strict", "--output", outputPath], { from: "user" });

    const report = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(report.graphSchema.ok).toBe(false);
    expect(report.graphSchema.tableExists).toBe(false);
    expect(report.exitCode).toBe(2);

    const graphSchemaCalls = vi
      .mocked(capturePluginError)
      .mock.calls.filter((call) => call[1]?.subsystem === "storage-graph-audit");
    expect(graphSchemaCalls).toHaveLength(1);
    expect(graphSchemaCalls[0][1]).toMatchObject({
      operation: "audit-health-graph-schema",
      subsystem: "storage-graph-audit",
      severity: "error",
    });
    expect(String(graphSchemaCalls[0][0])).toContain("Memory graph schema check failed");

    // The CLI's own exit code must also go non-zero — a wrapper polling exit code alone (not
    // parsing JSON) must still see the failure.
    expect(process.exitCode).toBe(2);
  });
});
