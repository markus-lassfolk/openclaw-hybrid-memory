/**
 * Tests for Issue #148 — Memory Health Dashboard
 *
 * Coverage:
 *   - buildHealthReport: returns correct totalFacts count
 *   - buildHealthReport: returns correct activeFacts count (excludes expired)
 *   - buildHealthReport: supersededFacts counts facts with valid_until in the past
 *   - buildHealthReport: categoryDistribution groups active facts by category
 *   - buildHealthReport: decayClassDistribution groups all facts by decay class
 *   - buildHealthReport: tierDistribution groups all facts by tier
 *   - buildHealthReport: avgConfidence is the mean of active fact confidences
 *   - buildHealthReport: avgConfidence rounds to 3 decimal places
 *   - buildHealthReport: orphanFacts counts active facts with no links
 *   - buildHealthReport: orphanFacts excludes facts that are source of a link
 *   - buildHealthReport: orphanFacts excludes facts that are target of a link
 *   - buildHealthReport: staleFacts counts active facts with confidence < 0.3 and non-permanent
 *   - buildHealthReport: staleFacts excludes permanent decay-class facts
 *   - buildHealthReport: staleFacts excludes facts with confidence >= 0.3
 *   - buildHealthReport: totalLinks reflects row count in memory_links
 *   - buildHealthReport: avgLinksPerFact is computed as total_links*2 / activeFacts
 *   - buildHealthReport: avgLinksPerFact is 0 when activeFacts is 0
 *   - buildHealthReport: lastReflectionAt is null when no reflection facts exist
 *   - buildHealthReport: lastReflectionAt returns ISO string of most recent reflection fact
 *   - buildHealthReport: lastPruneAt is null when no superseded facts exist
 *   - buildHealthReport: generatedAt is a valid ISO date string
 *   - buildHealthReport: storageSizeBytes.sqlite is 0 for a non-existent path
 *   - registerHealthTools: does not register tool when health.enabled is false
 *   - registerHealthTools: registers tool when health.enabled is true
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildHealthReport, registerHealthTools } from "../tools/health-dashboard.js";
import { _testing } from "../index.js";

const { FactsDB } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(tmpDir: string): InstanceType<typeof FactsDB> {
  return new FactsDB(join(tmpDir, "facts.db"));
}

function storeMinimalFact(
  db: InstanceType<typeof FactsDB>,
  overrides: {
    text?: string;
    category?: string;
    decayClass?: "permanent" | "stable" | "active" | "session" | "checkpoint";
    confidence?: number;
    source?: string;
    tier?: string;
    validUntil?: number | null;
    expiresAt?: number | null;
  } = {},
) {
  const raw = db.getRawDb();
  const id = `test-${Math.random().toString(36).slice(2)}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const {
    text = "test fact",
    category = "fact",
    decayClass = "stable",
    confidence = 1.0,
    source = "conversation",
    tier = "warm",
    validUntil = null,
    expiresAt = null,
  } = overrides;
  raw
    .prepare(
      `INSERT INTO facts (id, text, category, importance, source, created_at, decay_class, confidence, tier, valid_until, expires_at)
     VALUES (?, ?, ?, 0.7, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, text, category, source, nowSec, decayClass, confidence, tier, validUntil, expiresAt);
  return id;
}

function addLink(db: InstanceType<typeof FactsDB>, sourceId: string, targetId: string, linkType = "RELATED_TO") {
  const raw = db.getRawDb();
  raw
    .prepare(
      `INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at)
       VALUES (?, ?, ?, ?, 1.0, ?)`,
    )
    .run(`link-${Math.random().toString(36).slice(2)}`, sourceId, targetId, linkType, Math.floor(Date.now() / 1000));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildHealthReport", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "health-test-"));
    factsDb = makeDb(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns correct totalFacts count", () => {
    storeMinimalFact(factsDb);
    storeMinimalFact(factsDb);
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.totalFacts).toBe(2);
  });

  it("returns correct activeFacts count (excludes expired)", () => {
    storeMinimalFact(factsDb); // active
    storeMinimalFact(factsDb, { expiresAt: 1 }); // expired (past epoch)
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.activeFacts).toBe(1);
  });

  it("supersededFacts counts facts with valid_until in the past", () => {
    storeMinimalFact(factsDb); // active
    storeMinimalFact(factsDb, { validUntil: 1 }); // superseded
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.supersededFacts).toBe(1);
  });

  it("categoryDistribution groups active facts by category", () => {
    storeMinimalFact(factsDb, { category: "preference" });
    storeMinimalFact(factsDb, { category: "preference" });
    storeMinimalFact(factsDb, { category: "fact" });
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.categoryDistribution.preference).toBe(2);
    expect(report.categoryDistribution.fact).toBe(1);
  });

  it("categoryDistribution excludes expired facts", () => {
    storeMinimalFact(factsDb, { category: "preference" });
    storeMinimalFact(factsDb, { category: "preference", expiresAt: 1 }); // expired
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.categoryDistribution.preference).toBe(1);
  });

  it("decayClassDistribution groups all facts by decay class", () => {
    storeMinimalFact(factsDb, { decayClass: "permanent" });
    storeMinimalFact(factsDb, { decayClass: "stable" });
    storeMinimalFact(factsDb, { decayClass: "stable" });
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.decayClassDistribution.permanent).toBe(1);
    expect(report.decayClassDistribution.stable).toBe(2);
  });

  it("tierDistribution groups all facts by tier", () => {
    storeMinimalFact(factsDb, { tier: "hot" });
    storeMinimalFact(factsDb, { tier: "warm" });
    storeMinimalFact(factsDb, { tier: "warm" });
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.tierDistribution.hot).toBe(1);
    expect(report.tierDistribution.warm).toBe(2);
  });

  it("avgConfidence is the mean of active fact confidences", () => {
    storeMinimalFact(factsDb, { confidence: 0.4 });
    storeMinimalFact(factsDb, { confidence: 0.6 });
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.avgConfidence).toBeCloseTo(0.5, 2);
  });

  it("avgConfidence rounds to 3 decimal places", () => {
    storeMinimalFact(factsDb, { confidence: 1.0 / 3 });
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    // Should be 0.333 (3 decimal places max)
    expect(report.avgConfidence.toString().split(".")[1]?.length ?? 0).toBeLessThanOrEqual(3);
  });

  it("orphanFacts counts active facts with no links", () => {
    storeMinimalFact(factsDb, { text: "alone" });
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.orphanFacts).toBe(1);
  });

  it("orphanFacts excludes facts that are source of a link", () => {
    const id1 = storeMinimalFact(factsDb, { text: "linked source" });
    const id2 = storeMinimalFact(factsDb, { text: "linked target" });
    addLink(factsDb, id1, id2);
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.orphanFacts).toBe(0);
  });

  it("orphanFacts excludes facts that are target of a link", () => {
    const id1 = storeMinimalFact(factsDb, { text: "source fact" });
    const id2 = storeMinimalFact(factsDb, { text: "target fact" });
    addLink(factsDb, id1, id2);
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.orphanFacts).toBe(0);
  });

  it("staleFacts counts active facts with confidence < 0.3 and non-permanent decay", () => {
    storeMinimalFact(factsDb, { confidence: 0.1, decayClass: "stable" });
    storeMinimalFact(factsDb, { confidence: 0.2, decayClass: "active" });
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.staleFacts).toBe(2);
  });

  it("staleFacts excludes permanent decay-class facts", () => {
    storeMinimalFact(factsDb, { confidence: 0.1, decayClass: "permanent" });
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.staleFacts).toBe(0);
  });

  it("staleFacts excludes facts with confidence >= 0.3", () => {
    storeMinimalFact(factsDb, { confidence: 0.3, decayClass: "stable" });
    storeMinimalFact(factsDb, { confidence: 0.9, decayClass: "stable" });
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.staleFacts).toBe(0);
  });

  it("totalLinks reflects row count in memory_links", () => {
    const id1 = storeMinimalFact(factsDb);
    const id2 = storeMinimalFact(factsDb);
    const id3 = storeMinimalFact(factsDb);
    addLink(factsDb, id1, id2);
    addLink(factsDb, id2, id3);
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.totalLinks).toBe(2);
  });

  it("avgLinksPerFact is computed as totalLinks*2 / activeFacts", () => {
    const id1 = storeMinimalFact(factsDb);
    const id2 = storeMinimalFact(factsDb);
    addLink(factsDb, id1, id2);
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    // 1 link * 2 / 2 facts = 1.0
    expect(report.avgLinksPerFact).toBeCloseTo(1.0, 2);
  });

  it("avgLinksPerFact is 0 when no active facts", () => {
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.avgLinksPerFact).toBe(0);
  });

  it("lastReflectionAt is null when no reflection facts exist", () => {
    storeMinimalFact(factsDb, { source: "conversation" });
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.lastReflectionAt).toBeNull();
  });

  it("lastReflectionAt returns ISO string of most recent reflection fact", () => {
    storeMinimalFact(factsDb, { source: "reflection" });
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.lastReflectionAt).not.toBeNull();
    expect(() => new Date(report.lastReflectionAt!)).not.toThrow();
  });

  it("lastPruneAt is null when no superseded facts exist", () => {
    storeMinimalFact(factsDb);
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.lastPruneAt).toBeNull();
  });

  it("generatedAt is a valid ISO date string", () => {
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(() => new Date(report.generatedAt)).not.toThrow();
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
  });

  it("storageSizeBytes.sqlite is 0 for a non-existent path", () => {
    const report = buildHealthReport(factsDb, "/nonexistent/path/facts.db", join(tmpDir, "lance"));
    expect(report.storageSizeBytes.sqlite).toBe(0);
  });

  it("storageSizeBytes.lance is 0 for a non-existent directory", () => {
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), "/nonexistent/lance/dir");
    expect(report.storageSizeBytes.lance).toBe(0);
  });

  it("storageSizeBytes.total is sqlite + lance", () => {
    const report = buildHealthReport(factsDb, join(tmpDir, "facts.db"), join(tmpDir, "lance"));
    expect(report.storageSizeBytes.total).toBe(report.storageSizeBytes.sqlite + report.storageSizeBytes.lance);
  });
});

// ---------------------------------------------------------------------------
// registerHealthTools tests
// ---------------------------------------------------------------------------

describe("registerHealthTools", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "health-reg-test-"));
    factsDb = makeDb(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not register tool when health.enabled is false", () => {
    const registered: string[] = [];
    const fakeApi = {
      registerTool: (def: { name: string }) => {
        registered.push(def.name);
      },
      logger: { info: () => {}, warn: () => {} },
    } as unknown as Parameters<typeof registerHealthTools>[1];

    registerHealthTools(
      {
        factsDb,
        cfg: { health: { enabled: false } } as unknown as import("../config.js").HybridMemoryConfig,
        resolvedSqlitePath: join(tmpDir, "facts.db"),
        resolvedLancePath: join(tmpDir, "lance"),
      },
      fakeApi,
    );

    expect(registered).not.toContain("memory_health");
  });

  it("registers memory_health tool when health.enabled is true", () => {
    const registered: string[] = [];
    const fakeApi = {
      registerTool: (def: { name: string }) => {
        registered.push(def.name);
      },
      logger: { info: () => {}, warn: () => {} },
    } as unknown as Parameters<typeof registerHealthTools>[1];

    registerHealthTools(
      {
        factsDb,
        cfg: { health: { enabled: true } } as unknown as import("../config.js").HybridMemoryConfig,
        resolvedSqlitePath: join(tmpDir, "facts.db"),
        resolvedLancePath: join(tmpDir, "lance"),
      },
      fakeApi,
    );

    expect(registered).toContain("memory_health");
  });
});
