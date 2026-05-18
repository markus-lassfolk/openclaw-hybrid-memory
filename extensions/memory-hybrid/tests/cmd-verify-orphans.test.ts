/**
 * cmd-verify orphan reconciliation helpers and runVerifyForCli --reconcile wiring.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import { hybridConfigSchema } from "../config.js";
import { computeVectorSqliteOrphans } from "../cli/cmd-verify.js";

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return { ...actual, capturePluginError: vi.fn() };
});

const { VectorDB, FactsDB } = _testing;
const DIM = 3;

function makeVector(): number[] {
  return new Array(DIM).fill(0).map(() => Math.random());
}

describe("computeVectorSqliteOrphans", () => {
  it("reports no orphans when ID sets match", () => {
    const ids = ["a", "b"];
    const report = computeVectorSqliteOrphans(ids, ids);
    expect(report.vectorOrphans).toEqual([]);
    expect(report.sqliteOrphans).toEqual([]);
  });

  it("detects vector-only and sqlite-only orphans", () => {
    const report = computeVectorSqliteOrphans(["sqlite-1", "sqlite-2"], ["sqlite-1", "vector-only"]);
    expect(report.vectorOrphans).toEqual(["vector-only"]);
    expect(report.sqliteOrphans).toEqual(["sqlite-2"]);
  });
});

describe("runVerifyForCli --reconcile", () => {
  let tmpDir: string;
  let homeDir: string;
  let factsDb: InstanceType<typeof FactsDB>;
  let vectorDb: InstanceType<typeof VectorDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cmd-verify-reconcile-"));
    homeDir = mkdtempSync(join(tmpdir(), "oc-home-verify-"));
    const openclawDir = join(homeDir, ".openclaw");
    mkdirSync(join(openclawDir, "cron"), { recursive: true });
    writeFileSync(
      join(openclawDir, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { model: { primary: "openai/gpt-4.1-mini" } } } }, null, 2),
    );
    writeFileSync(join(openclawDir, "cron", "jobs.json"), JSON.stringify({ jobs: [] }), "utf-8");
    vi.stubEnv("HOME", homeDir);

    factsDb = new FactsDB(join(tmpDir, "facts.db"));
    vectorDb = new VectorDB(join(tmpDir, "lance"), DIM);
  });

  afterEach(async () => {
    factsDb.close();
    await vectorDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function buildCtx() {
    const cfg = hybridConfigSchema.parse({
      mode: "local",
      verbosity: "normal",
      embedding: { provider: "ollama", model: "nomic-embed-text", dimensions: DIM },
      llm: { default: ["openai/gpt-4.1-mini"] },
    });
    return {
      cfg,
      factsDb,
      vectorDb,
      embeddings: {
        dimensions: DIM,
        embed: vi.fn().mockResolvedValue(makeVector()),
        modelName: "nomic-embed-text",
      },
      credentialsDb: null,
      resolvedSqlitePath: join(tmpDir, "facts.db"),
      resolvedLancePath: join(tmpDir, "lance"),
      openai: null,
    };
  }

  it("runVerifyForCli completes smoke check with temp openclaw.json", async () => {
    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await expect(
      runVerifyForCli(buildCtx() as never, { fix: false }, { log: (m) => lines.push(m) }),
    ).resolves.toBeUndefined();
    expect(lines.join("\n")).toMatch(/SQLite|sqlite/i);
  });

  it("reports in-sync reconciliation when SQLite and LanceDB IDs align", async () => {
    const id = factsDb.store({ text: "synced", category: "fact", source: "test" }).id;
    await vectorDb.store({ id, text: "synced", vector: makeVector(), importance: 0.5, category: "fact" });

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: false, reconcile: true }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");
    expect(out).toContain("Reconciliation");
    expect(out).toMatch(/in sync|SQLite and LanceDB are in sync/i);
  });

  it("reports vector orphans during reconcile when LanceDB has extra IDs", async () => {
    const orphanId = "aaaaaaaa-0000-4000-8000-000000000099";
    await vectorDb.store({
      id: orphanId,
      text: "orphan",
      vector: makeVector(),
      importance: 0.5,
      category: "fact",
    });

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: false, reconcile: true }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");
    expect(out).toMatch(/Vector orphans|orphan vector/i);
    expect(out).toContain(orphanId);
  });
});
