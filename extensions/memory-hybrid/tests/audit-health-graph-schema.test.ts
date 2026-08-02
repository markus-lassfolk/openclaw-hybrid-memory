/**
 * Regression coverage for #2226 ("health cron: graph_schema_ok=false ... schema check silently
 * failing"). Investigation found no existing check anywhere in this repo that validates the
 * memory graph's schema (`memory_links`), and `audit health --json` never carried a plugin
 * version field at all — so a downstream health monitor reading either signal from this plugin's
 * CLI output had nothing well-defined to read. This file covers the two additions that close that
 * gap:
 *
 *  1. report.pluginVersion / report.dbSchemaVersion are always present (fixes "version:unknown").
 *  2. report.graphSchema surfaces memory_links structural health, and a failed check is pushed
 *     into report.warnings (always) and report.errors (when the table itself is missing), which
 *     in turn flips buildAuditHealthExitInfo's exit code non-zero in --strict/--strict-errors.
 *
 * A separate CLI-level test (audit-health-graph-schema-alert.test.ts) covers the capturePluginError
 * (GlitchTip) alerting wired up in register-storage-graph-audit.ts's runAuditHealth.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildAuditHealthReport } from "../cli/commands/manage/storage-stats-helpers.js";
import { buildAuditHealthExitInfo } from "../services/audit-health-exit-info.js";
import { versionInfo } from "../versionInfo.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

describe("buildAuditHealthReport version fields (#2226)", () => {
  it("always carries pluginVersion and dbSchemaVersion", () => {
    const db = new FactsDB(":memory:");
    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    expect(report.pluginVersion).toBe(versionInfo.pluginVersion);
    expect(typeof report.pluginVersion).toBe("string");
    expect(report.pluginVersion.length).toBeGreaterThan(0);
    expect(report.dbSchemaVersion).toBe(versionInfo.schemaVersion);
    db.close();
  });
});

describe("buildAuditHealthReport graphSchema (#2226)", () => {
  let db: InstanceType<typeof FactsDB> | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("reports graphSchema.ok=true and no warning on a healthy store", () => {
    db = new FactsDB(":memory:");
    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    expect(report.graphSchema).not.toBeNull();
    expect(report.graphSchema?.ok).toBe(true);
    expect(report.warnings.some((w) => w.includes("Memory graph schema check failed"))).toBe(false);
    expect(report.errors.some((e) => e.section === "graphSchema")).toBe(false);
    db.close();
  });

  it("surfaces a warning AND an error (non-zero strict exit) when memory_links is missing", () => {
    db = new FactsDB(":memory:");
    db.getRawDb().exec("DROP TABLE memory_links");

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    expect(report.graphSchema).toEqual({
      tableExists: false,
      presentColumns: [],
      missingColumns: expect.arrayContaining(["id", "source_fact_id", "target_fact_id"]),
      presentIndexes: [],
      missingIndexes: expect.arrayContaining(["idx_links_source", "idx_links_target"]),
      ok: false,
    });
    // This is the field this issue's diagnosis section maps to `graph_schema_ok`.
    expect(report.graphSchema?.ok).toBe(false);

    const warning = report.warnings.find((w) => w.includes("Memory graph schema check failed"));
    expect(warning).toBeDefined();
    expect(warning).toContain("memory_links table is missing");

    const error = report.errors.find((e) => e.section === "graphSchema");
    expect(error).toBeDefined();
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.status).toBe("partial");

    // Acceptance criterion: --strict / --strict-errors must exit non-zero, not silently pass.
    const exitInfo = buildAuditHealthExitInfo({
      strict: true,
      strictErrorsOnly: true,
      warningCount: report.warningCount,
      errorCount: report.errorCount,
      ok: report.ok,
      status: report.status,
    });
    expect(exitInfo.exitCode).toBe(2);
    expect(exitInfo.exitReason).toBe("strict_errors");

    db.close();
  });

  it("surfaces a warning but no graphSchema error when only a column is missing (table still present)", () => {
    db = new FactsDB(":memory:");
    const raw = db.getRawDb();
    raw.exec("DROP TABLE memory_links");
    raw.exec(`
      CREATE TABLE memory_links (
        id TEXT PRIMARY KEY,
        source_fact_id TEXT NOT NULL,
        target_fact_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL
      )
    `);

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    expect(report.graphSchema?.ok).toBe(false);
    expect(report.graphSchema?.tableExists).toBe(true);
    expect(report.graphSchema?.missingColumns).toEqual(["strength_updated_at"]);

    const warning = report.warnings.find((w) => w.includes("Memory graph schema check failed"));
    expect(warning).toBeDefined();
    expect(warning).toContain("missing column(s): strength_updated_at");

    // Degraded-but-present is a warning, not a hard error — table exists so traversal still works.
    expect(report.errors.some((e) => e.section === "graphSchema")).toBe(false);

    db.close();
  });
});
