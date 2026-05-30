/**
 * Audit health CLI end-to-end coverage (#1193).
 *
 * Fabricates a minimal facts store and asserts that `--json` (i.e. the value returned by
 * `buildAuditHealthReport`) carries every schema field the dashboard / strict cron consumes.
 * We exercise the CLI surface indirectly by calling `buildAuditHealthReport` with the same
 * arguments the registration site passes (matches `runAuditHealth` in
 * `cli/commands/manage/register-storage-and-stats.ts`).
 */

import { describe, expect, it } from "vitest";

import { PROCEDURE_BLOCK_REASONS } from "../backends/facts-db/procedures.js";
import {
  buildAuditHealthReport,
  recordStorageGrowthSample,
} from "../cli/commands/manage/register-storage-and-stats.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

/** Insert a validated procedure row that will be blocked from promotion (success_count < threshold). */
function insertLowRecallProcedure(
  db: ReturnType<typeof FactsDB.prototype.getRawDb>,
  id: string,
  taskPattern: string,
): void {
  db?.prepare(
    `INSERT INTO procedures (id, task_pattern, recipe_json, procedure_type, success_count, failure_count, confidence, promoted_to_skill, last_validated, created_at, updated_at)
       VALUES (?, ?, ?, 'positive', 1, 0, 0.6, 0, strftime('%s','now'), strftime('%s','now'), strftime('%s','now'))`,
  ).run(id, taskPattern, JSON.stringify([{ tool: "bash", args: {} }]));
}

describe("buildAuditHealthReport — JSON schema (#1193)", () => {
  it("produces a versioned report with the expected top-level fields", () => {
    const db = new FactsDB(":memory:");
    db.store({
      text: "Audit health fact",
      category: "technical",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const report = buildAuditHealthReport(db as never, () => ["technical", "pattern"], [], 500, {
      lanceBytes: 4096,
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.status).toMatch(/^(ok|partial|failed)$/);
    expect(typeof report.ok).toBe("boolean");
    expect(typeof report.warningCount).toBe("number");
    expect(typeof report.errorCount).toBe("number");
    expect(report.activeFacts).toBeGreaterThanOrEqual(1);
    expect(report.storeAgeDays).toBeGreaterThanOrEqual(0);
    expect(report.canonicalEmbeddings).toBeGreaterThanOrEqual(0);
    expect(report.vectorless).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(report.vectorlessBySource)).toBe(true);
    expect(report.procedures).toMatchObject({
      total: expect.any(Number),
      validated: expect.any(Number),
      promoted: expect.any(Number),
      validatedNotPromoted: expect.any(Number),
      blocked: expect.any(Number),
    });
    expect(Array.isArray(report.graphHubs)).toBe(true);
    expect(typeof report.structuralEligibleWarmFacts).toBe("number");
    expect(report.patternBloat).toMatchObject({
      implicitFeedbackPatterns: expect.any(Number),
      implicitFeedbackPrefixHistogram: expect.any(Array),
    });
    expect(Array.isArray(report.entityStopwordMatches)).toBe(true);
    expect(Array.isArray(report.topEntitiesFiltered)).toBe(true);
    expect(report.storage).toMatchObject({
      sqliteBytes: expect.any(Number),
      lanceBytes: 4096,
    });
    const { lastSampleAt, delta7d, lanceBytesPerWeekDelta } = report.storageGrowth;
    expect(lastSampleAt).toEqual(expect.any(Number));
    expect(delta7d === null || typeof delta7d === "object").toBe(true);
    expect(lanceBytesPerWeekDelta === null || typeof lanceBytesPerWeekDelta === "number").toBe(true);
    expect(report.tiers).toBeTypeOf("object");
    expect(report.decay).toBeTypeOf("object");
    expect(report.stableStickiness).toMatchObject({
      stablePermanent: expect.any(Number),
      activeFacts: expect.any(Number),
      ratio: expect.any(Number),
    });
    expect(report.vectorIntegrity).toMatchObject({
      score: expect.any(Number),
      degraded: expect.any(Boolean),
      vectorlessRatio: expect.any(Number),
      orphanSignals: expect.any(Object),
    });
    expect(
      report.vectorIntegrity.degradedReason === null || typeof report.vectorIntegrity.degradedReason === "string",
    ).toBe(true);
    expect(report.vectorLifecycleSlo).toMatchObject({
      targets: expect.any(Object),
      breaches: expect.any(Array),
    });
    expect(Array.isArray(report.categories.unknown)).toBe(true);
    expect(report.categories).toMatchObject({
      configured: expect.any(Array),
      present: expect.any(Array),
      unknown: expect.any(Array),
    });
    expect(report.sources).toBeTypeOf("object");
    expect(typeof report.implicitFeedbackTrajectorySignals).toBe("number");
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(Array.isArray(report.remediation)).toBe(true);
    expect(Array.isArray(report.errors)).toBe(true);
    db.close();
  });

  it("returns drift counts (not just labels) for unknown categories", () => {
    const db = new FactsDB(":memory:");
    db.store({
      text: "Stray category fact",
      category: "off-roster",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    db.store({
      text: "Another stray fact",
      category: "off-roster",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    const drift = report.categories.unknown.find((row) => row.category === "off-roster");
    expect(drift).toBeDefined();
    expect(drift?.count).toBe(2);
    db.close();
  });

  it("does not flag hot=0 on a brand-new store (storeAgeDays gate)", () => {
    const db = new FactsDB(":memory:");
    db.store({
      text: "Just-installed fact",
      category: "technical",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    const hotWarn = report.warnings.find((w) => w.includes("HOT tier"));
    expect(hotWarn).toBeUndefined();
    db.close();
  });
  it("marks expensive sections partial when the audit-health deadline is exhausted", () => {
    const db = new FactsDB(":memory:");
    db.store({
      text: "Expired budget fact",
      category: "off-roster",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500, {
      timeoutMs: 1,
      startedAtMs: Date.now() - 10,
      deadlineMs: Date.now() - 1,
    });

    expect(report.status).toBe("partial");
    expect(report.ok).toBe(false);
    expect(report.timeoutMs).toBe(1);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(report.errors.some((e) => e.message.includes("timeout budget exceeded"))).toBe(true);
    expect(report.categories.unknown).toEqual([{ category: "off-roster", count: 0 }]);
    db.close();
  });

  it("suggests reflect-meta collapse when implicit-feedback pattern bloat is high", () => {
    const db = new FactsDB(":memory:");
    for (let i = 0; i < 1001; i++) {
      db.store({
        text: `implicit feedback pattern text ${i} for histogram`,
        category: "pattern",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "implicit-feedback",
      });
    }
    const report = buildAuditHealthReport(db as never, () => ["pattern"], [], 500);
    expect(report.remediation.some((r) => r.includes("reflect-meta --collapse-implicit-feedback"))).toBe(true);
    db.close();
  });

  it("adds decay reclassify remediation when stable+permanent ratio is high", () => {
    const db = new FactsDB(":memory:");
    for (let i = 0; i < 5; i++) {
      db.store({
        text: `Legacy stable ${i}`,
        category: "fact",
        importance: 0.5,
        entity: null,
        key: null,
        value: null,
        source: "test",
      });
    }
    const raw = db.getRawDb();
    raw?.prepare("UPDATE facts SET decay_class = 'stable' WHERE superseded_at IS NULL").run();

    const report = buildAuditHealthReport(db as never, () => ["fact"], [], 500);
    expect(report.warnings.some((w) => w.includes("stable+permanent"))).toBe(true);
    expect(report.remediation.some((r) => r.includes("decay reclassify --dry-run --stable-only"))).toBe(true);
    db.close();
  });

  it("recordStorageGrowthSample inserts once per UTC day", () => {
    const db = new FactsDB(":memory:");
    const a = recordStorageGrowthSample(db as never, 4096);
    expect(a.inserted).toBe(true);
    const b = recordStorageGrowthSample(db as never, 8192);
    expect(b.inserted).toBe(false);
    db.close();
  });

  it("warns and records entityStopwordMatches when stop-word entities appear among top entities", () => {
    const db = new FactsDB(":memory:");
    // Insert facts with stop-word-like entities (User, user, Credentials, convention)
    for (const entity of ["User", "user", "Credentials", "convention"]) {
      for (let i = 0; i < 3; i++) {
        db.store({
          text: `Fact about ${entity} number ${i}`,
          category: "technical",
          importance: 0.5,
          entity,
          key: null,
          value: null,
          source: "test",
        });
      }
    }

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    // All four stop-word entities must appear in entityStopwordMatches
    const matchedEntities = report.entityStopwordMatches.map((row) => row.entity.toLowerCase());
    expect(matchedEntities).toContain("user");
    expect(matchedEntities).toContain("credentials");
    expect(matchedEntities).toContain("convention");

    // Warning must be raised
    expect(report.warnings.some((w) => w.includes("stop-word-like labels"))).toBe(true);

    // Remediation must suggest entities clean
    expect(report.remediation.some((r) => r.includes("entities clean"))).toBe(true);

    // topEntitiesFiltered must not contain stop-word entities
    const filteredEntities = report.topEntitiesFiltered.map((row) => row.entity.toLowerCase());
    expect(filteredEntities).not.toContain("user");
    expect(filteredEntities).not.toContain("credentials");
    expect(filteredEntities).not.toContain("convention");

    db.close();
  });

  it("topEntitiesFiltered excludes stop-word entities and includes real ones", () => {
    const db = new FactsDB(":memory:");
    // Insert facts: some with stop-word entities, one with a meaningful entity
    for (let i = 0; i < 5; i++) {
      db.store({
        text: `Fact about MyProject ${i}`,
        category: "technical",
        importance: 0.5,
        entity: "MyProject",
        key: null,
        value: null,
        source: "test",
      });
    }
    for (let i = 0; i < 5; i++) {
      db.store({
        text: `Generic user fact ${i}`,
        category: "technical",
        importance: 0.5,
        entity: "user",
        key: null,
        value: null,
        source: "test",
      });
    }

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    const filteredEntities = report.topEntitiesFiltered.map((row) => row.entity);
    expect(filteredEntities).toContain("MyProject");
    expect(filteredEntities).not.toContain("user");

    db.close();
  });

  it("procedures.byBlockReason is present in report and contains all block reasons (#1739)", () => {
    const db = new FactsDB(":memory:");
    db.store({
      text: "Fact for byBlockReason test",
      category: "technical",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    expect(report.procedures.byBlockReason).toBeDefined();
    expect(typeof report.procedures.byBlockReason).toBe("object");
    // All standard block reasons must be present as keys.
    for (const reason of PROCEDURE_BLOCK_REASONS) {
      expect(reason in report.procedures.byBlockReason).toBe(true);
      expect(typeof report.procedures.byBlockReason[reason]).toBe("number");
    }
    db.close();
  });

  it("warning includes per-reason breakdown when validated procedures are blocked (#1739)", () => {
    const db = new FactsDB(":memory:");
    db.store({
      text: "Context fact",
      category: "technical",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    // Insert a validated procedure with low success_count so it is blocked with low_recall.
    insertLowRecallProcedure(db.getRawDb(), "proc-warn-1", "do something useful");

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    // The warning should show a breakdown like "low_recall=1" rather than just "top reason: low_recall".
    const procWarning = report.warnings.find((w) => w.includes("validated procedure(s) are not promoted"));
    expect(procWarning).toBeDefined();
    expect(procWarning).toMatch(/low_recall=\d+/);
    // Must NOT use the old "top reason:" format.
    expect(procWarning).not.toMatch(/top reason:/);
    db.close();
  });

  it("remediation includes low_recall hint when low-recall procedures are blocked (#1739)", () => {
    const db = new FactsDB(":memory:");
    db.store({
      text: "Context fact",
      category: "technical",
      importance: 0.5,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    insertLowRecallProcedure(db.getRawDb(), "proc-rem-1", "low recall task");

    const report = buildAuditHealthReport(db as never, () => ["technical"], [], 500);

    expect(report.remediation.some((r) => r.includes("low_recall"))).toBe(true);
    db.close();
  });
});
