/**
 * Tests for Issue #165 — Monthly Knowledge Quality Review.
 *
 * Coverage:
 *   - Coverage analysis counts facts by category/entity
 *   - Top and sparse entity ranking
 *   - Quality trends: average confidence, previous month avg, stale facts, superseded facts
 *   - Contradiction counts
 *   - LLM recommendation synthesis + uncovered domains parsing
 *   - Empty knowledge base handling
 *   - Config parsing defaults + overrides
 *   - Graceful LLM failure (recommendations empty)
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hybridConfigSchema } from "../config.js";
import { _testing } from "../index.js";
import { MonthlyReviewService, runMonthlyReview } from "../services/monthly-review.js";

const { FactsDB } = _testing;

type DB = InstanceType<typeof FactsDB>;

function rawDb(db: DB) {
  return db.getRawDb();
}

function insertFact(
  db: DB,
  opts: {
    id?: string;
    text?: string;
    category?: string;
    entity?: string | null;
    confidence?: number;
    createdAtSec?: number;
    lastAccessedSec?: number | null;
    supersededAtSec?: number | null;
  },
): string {
  const id = opts.id ?? randomUUID();
  rawDb(db)
    .prepare(
      `INSERT INTO facts (id, text, category, importance, entity, key, value, source, created_at, confidence, last_accessed, superseded_at)
       VALUES (?, ?, ?, 0.7, ?, NULL, NULL, 'test', ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.text ?? `fact-${id}`,
      opts.category ?? "fact",
      opts.entity ?? null,
      opts.createdAtSec ?? Math.floor(Date.now() / 1000),
      opts.confidence ?? 0.8,
      opts.lastAccessedSec ?? null,
      opts.supersededAtSec ?? null,
    );
  return id;
}

function makeOpenAIMock(responses: Array<string | Error>) {
  const create = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) {
      create.mockImplementationOnce(async () => {
        throw response;
      });
    } else {
      create.mockImplementationOnce(async () => ({
        choices: [{ message: { content: response } }],
      }));
    }
  }
  return {
    chat: {
      completions: { create },
    },
  };
}

let tmpDir: string;
let db: DB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "monthly-review-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("MonthlyReviewService coverage analysis", () => {
  it("counts facts by category and entity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    insertFact(db, { category: "fact", entity: "Alpha" });
    insertFact(db, { category: "preference", entity: "Beta" });
    insertFact(db, { category: "preference", entity: "Alpha" });

    const openai = makeOpenAIMock(["", ""]);
    const report = await runMonthlyReview({
      factsDb: db,
      openai: openai as never,
      model: "openai/gpt-test",
    });

    expect(report.coverageAnalysis.totalFacts).toBe(3);
    expect(report.coverageAnalysis.factsByCategory.fact).toBe(1);
    expect(report.coverageAnalysis.factsByCategory.preference).toBe(2);
    expect(report.coverageAnalysis.topEntities[0]).toEqual({ entity: "Alpha", count: 2 });
  });

  it("ranks top and sparse entities correctly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    insertFact(db, { entity: "A" });
    insertFact(db, { entity: "A" });
    insertFact(db, { entity: "A" });
    insertFact(db, { entity: "B" });
    insertFact(db, { entity: "C" });
    insertFact(db, { entity: "C" });

    const openai = makeOpenAIMock(["", ""]);
    const report = await new MonthlyReviewService(db, openai as never, "openai/gpt-test").runReview();

    expect(report.coverageAnalysis.topEntities[0]).toEqual({ entity: "A", count: 3 });
    expect(report.coverageAnalysis.sparseEntities[0]).toEqual({ entity: "B", count: 1 });
  });

  it("excludes superseded facts from coverage totals", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-06T12:00:00Z");
    vi.setSystemTime(now);
    const nowSec = Math.floor(now.getTime() / 1000);
    insertFact(db, { category: "fact", supersededAtSec: nowSec - 5 * 86_400 });
    insertFact(db, { category: "fact" });

    const openai = makeOpenAIMock(["", ""]);
    const report = await runMonthlyReview({
      factsDb: db,
      openai: openai as never,
      model: "openai/gpt-test",
    });

    expect(report.coverageAnalysis.totalFacts).toBe(1);
    expect(report.coverageAnalysis.factsByCategory.fact).toBe(1);
  });
});

describe("MonthlyReviewService quality trends", () => {
  it("computes average confidence and previous month average", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-06T12:00:00Z");
    vi.setSystemTime(now);
    const nowSec = Math.floor(now.getTime() / 1000);
    const fortyDaysAgo = nowSec - 40 * 86_400;
    const fiveDaysAgo = nowSec - 5 * 86_400;

    insertFact(db, { confidence: 0.2, createdAtSec: fortyDaysAgo });
    insertFact(db, { confidence: 0.8, createdAtSec: fortyDaysAgo });
    insertFact(db, { confidence: 0.6, createdAtSec: fiveDaysAgo });

    const openai = makeOpenAIMock(["", ""]);
    const report = await runMonthlyReview({
      factsDb: db,
      openai: openai as never,
      model: "openai/gpt-test",
    });

    expect(report.qualityTrends.averageConfidence).toBeCloseTo((0.2 + 0.8 + 0.6) / 3, 5);
    expect(report.qualityTrends.averageConfidencePreviousMonth).toBeCloseTo((0.2 + 0.8) / 2, 5);
  });

  it("counts stale facts (last accessed 90+ days)", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-06T12:00:00Z");
    vi.setSystemTime(now);
    const nowSec = Math.floor(now.getTime() / 1000);
    const ninetyOneDaysAgo = nowSec - 91 * 86_400;
    const tenDaysAgo = nowSec - 10 * 86_400;

    insertFact(db, { lastAccessedSec: ninetyOneDaysAgo });
    insertFact(db, { lastAccessedSec: null });
    insertFact(db, { lastAccessedSec: tenDaysAgo });

    const openai = makeOpenAIMock(["", ""]);
    const report = await runMonthlyReview({
      factsDb: db,
      openai: openai as never,
      model: "openai/gpt-test",
    });

    expect(report.qualityTrends.staleFacts).toBe(2);
  });

  it("counts recently superseded facts (last 30 days)", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-06T12:00:00Z");
    vi.setSystemTime(now);
    const nowSec = Math.floor(now.getTime() / 1000);

    insertFact(db, { supersededAtSec: nowSec - 10 * 86_400 });
    insertFact(db, { supersededAtSec: nowSec - 40 * 86_400 });

    const openai = makeOpenAIMock(["", ""]);
    const report = await runMonthlyReview({
      factsDb: db,
      openai: openai as never,
      model: "openai/gpt-test",
    });

    expect(report.qualityTrends.recentlySuperseded).toBe(1);
  });

  it("uses unresolved contradictions count", async () => {
    insertFact(db, { id: "old-1" });
    insertFact(db, { id: "new-1" });
    insertFact(db, { id: "old-2" });
    insertFact(db, { id: "new-2" });
    rawDb(db)
      .prepare(
        `INSERT INTO contradictions (id, fact_id_old, fact_id_new, detected_at, resolved, resolution)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), "old-1", "new-1", new Date().toISOString(), 0, null);
    rawDb(db)
      .prepare(
        `INSERT INTO contradictions (id, fact_id_old, fact_id_new, detected_at, resolved, resolution)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), "old-2", "new-2", new Date().toISOString(), 1, null);

    const openai = makeOpenAIMock(["", ""]);
    const report = await runMonthlyReview({
      factsDb: db,
      openai: openai as never,
      model: "openai/gpt-test",
    });

    expect(report.qualityTrends.contradictionCount).toBe(1);
  });
});

describe("MonthlyReviewService LLM synthesis", () => {
  it("parses recommendations and uncovered domains", async () => {
    insertFact(db, { entity: "Alpha" });
    const openai = makeOpenAIMock([
      "1. Add more coverage on billing.\n- Review stale preferences.\n* Audit contradictions monthly.",
      "Billing systems\nSecurity posture\nRelease management",
    ]);

    const report = await runMonthlyReview({
      factsDb: db,
      openai: openai as never,
      model: "openai/gpt-test",
    });

    expect(report.recommendations).toEqual([
      "Add more coverage on billing.",
      "Review stale preferences.",
      "Audit contradictions monthly.",
    ]);
    expect(report.coverageAnalysis.uncoveredDomains).toEqual([
      "Billing systems",
      "Security posture",
      "Release management",
    ]);
  });

  it("limits recommendations to 10 items", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `Recommendation ${i + 1}`).join("\n");
    const openai = makeOpenAIMock([lines, ""]);

    const report = await runMonthlyReview({
      factsDb: db,
      openai: openai as never,
      model: "openai/gpt-test",
    });

    expect(report.recommendations).toHaveLength(10);
  });

  it("returns empty recommendations on LLM failure", async () => {
    const openai = makeOpenAIMock([new Error("boom"), new Error("boom")]);

    const report = await runMonthlyReview({
      factsDb: db,
      openai: openai as never,
      model: "openai/gpt-test",
    });

    expect(report.recommendations).toEqual([]);
    expect(report.coverageAnalysis.uncoveredDomains).toEqual([]);
  });
});

describe("MonthlyReviewService edge cases", () => {
  it("returns zeroed report for empty knowledge base", async () => {
    const openai = makeOpenAIMock(["", ""]);
    const report = await runMonthlyReview({
      factsDb: db,
      openai: openai as never,
      model: "openai/gpt-test",
    });

    expect(report.coverageAnalysis.totalFacts).toBe(0);
    expect(report.coverageAnalysis.topEntities).toEqual([]);
    expect(report.qualityTrends.averageConfidence).toBe(0);
    expect(report.qualityTrends.averageConfidencePreviousMonth).toBe(0);
  });

  it("returns report structure with required fields", async () => {
    const openai = makeOpenAIMock(["", ""]);
    const report = await runMonthlyReview({
      factsDb: db,
      openai: openai as never,
      model: "openai/gpt-test",
    });

    expect(typeof report.generatedAt).toBe("string");
    expect(report.coverageAnalysis).toHaveProperty("factsByCategory");
    expect(report.coverageAnalysis).toHaveProperty("uncoveredDomains");
    expect(report.qualityTrends).toHaveProperty("recentlySuperseded");
    expect(Array.isArray(report.recommendations)).toBe(true);
  });
});

describe("MonthlyReviewConfig parsing", () => {
  const BASE_CONFIG = {
    embedding: { apiKey: "sk-test-key-long-enough", model: "text-embedding-3-small" },
  };

  it("defaults to disabled with dayOfMonth=1", () => {
    const cfg = hybridConfigSchema.parse(BASE_CONFIG);
    expect(cfg.maintenance.monthlyReview.enabled).toBe(false);
    expect(cfg.maintenance.monthlyReview.dayOfMonth).toBe(1);
    expect(cfg.maintenance.monthlyReview.model).toBeUndefined();
  });

  it("parses enabled + model + dayOfMonth", () => {
    const cfg = hybridConfigSchema.parse({
      ...BASE_CONFIG,
      maintenance: { monthlyReview: { enabled: true, model: "openai/gpt-test", dayOfMonth: 15 } },
    });
    expect(cfg.maintenance.monthlyReview.enabled).toBe(true);
    expect(cfg.maintenance.monthlyReview.model).toBe("openai/gpt-test");
    expect(cfg.maintenance.monthlyReview.dayOfMonth).toBe(15);
  });

  it("clamps invalid dayOfMonth values", () => {
    const low = hybridConfigSchema.parse({
      ...BASE_CONFIG,
      maintenance: { monthlyReview: { enabled: true, dayOfMonth: 0 } },
    });
    const high = hybridConfigSchema.parse({
      ...BASE_CONFIG,
      maintenance: { monthlyReview: { enabled: true, dayOfMonth: 40 } },
    });
    expect(low.maintenance.monthlyReview.dayOfMonth).toBe(1);
    expect(high.maintenance.monthlyReview.dayOfMonth).toBe(31);
  });
});
