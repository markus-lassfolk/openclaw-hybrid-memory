/**
 * cmd-verify orphan reconciliation helpers and runVerifyForCli --reconcile wiring.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    process.exitCode = undefined;
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
    const id = factsDb.store({
      text: "synced",
      category: "fact",
      source: "test",
      entity: null,
      key: null,
      value: null,
      importance: 0.5,
    }).id;
    await vectorDb.store({ id, text: "synced", vector: makeVector(), importance: 0.5, category: "fact" });

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: false, reconcile: true }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");
    expect(out).toContain("Reconciliation");
    expect(out).toMatch(/ID sets aligned|in sync/i);
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

  it("verify --reconcile --fix reports incomplete when delete has no effect", async () => {
    const orphanId = "bbbbbbbb-0000-4000-8000-000000000099";
    await vectorDb.store({
      id: orphanId,
      text: "orphan-noop",
      vector: makeVector(),
      importance: 0.5,
      category: "fact",
    });

    // VectorDB prefers deleteMany(); mock success without removing rows so post-check reports incomplete.
    vi.spyOn(vectorDb, "deleteMany").mockResolvedValue(1);

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: true, reconcile: true }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("Delete attempted for 1 orphan vector(s)");
    expect(out).toMatch(/Reconciliation incomplete/i);
    expect(out).toContain("unresolved");
  });

  it("verify --reconcile --fix confirms orphan vector deletions by re-querying LanceDB", async () => {
    const orphanId = "cccccccc-0000-4000-8000-000000000099";
    await vectorDb.store({
      id: orphanId,
      text: "orphan-success",
      vector: makeVector(),
      importance: 0.5,
      category: "fact",
    });

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(buildCtx() as never, { fix: true, reconcile: true }, { log: (m) => lines.push(m) });
    const out = lines.join("\n");

    expect(out).toContain("Delete attempted for 1 orphan vector(s)");
    expect(out).toContain("Verified removal: 1/1 orphan vector(s) are gone.");
    expect((await vectorDb.getAllIds()).includes(orphanId)).toBe(false);
  });

  function storeSqliteOnlyFacts(count: number): void {
    for (let i = 0; i < count; i++) {
      factsDb.store({
        text: `sqlite-only fact ${i}`,
        category: "fact",
        source: "test",
        entity: null,
        key: null,
        value: null,
        importance: 0.5,
      });
    }
  }

  it("honors an explicit --reconcile-max-fixes as a hard cap even under aggressive policy", async () => {
    storeSqliteOnlyFacts(10);

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(
      buildCtx() as never,
      { fix: true, reconcile: true, reconcilePolicy: "aggressive", reconcileMaxFixes: 3 },
      { log: (m) => lines.push(m) },
    );
    const out = lines.join("\n");

    expect(out).toContain("rebuilt 3/3 SQLite orphan vector(s)");
    expect(out).toContain("Skipped 7 SQLite orphan(s) due to --reconcile-max-fixes budget.");
  });

  it("widens the SQLite-orphan rebuild budget to 2000 under aggressive policy when the flag is omitted", async () => {
    storeSqliteOnlyFacts(10);

    const { runVerifyForCli } = await import("../cli/handlers.js");
    const lines: string[] = [];
    await runVerifyForCli(
      buildCtx() as never,
      { fix: true, reconcile: true, reconcilePolicy: "aggressive" },
      { log: (m) => lines.push(m) },
    );
    const out = lines.join("\n");

    expect(out).toContain("rebuilt 10/10 SQLite orphan vector(s)");
    expect(out).not.toContain("due to --reconcile-max-fixes budget");
  });

  it("sets process.exitCode when vector orphans are reported without --fix", async () => {
    process.exitCode = undefined;
    const orphanId = "dddddddd-0000-4000-8000-000000000099";
    await vectorDb.store({
      id: orphanId,
      text: "orphan-no-fix",
      vector: makeVector(),
      importance: 0.5,
      category: "fact",
    });

    const { runVerifyForCli } = await import("../cli/handlers.js");
    await runVerifyForCli(buildCtx() as never, { fix: false, reconcile: true }, { log: () => {} });

    expect(process.exitCode).toBe(1);
  });

  it("sets process.exitCode when SQLite orphans (facts missing vectors) are reported", async () => {
    process.exitCode = undefined;
    storeSqliteOnlyFacts(1);

    const { runVerifyForCli } = await import("../cli/handlers.js");
    await runVerifyForCli(buildCtx() as never, { fix: false, reconcile: true }, { log: () => {} });

    expect(process.exitCode).toBe(1);
  });
});
