import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatTimestampUtc } from "../utils/dates.js";
import { TEXT_TIMESTAMP_COLUMN_SPECS } from "../utils/timestamp-migration.js";
import {
  GUARDRAIL_SCAN_ROOTS,
  findIsoTextColumnRawEpochBindViolations,
  scanAllSqlGuardrailViolations,
} from "./helpers/sql-guardrails.js";
import { findUnknownSqlColumnViolations } from "./helpers/sql-schema-extract.js";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("SQL guardrails — cross-cutting regression patterns", () => {
  it("covers backends, services, cli, and benchmark (not just the original bug sites)", () => {
    expect(GUARDRAIL_SCAN_ROOTS).toEqual(["backends", "services", "cli", "benchmark"]);
  });

  it("uses a canonical ISO TEXT column registry for timestamp comparisons", () => {
    expect(TEXT_TIMESTAMP_COLUMN_SPECS.some((s) => s.table === "workflow_traces" && s.columns.includes("created_at")))
      .toBe(true);
    expect(
      TEXT_TIMESTAMP_COLUMN_SPECS.some(
        (s) => s.table === "verified_facts" && s.columns.includes("next_verification"),
      ),
    ).toBe(true);
  });

  it("finds no datetime(..., 'unixepoch') SQL anywhere in scanned sources", () => {
    const violations = scanAllSqlGuardrailViolations(PLUGIN_ROOT).filter((v) => v.rule === "no-datetime-unixepoch");
    expect(violations).toEqual([]);
  });

  it("does not bind raw sinceSec/nowSec to registered ISO TEXT timestamp columns", () => {
    const violations = scanAllSqlGuardrailViolations(PLUGIN_ROOT).filter(
      (v) => v.rule === "iso-text-column-raw-epoch-bind",
    );
    expect(violations).toEqual([]);
  });

  it("does not reference unknown SQL columns (schema-aware checker)", () => {
    const violations = scanAllSqlGuardrailViolations(PLUGIN_ROOT).filter((v) => v.rule === "unknown-sql-column");
    expect(violations).toEqual([]);
  });

  it("flags hypothetical verified_facts.tier references (detector sanity check)", () => {
    const registry = new Map<string, Set<string>>([
      ["verified_facts", new Set(["fact_id", "next_verification"])],
    ]);
    const bad = `
      db.prepare(\`SELECT vf.fact_id FROM verified_facts vf WHERE vf.tier = ?\`).get("critical");
    `;
    expect(findUnknownSqlColumnViolations(bad, "bad.ts", registry)).toHaveLength(1);
  });

  it("flags hypothetical raw-epoch binds on ISO columns (detector sanity check)", () => {
    const fakeSource = `
      db.prepare(\`SELECT COUNT(*) AS cnt FROM workflow_traces WHERE created_at >= ?\`)
        .get(sinceSec);
    `;
    expect(findIsoTextColumnRawEpochBindViolations(fakeSource, "fake.ts")).toHaveLength(1);
  });

  it("accepts formatTimestampUtc binds for ISO TEXT columns", () => {
    const okSource = `
      db.prepare(\`SELECT COUNT(*) AS cnt FROM workflow_traces WHERE created_at >= ?\`)
        .get(formatTimestampUtc(sinceSec));
    `;
    expect(findIsoTextColumnRawEpochBindViolations(okSource, "ok.ts")).toEqual([]);
  });
});

describe("ISO TEXT vs epoch — generic boundary behavior", () => {
  it("shows why ISO-Z columns must not be compared to SQLite datetime(...) strings", () => {
    const noonSec = Math.floor(Date.parse("2026-06-05T12:00:00.000Z") / 1000);
    const cutoffIso = formatTimestampUtc(noonSec);
    const morningIso = "2026-06-05T08:00:00.000Z";
    const afternoonIso = "2026-06-05T15:00:00.000Z";

    expect(morningIso >= cutoffIso).toBe(false);
    expect(afternoonIso >= cutoffIso).toBe(true);

    // Footgun: datetime(?, 'unixepoch') yields space-separated text, not ISO-Z — lexicographic false positives.
    const sqliteDatetimeCutoff = "2026-06-05 12:00:00";
    expect(morningIso >= sqliteDatetimeCutoff).toBe(true);
  });
});
