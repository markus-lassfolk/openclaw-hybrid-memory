import type OpenAI from "openai";
import type { FactsDB } from "../backends/facts-db.js";
import { chatComplete } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";

export interface MonthlyReviewReport {
  generatedAt: string; // ISO date
  coverageAnalysis: {
    totalFacts: number;
    factsByCategory: Record<string, number>;
    topEntities: Array<{ entity: string; count: number }>;
    sparseEntities: Array<{ entity: string; count: number }>;
    uncoveredDomains: string[]; // suggested by LLM
  };
  qualityTrends: {
    averageConfidence: number;
    averageConfidencePreviousMonth: number;
    contradictionCount: number;
    staleFacts: number; // facts not accessed in 90+ days
    recentlySuperseded: number;
  };
  recommendations: string[]; // LLM-generated actionable suggestions
}

const RECOMMENDATION_PROMPT =
  "You are a knowledge base analyst. Given this knowledge base statistics, generate 5-10 actionable recommendations for improvement. Focus on coverage gaps, quality issues, and maintenance priorities.";

function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^([-*•]\s+|\d+[.)]\s*)/, ""))
    .filter((line) => line.length > 0);
}

function normalizeAverage(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Number.isFinite(value) ? value : 0;
}

export class MonthlyReviewService {
  constructor(
    private readonly factsDb: FactsDB,
    private readonly openai: OpenAI,
    private readonly model: string,
  ) {}

  async runReview(): Promise<MonthlyReviewReport> {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const rawDb = this.factsDb.getRawDb();
    const factsByCategory = this.factsDb.statsBreakdownByCategory();
    const totalFacts = Object.values(factsByCategory).reduce((sum, n) => sum + n, 0);

    const entityRows = rawDb
      .prepare(
        `SELECT entity, COUNT(*) as cnt
         FROM facts
         WHERE superseded_at IS NULL AND entity IS NOT NULL AND TRIM(entity) != ''
         GROUP BY entity`,
      )
      .all() as Array<{ entity: string; cnt: number }>;

    const topEntities = [...entityRows]
      .sort((a, b) => b.cnt - a.cnt || a.entity.localeCompare(b.entity))
      .slice(0, 10)
      .map((row) => ({ entity: row.entity, count: row.cnt }));

    const sparseEntities = [...entityRows]
      .sort((a, b) => a.cnt - b.cnt || a.entity.localeCompare(b.entity))
      .slice(0, 10)
      .map((row) => ({ entity: row.entity, count: row.cnt }));

    const avgRow = rawDb.prepare(`SELECT AVG(confidence) as avg FROM facts WHERE superseded_at IS NULL`).get() as
      | { avg: number | null }
      | undefined;
    const averageConfidence = normalizeAverage(avgRow?.avg ?? 0);

    const prevStart = nowSec - 60 * 86_400;
    const prevEnd = nowSec - 30 * 86_400;
    const prevAvgRow = rawDb
      .prepare(
        `SELECT AVG(confidence) as avg
         FROM facts
         WHERE superseded_at IS NULL AND created_at >= ? AND created_at < ?`,
      )
      .get(prevStart, prevEnd) as { avg: number | null } | undefined;
    const averageConfidencePreviousMonth = normalizeAverage(prevAvgRow?.avg ?? 0);

    const contradictionCount = this.factsDb.contradictionsCount();

    const staleCutoff = nowSec - 90 * 86_400;
    const staleRow = rawDb
      .prepare(
        `SELECT COUNT(*) as cnt
         FROM facts
         WHERE superseded_at IS NULL
           AND (last_accessed IS NULL OR last_accessed < ?)`,
      )
      .get(staleCutoff) as { cnt: number } | undefined;
    const staleFacts = staleRow?.cnt ?? 0;

    const supersededCutoff = nowSec - 30 * 86_400;
    const supersededRow = rawDb
      .prepare(
        `SELECT COUNT(*) as cnt
         FROM facts
         WHERE superseded_at IS NOT NULL AND superseded_at >= ?`,
      )
      .get(supersededCutoff) as { cnt: number } | undefined;
    const recentlySuperseded = supersededRow?.cnt ?? 0;

    const lowConfidenceRow = rawDb
      .prepare(
        `SELECT COUNT(*) as cnt
         FROM facts
         WHERE superseded_at IS NULL AND confidence < 0.5`,
      )
      .get() as { cnt: number } | undefined;
    const lowConfidenceCount = lowConfidenceRow?.cnt ?? 0;

    const coverageAnalysis = {
      totalFacts,
      factsByCategory,
      topEntities,
      sparseEntities,
      uncoveredDomains: [] as string[],
    };
    const qualityTrends = {
      averageConfidence,
      averageConfidencePreviousMonth,
      contradictionCount,
      staleFacts,
      recentlySuperseded,
    };

    const statsPayload = {
      coverageAnalysis,
      qualityTrends: {
        ...qualityTrends,
        lowConfidenceCount,
      },
    };

    let recommendations: string[] = [];
    try {
      const response = await chatComplete({
        model: this.model,
        content: `${RECOMMENDATION_PROMPT}\n\nStatistics:\n${JSON.stringify(statsPayload, null, 2)}`,
        temperature: 0.3,
        openai: this.openai,
      });
      recommendations = parseLines(response).slice(0, 10);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "monthly-review",
        operation: "recommendations",
      });
      recommendations = [];
    }

    let uncoveredDomains: string[] = [];
    try {
      const response = await chatComplete({
        model: this.model,
        content:
          `Given this knowledge base statistics, list 3-8 uncovered domains (short labels). ` +
          `Return one per line with no numbering or bullets.\n\nStatistics:\n${JSON.stringify(statsPayload, null, 2)}`,
        temperature: 0.2,
        openai: this.openai,
      });
      uncoveredDomains = parseLines(response).slice(0, 10);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "monthly-review",
        operation: "uncovered-domains",
      });
      uncoveredDomains = [];
    }

    coverageAnalysis.uncoveredDomains = uncoveredDomains;

    return {
      generatedAt: now.toISOString(),
      coverageAnalysis,
      qualityTrends,
      recommendations,
    };
  }
}

export async function runMonthlyReview(opts: {
  factsDb: FactsDB;
  openai: OpenAI;
  model: string;
}): Promise<MonthlyReviewReport> {
  const service = new MonthlyReviewService(opts.factsDb, opts.openai, opts.model);
  return service.runReview();
}
