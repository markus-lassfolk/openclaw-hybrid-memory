import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapFactsCoreSchema } from "../backends/facts-db/schema-bootstrap.js";
import { runFactsMigrations } from "../backends/migrations/facts-migrations.js";
import { WorkflowStore } from "../backends/workflow-store.js";
import {
  buildSchemaRegistry,
  diffMissingColumns,
  findUnknownSqlColumnViolations,
  ingestSchemaDdl,
  parseSqlAliasMap,
  resolveQualifierToTable,
  runtimeSchemaFromDb,
} from "./helpers/sql-schema-extract.js";
import {
  getSchemaRegistry,
  resetSchemaRegistryCache,
  scanAllSqlGuardrailViolations,
} from "./helpers/sql-guardrails.js";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("sql schema extract", () => {
  it("parses CREATE TABLE and ALTER TABLE ADD COLUMN from DDL snippets", () => {
    const registry = new Map<string, Set<string>>();
    ingestSchemaDdl(
      `
      CREATE TABLE IF NOT EXISTS verified_facts (
        id TEXT PRIMARY KEY,
        fact_id TEXT NOT NULL,
        next_verification TEXT
      );
      ALTER TABLE verified_facts ADD COLUMN version INTEGER DEFAULT 1;
    `,
      registry,
    );
    expect(registry.get("verified_facts")).toEqual(new Set(["id", "fact_id", "next_verification", "version"]));
  });

  it("resolves table aliases from FROM/JOIN clauses", () => {
    const sql = `
      SELECT vf.fact_id, f.tier
      FROM facts f
      JOIN verified_facts vf ON vf.fact_id = f.id
    `;
    const aliases = parseSqlAliasMap(sql);
    expect(aliases.get("f")).toBe("facts");
    expect(aliases.get("vf")).toBe("verified_facts");
    expect(resolveQualifierToTable("vf", aliases, new Map())).toBe("verified_facts");
  });

  it("flags unknown qualified columns against the registry", () => {
    const registry = new Map<string, Set<string>>([["verified_facts", new Set(["fact_id", "next_verification"])]]);
    const bad = `
      db.prepare(\`
        SELECT vf.fact_id FROM verified_facts vf WHERE vf.tier = ?
      \`).get("critical");
    `;
    const violations = findUnknownSqlColumnViolations(bad, "bad.ts", registry);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("tier");
  });

  it("ignores unresolved subquery aliases (no false positives)", () => {
    const registry = new Map<string, Set<string>>([["verified_facts", new Set(["fact_id", "version"])]]);
    const ok = `
      db.prepare(\`
        SELECT latest.max_version
        FROM verified_facts vf
        INNER JOIN (
          SELECT fact_id, MAX(version) AS max_version FROM verified_facts GROUP BY fact_id
        ) latest ON latest.fact_id = vf.fact_id
      \`).all();
    `;
    expect(findUnknownSqlColumnViolations(ok, "ok.ts", registry)).toEqual([]);
  });
});

describe("sql schema registry — static vs runtime", () => {
  let factsDb: DatabaseSync;
  let wfTmp: string;
  let wfStore: WorkflowStore;

  beforeEach(() => {
    resetSchemaRegistryCache();
    factsDb = new DatabaseSync(":memory:");
    bootstrapFactsCoreSchema(factsDb);
    runFactsMigrations(factsDb);

    wfTmp = mkdtempSync(join(tmpdir(), "schema-guard-wf-"));
    wfStore = new WorkflowStore(join(wfTmp, "workflow.db"));
  });

  afterEach(() => {
    wfStore.close();
    factsDb.close();
    rmSync(wfTmp, { recursive: true, force: true });
  });

  it("static DDL registry includes core facts.db tables after migrations", () => {
    const staticRegistry = buildSchemaRegistry(PLUGIN_ROOT);
    expect(staticRegistry.has("facts")).toBe(true);
    expect(staticRegistry.get("facts")!.has("tier")).toBe(true);
    expect(staticRegistry.get("verified_facts")!.has("next_verification")).toBe(true);
    expect(staticRegistry.has("workflow_traces")).toBe(true);
  });

  it("static registry covers all columns present in migrated facts.db", () => {
    const staticRegistry = buildSchemaRegistry(PLUGIN_ROOT);
    const runtime = runtimeSchemaFromDb(factsDb);
    const missing = diffMissingColumns(runtime, staticRegistry).filter(
      (m) => staticRegistry.has(m.table) && !m.table.includes("_fts_"),
    );
    expect(missing).toEqual([]);
  });

  it("static registry covers workflow_traces columns at runtime", () => {
    const staticRegistry = buildSchemaRegistry(PLUGIN_ROOT);
    const wfDb = new DatabaseSync(join(wfTmp, "workflow.db"));
    try {
      const runtime = runtimeSchemaFromDb(wfDb);
      const missing = diffMissingColumns(runtime, staticRegistry).filter((m) => m.table === "workflow_traces");
      expect(missing).toEqual([]);
    } finally {
      wfDb.close();
    }
  });
});

describe("sql schema guardrails — full codebase scan", () => {
  beforeEach(() => {
    resetSchemaRegistryCache();
  });

  it("schema registry is built once and reused", () => {
    const a = getSchemaRegistry(PLUGIN_ROOT);
    const b = getSchemaRegistry(PLUGIN_ROOT);
    expect(a).toBe(b);
    expect(a.size).toBeGreaterThan(20);
  });

  it("finds no unknown qualified SQL columns in scanned sources", () => {
    const violations = scanAllSqlGuardrailViolations(PLUGIN_ROOT).filter((v) => v.rule === "unknown-sql-column");
    expect(violations).toEqual([]);
  });
});
