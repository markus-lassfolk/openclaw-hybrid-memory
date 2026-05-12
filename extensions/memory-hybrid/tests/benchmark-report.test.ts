import { describe, expect, it } from "vitest";
import { buildBenchmarkQualityReport, formatBenchmarkQualityReportMarkdown } from "../cli/benchmark.js";
import type { BenchmarkResult } from "../benchmark/shadow-eval.js";

describe("benchmark quality report", () => {
  it("aggregates latency, accuracy, failure-rate, and cost metrics", () => {
    const results: BenchmarkResult[] = [
      {
        feature: "episodes",
        latency: { p50: 10, p95: 20, p99: 30, samples: 100 },
        accuracy: { score: 0.8, llmCalls: 1, tokensUsed: 100, judgement: "good" },
        tokensTracked: 1000,
        costTrackedUsd: 0.01,
      },
      {
        feature: "procedure-feedback",
        latency: { p50: -1, p95: -1, p99: -1, samples: 0 },
        accuracy: { score: 0, llmCalls: 0, tokensUsed: 0, judgement: "error" },
        tokensTracked: 0,
        costTrackedUsd: 0,
      },
    ];

    const report = buildBenchmarkQualityReport(results);
    // Average includes all measured features, including explicit failure rows (score=0),
    // so operators can see degraded quality at the suite level.
    expect(report.metrics.recallAccuracy.measuredFeatures).toBe(2);
    expect(report.metrics.latency.p50Ms).toBe(10);
    expect(report.metrics.recallAccuracy.averageScore).toBe(0.4);
    expect(report.metrics.failureRate.failedFeatures).toBe(1);
    expect(report.metrics.failureRate.totalFeatures).toBe(2);
    expect(report.metrics.cost.trackedTokens).toBe(1000);
    expect(report.metrics.cost.trackedUsd).toBe(0.01);
  });

  it("renders markdown with summary and feature table", () => {
    const report = buildBenchmarkQualityReport([
      {
        feature: "episodes",
        latency: { p50: 10, p95: 20, p99: 30, samples: 100 },
        accuracy: { score: 0.8, llmCalls: 1, tokensUsed: 100, judgement: "good" },
        tokensTracked: 1000,
        costTrackedUsd: 0.01,
      },
    ]);
    const markdown = formatBenchmarkQualityReportMarkdown(report);
    expect(markdown).toContain("Hybrid Memory Quality Benchmark Report");
    expect(markdown).toContain("| Feature | p50 (ms) | p95 (ms) | p99 (ms) | Accuracy |");
    expect(markdown).toContain("| episodes | 10.00 | 20.00 | 30.00 | 80% |");
  });
  it("reports n/a latency when every benchmark feature failed", () => {
    const report = buildBenchmarkQualityReport([
      {
        feature: "episodes",
        latency: { p50: -1, p95: -1, p99: -1, samples: 0 },
        accuracy: { score: 0, llmCalls: 0, tokensUsed: 0, judgement: "error" },
        tokensTracked: 0,
        costTrackedUsd: 0,
      },
    ]);

    expect(report.metrics.latency.p50Ms).toBeNull();
    expect(report.metrics.latency.p95Ms).toBeNull();
    expect(report.metrics.latency.p99Ms).toBeNull();
    expect(formatBenchmarkQualityReportMarkdown(report)).toContain("Latency (avg): n/a");
  });
});
