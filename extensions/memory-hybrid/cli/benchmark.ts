import { getEnv } from "../utils/env-manager.js";
/**
 * CLI: `openclaw benchmark run` — run the shadow evaluation benchmark suite.
 *
 * Commands registered:
 *   openclaw benchmark run                    — run all benchmarks
 *   openclaw benchmark run --feature <name>  — run specific feature
 *   openclaw benchmark run --shadow           — include shadow comparison
 *   openclaw benchmark run --accuracy         — run accuracy tests (uses LLM)
 *   openclaw benchmark run --format json     — JSON output
 *   openclaw benchmark run --iterations 100  — custom iteration count
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BenchmarkResult } from "../benchmark/shadow-eval.js";
import {
  formatBenchmarkResult,
  formatBenchmarkResults,
  runAllBenchmarks,
  runBenchmark,
} from "../benchmark/shadow-eval.js";
import type { HybridMemCliContext } from "./register.js";
import type { Chainable } from "./shared.js";

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

type BenchmarkRunContext = {
  /** Path to the SQLite database (llm_cost_log lives here) */
  dbPath: string;
};

interface BenchmarkQualityReport {
  generatedAt: string;
  metrics: {
    latency: {
      p50Ms: number | null;
      p95Ms: number | null;
      p99Ms: number | null;
    };
    recallAccuracy: {
      averageScore: number | null;
      measuredFeatures: number;
    };
    failureRate: {
      failedFeatures: number;
      totalFeatures: number;
      ratio: number;
    };
    cost: {
      trackedTokens: number;
      trackedUsd: number;
    };
  };
  features: BenchmarkResult[];
}

function parseBooleanOption(value: unknown): boolean {
  return value === true || value === "true";
}

function resolveBenchmarkDbPath(cfg: Record<string, unknown>): string {
  if (typeof cfg.sqlitePath === "string" && cfg.sqlitePath) {
    return cfg.sqlitePath;
  }
  const home = getEnv("HOME");
  if (!home) {
    throw new Error("HOME is not set and sqlitePath is not configured; cannot resolve benchmark database path.");
  }
  return join(home, ".openclaw", "memory", "facts.db");
}

async function runBenchmarkCommand(
  ctx: BenchmarkRunContext,
  options: {
    feature?: string;
    accuracy?: boolean;
    shadow?: boolean;
    format?: "text" | "json";
    iterations?: number;
    judgeModel?: string;
  },
): Promise<{ results: BenchmarkResult[] }> {
  const {
    feature,
    accuracy = false,
    shadow = false,
    format = "text",
    iterations = 100,
    judgeModel = "openai/gpt-4.1-nano",
  } = options;

  if (!existsSync(ctx.dbPath)) {
    throw new Error(`Database not found at: ${ctx.dbPath}. Run 'openclaw verify' first to set up the database.`);
  }

  const benchmarkCtx = { dbPath: ctx.dbPath };

  let results: BenchmarkResult[];

  if (feature) {
    const result = await runBenchmark(feature, benchmarkCtx, {
      accuracy,
      judgeModel,
      format,
      iterations,
    });
    results = [result];
  } else {
    results = await runAllBenchmarks(benchmarkCtx, {
      accuracy,
      judgeModel,
      format,
      iterations,
    });
  }

  if (format === "json") {
    return { results };
  }

  // Text output
  console.log("\n🧪 Shadow Evaluation Benchmark Suite");
  console.log(`   Database: ${ctx.dbPath}`);
  console.log(`   Iterations: ${iterations}${shadow ? " (shadow mode)" : ""}${accuracy ? " + accuracy tests" : ""}`);
  console.log(formatBenchmarkResults(results));

  return { results };
}

function toFixedNumber(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

export function buildBenchmarkQualityReport(results: BenchmarkResult[]): BenchmarkQualityReport {
  const successful = results.filter((r) => r.latency.samples > 0 && r.latency.p50 >= 0);
  const failedFeatures = results.length - successful.length;
  const totalFeatures = results.length;
  const p50Avg =
    successful.length > 0 ? successful.reduce((sum, r) => sum + r.latency.p50, 0) / successful.length : null;
  const p95Avg =
    successful.length > 0 ? successful.reduce((sum, r) => sum + r.latency.p95, 0) / successful.length : null;
  const p99Avg =
    successful.length > 0 ? successful.reduce((sum, r) => sum + r.latency.p99, 0) / successful.length : null;

  const measuredAccuracy = results.filter((r) => r.accuracy && Number.isFinite(r.accuracy.score));
  const averageAccuracy =
    measuredAccuracy.length > 0
      ? measuredAccuracy.reduce((sum, r) => sum + (r.accuracy?.score ?? 0), 0) / measuredAccuracy.length
      : null;

  const trackedTokens = results.reduce((sum, r) => sum + (r.tokensTracked ?? 0), 0);
  const trackedUsd = results.reduce((sum, r) => sum + (r.costTrackedUsd ?? 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    metrics: {
      latency: {
        p50Ms: p50Avg == null ? null : toFixedNumber(p50Avg),
        p95Ms: p95Avg == null ? null : toFixedNumber(p95Avg),
        p99Ms: p99Avg == null ? null : toFixedNumber(p99Avg),
      },
      recallAccuracy: {
        averageScore: averageAccuracy == null ? null : toFixedNumber(averageAccuracy, 4),
        measuredFeatures: measuredAccuracy.length,
      },
      failureRate: {
        failedFeatures,
        totalFeatures,
        ratio: toFixedNumber(failedFeatures / Math.max(1, totalFeatures), 4),
      },
      cost: {
        trackedTokens,
        trackedUsd: toFixedNumber(trackedUsd, 6),
      },
    },
    features: results,
  };
}

export function formatBenchmarkQualityReportMarkdown(report: BenchmarkQualityReport): string {
  const lines: string[] = [];
  lines.push("# Hybrid Memory Quality Benchmark Report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Summary metrics");
  lines.push("");
  const summaryLatency =
    report.metrics.latency.p50Ms == null
      ? "n/a (no successful latency samples)"
      : `p50=${report.metrics.latency.p50Ms}ms, p95=${report.metrics.latency.p95Ms}ms, p99=${report.metrics.latency.p99Ms}ms`;
  lines.push(`- Latency (avg): ${summaryLatency}`);
  lines.push(
    `- Recall accuracy (avg): ${report.metrics.recallAccuracy.averageScore == null ? "n/a" : `${(report.metrics.recallAccuracy.averageScore * 100).toFixed(1)}%`} across ${report.metrics.recallAccuracy.measuredFeatures} feature(s)`,
  );
  lines.push(
    `- Failure rate: ${(report.metrics.failureRate.ratio * 100).toFixed(1)}% (${report.metrics.failureRate.failedFeatures}/${report.metrics.failureRate.totalFeatures})`,
  );
  lines.push(
    `- Cost tracked: ${report.metrics.cost.trackedTokens.toLocaleString()} tokens (~$${report.metrics.cost.trackedUsd.toFixed(6)})`,
  );
  lines.push("");
  lines.push("## Feature breakdown");
  lines.push("");
  lines.push("| Feature | p50 (ms) | p95 (ms) | p99 (ms) | Accuracy | Tracked tokens | Tracked cost USD |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const result of report.features) {
    lines.push(
      `| ${result.feature} | ${result.latency.samples > 0 && result.latency.p50 >= 0 ? result.latency.p50.toFixed(2) : "n/a"} | ${result.latency.samples > 0 && result.latency.p95 >= 0 ? result.latency.p95.toFixed(2) : "n/a"} | ${result.latency.samples > 0 && result.latency.p99 >= 0 ? result.latency.p99.toFixed(2) : "n/a"} | ${result.accuracy ? `${(result.accuracy.score * 100).toFixed(0)}%` : "n/a"} | ${(result.tokensTracked ?? 0).toLocaleString()} | ${(result.costTrackedUsd ?? 0).toFixed(6)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

export function registerBenchmarkCommands(mem: Chainable, _ctx: HybridMemCliContext): void {
  const benchmark = mem.command("benchmark").description("Shadow evaluation benchmarks for hybrid-memory features");

  benchmark
    .command("run")
    .description("Run shadow evaluation benchmarks (latency, accuracy, token cost)")
    .option("--feature <name>", "Specific feature to benchmark: episodes, frequency-autosave, procedure-feedback")
    .option("--accuracy", "Run accuracy tests (uses LLM, max 10 calls per feature)", "false")
    .option("--shadow", "Include shadow comparison (feature ON vs OFF)", "false")
    .option("--format <format>", "Output format: text (default) or json", "text")
    .option("--iterations <n>", "Latency test iterations (default 100)", "100")
    .option("--judge-model <model>", "Model for accuracy scoring (default openai/gpt-4.1-nano)", "openai/gpt-4.1-nano")
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      // Resolve dbPath from HybridMemoryConfig
      const cfg = (_ctx.cfg ?? {}) as Record<string, unknown>;
      const dbPath = resolveBenchmarkDbPath(cfg);

      await runBenchmarkCommand(
        { dbPath },
        {
          feature: typeof opts.feature === "string" ? opts.feature : undefined,
          accuracy: parseBooleanOption(opts.accuracy),
          shadow: parseBooleanOption(opts.shadow),
          format: (opts.format === "json" ? "json" : "text") as "text" | "json",
          iterations: typeof opts.iterations === "string" ? Number.parseInt(opts.iterations, 10) : 100,
          judgeModel: typeof opts["judge-model"] === "string" ? opts["judge-model"] : "openai/gpt-4.1-nano",
        },
      );
    });

  benchmark
    .command("report")
    .description("Generate a quality benchmark report (latency, recall accuracy, failure rate, cost)")
    .option("--format <format>", "Output format: markdown (default) or json", "markdown")
    .option("--iterations <n>", "Latency test iterations (default 100)", "100")
    .option("--accuracy", "Include LLM-judged accuracy scoring", "false")
    .option("--judge-model <model>", "Model for accuracy scoring (default openai/gpt-4.1-nano)", "openai/gpt-4.1-nano")
    .option("--out <path>", "Optional output file path")
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      const cfg = (_ctx.cfg ?? {}) as Record<string, unknown>;
      const dbPath = resolveBenchmarkDbPath(cfg);
      const format = opts.format === "json" ? "json" : "markdown";
      const iterations = typeof opts.iterations === "string" ? Number.parseInt(opts.iterations, 10) : 100;
      const results = await runAllBenchmarks(
        { dbPath },
        {
          accuracy: parseBooleanOption(opts.accuracy),
          judgeModel: typeof opts["judge-model"] === "string" ? opts["judge-model"] : "openai/gpt-4.1-nano",
          format: "json",
          iterations,
        },
      );
      const report = buildBenchmarkQualityReport(results);
      const rendered =
        format === "json" ? JSON.stringify(report, null, 2) : formatBenchmarkQualityReportMarkdown(report);
      const outPath = typeof opts.out === "string" && opts.out.trim().length > 0 ? opts.out.trim() : "";
      if (outPath) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, rendered, "utf-8");
        console.log(`Benchmark report written to ${outPath}`);
      } else {
        console.log(rendered);
      }
    });
}
