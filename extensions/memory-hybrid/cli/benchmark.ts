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

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Chainable } from "./shared.js";
import type { HybridMemCliContext } from "./register.js";
import type { BenchmarkResult } from "../benchmark/shadow-eval.js";
import {
  runBenchmark,
  runAllBenchmarks,
  formatBenchmarkResult,
  formatBenchmarkResults,
} from "../benchmark/shadow-eval.js";

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type BenchmarkRunContext = {
  /** Path to the SQLite database (llm_cost_log lives here) */
  dbPath: string;
};

export async function runBenchmarkCommand(
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
  const { feature, accuracy = false, shadow = false, format = "text", iterations = 100, judgeModel = "openai/gpt-4.1-nano" } = options;

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

// ---------------------------------------------------------------------------
// CLI registration
// ---------------------------------------------------------------------------

export function registerBenchmarkCommands(
  mem: Chainable,
  _ctx: HybridMemCliContext,
): void {
  const benchmark = mem
    .command("benchmark")
    .description("Shadow evaluation benchmarks for hybrid-memory features");

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
      const dbPath = (typeof cfg.sqlitePath === "string" && cfg.sqlitePath
          ? cfg.sqlitePath
          : join(process.env.HOME ?? "/home/markus", ".openclaw", "memory", "facts.db")) as string;

      await runBenchmarkCommand(
        { dbPath },
        {
          feature: typeof opts.feature === "string" ? opts.feature : undefined,
          accuracy: opts.accuracy === "true",
          shadow: opts.shadow === "true",
          format: (opts.format === "json" ? "json" : "text") as "text" | "json",
          iterations: typeof opts.iterations === "string" ? parseInt(opts.iterations, 10) : 100,
          judgeModel: typeof opts["judge-model"] === "string" ? opts["judge-model"] : "openai/gpt-4.1-nano",
        },
      );
    });
}
