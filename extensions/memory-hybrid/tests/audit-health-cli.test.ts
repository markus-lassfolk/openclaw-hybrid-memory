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

import {
  buildAuditHealthReport,
  recordStorageGrowthSample,
} from "../cli/commands/manage/register-storage-and-stats.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

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

  it("recordStorageGrowthSample inserts once per UTC day", () => {
    const db = new FactsDB(":memory:");
    const a = recordStorageGrowthSample(db as never, 4096);
    expect(a.inserted).toBe(true);
    const b = recordStorageGrowthSample(db as never, 8192);
    expect(b.inserted).toBe(false);
    db.close();
  });
});
