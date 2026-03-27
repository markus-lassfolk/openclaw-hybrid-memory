/**
 * Shadow Evaluation Benchmark Framework
 *
 * Measures recall accuracy, latency, and token cost per feature without
 * burning API budget on 100-LLM-call benchmark runs.
 *
 * Three measurement layers:
 *  1. Local latency profiling  — perf_hooks.performance.timerify() + PerformanceObserver
 *                               Zero API cost. 100 iterations. Reports p50/p95/p99.
 *  2. Accuracy scoring         — Construct known test case; feature ON vs OFF;
 *                               LLM judges improvement. Max 5–10 calls per feature.
 *  3. Token cost tracking      — Parse llm_cost_log table for session.
 *                               No new API calls.
 *
 * Shadow evaluation pattern:
 *   1. Warm up  — run once to prime caches
 *   2. Baseline — run 100× without feature
 *   3. Shadow   — run 100× with feature
 *   4. Compare  — diff the results
 */

import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface LatencyStats {
  p50: number; // ms
  p95: number;
  p99: number;
  samples: number;
}

export interface AccuracyResult {
  score: number; // 0–1
  llmCalls: number;
  tokensUsed: number;
  judgement: string; // human-readable explanation
}

export interface BenchmarkResult {
  feature: string;
  latency: LatencyStats;
  /** Populated when an accuracy test was run */
  accuracy?: AccuracyResult;
  /** Total tokens tracked from llm_cost_log for the feature in the window */
  tokensTracked?: number;
  /** Estimated USD cost from llm_cost_log */
  costTrackedUsd?: number;
  /** Shadow-mode diff: positive = feature slowed it down */
  latencyDeltaMs?: number;
}

// ---------------------------------------------------------------------------
// Latency profiler — zero LLM cost
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Measure latency of `fn` over `iterations` runs using performance.now().
 * Returns p50/p95/p99 without any LLM calls.
 *
 * @param fn        The synchronous function to benchmark (no LLM calls)
 * @param iterations Number of iterations (default 100)
 * @param warmup     Number of warmup runs (default 3)
 */
export function measureLatency<R>(fn: () => R, iterations = 100, warmup = 3): LatencyStats & { values: number[] } {
  // Warm up
  for (let i = 0; i < warmup; i++) fn();

  const values: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    const end = performance.now();
    values.push(end - start);
  }

  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    samples: values.length,
    values,
  };
}

/**
 * Shadow evaluation: run `baseline` and `shadow` each `iterations` times,
 * return delta in p50 latency. Useful for measuring feature overhead.
 */
export function shadowMeasure(
  baseline: () => void,
  shadow: () => void,
  iterations = 100,
  warmup = 3,
): { baselineStats: LatencyStats; shadowStats: LatencyStats; deltaMs: number } {
  const baselineResult = measureLatency(baseline, iterations, warmup);
  const shadowResult = measureLatency(shadow, iterations, warmup);

  return {
    baselineStats: {
      p50: baselineResult.p50,
      p95: baselineResult.p95,
      p99: baselineResult.p99,
      samples: baselineResult.samples,
    },
    shadowStats: {
      p50: shadowResult.p50,
      p95: shadowResult.p95,
      p99: shadowResult.p99,
      samples: shadowResult.samples,
    },
    deltaMs: shadowResult.p50 - baselineResult.p50,
  };
}

// ---------------------------------------------------------------------------
// Token cost tracker — read from llm_cost_log (zero new API calls)
// ---------------------------------------------------------------------------

/**
 * Read total token usage for a feature from llm_cost_log.
 * Pass 0 for sinceTimestamp to get all-time.
 */
export function readTokensFromLog(
  db: Database.Database,
  feature: string,
  sinceTimestamp?: number,
): { inputTokens: number; outputTokens: number; calls: number; estimatedCostUsd: number } {
  const where = sinceTimestamp ? "WHERE feature = ? AND timestamp >= ?" : "WHERE feature = ?";
  const params: (string | number)[] = sinceTimestamp ? [feature, sinceTimestamp] : [feature];

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COUNT(*) AS calls,
              COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd
       FROM llm_cost_log ${where}`,
    )
    .get(...params) as {
    input_tokens: number;
    output_tokens: number;
    calls: number;
    estimated_cost_usd: number;
  };

  return {
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    calls: Number(row.calls),
    estimatedCostUsd: row.estimated_cost_usd,
  };
}

// ---------------------------------------------------------------------------
// Accuracy scorer — minimal LLM calls (max 5–10 per feature)
// ---------------------------------------------------------------------------

export type AccuracyTestFn = () => Promise<{
  featureOn: string;
  featureOff: string;
  prompt: string;
}>;

/**
 * Run an accuracy test using an LLM judge.
 * Caps at 1 call per feature: the judge compares feature ON vs OFF outputs.
 * Returns 0–1 score + token usage.
 *
 * Creates its own OpenAI client from environment variables — no plugin context needed.
 */
export async function scoreAccuracy(
  testCase: AccuracyTestFn,
  judgeModel = "openai/gpt-4.1-nano",
): Promise<AccuracyResult> {
  const { featureOn, featureOff, prompt } = await testCase();

  // Build a comparison prompt for the judge
  const judgePrompt = `You are an expert evaluator comparing two outputs for the same task.

TASK PROMPT:
${prompt}

OUTPUT A (feature ON):
${featureOn}

OUTPUT B (feature OFF):
${featureOff}

Compare the two outputs. Which is better for the stated task?
Respond with a JSON object and nothing else:
{
  "winner": "A" | "B" | "tie",
  "scoreA": number,  // 0.0–1.0 quality of Output A
  "scoreB": number,  // 0.0–1.0 quality of Output B
  "reasoning": "brief explanation"
}`;

  let tokensUsed = 0;
  let llmCalls = 0;
  let judgement = "";

  try {
    // Dynamically import OpenAI to avoid a hard dependency here
    const { default: OpenAI } = (await import("openai")) as { default: typeof import("openai").default };
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.GOOGLE_API_KEY ?? undefined;
    if (!apiKey) {
      judgement = "No API key available (set OPENAI_API_KEY or GOOGLE_API_KEY)";
      return { score: 0.5, llmCalls, tokensUsed, judgement };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // biome-ignore lint/suspicious/noExplicitAny: third-party SDK typing
    const client: any = new OpenAI({ apiKey });
    const isGoogle = judgeModel.startsWith("google/") || judgeModel.startsWith("gemini/");
    const isAnthropic = judgeModel.startsWith("anthropic/") || judgeModel.startsWith("claude/");

    const model = isGoogle
      ? judgeModel.replace(/^google\//, "")
      : isAnthropic
        ? judgeModel.replace(/^anthropic\//, "").replace(/^claude\//, "")
        : judgeModel.replace(/^openai\//, "");

    const res = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: judgePrompt }],
      max_tokens: 300,
      temperature: 0,
    });

    llmCalls = 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // biome-ignore lint/suspicious/noExplicitAny: LLM response typing requires any
    const resAny = res as any;
    const responseText: string = resAny.choices?.[0]?.message?.content ?? "";
    tokensUsed = resAny.usage?.total_tokens ?? 0;

    // Try to parse JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        winner: string;
        scoreA: number;
        scoreB: number;
        reasoning: string;
      };
      const score =
        parsed.winner === "A"
          ? parsed.scoreA
          : parsed.winner === "B"
            ? parsed.scoreB
            : (parsed.scoreA + parsed.scoreB) / 2;
      judgement = `[${parsed.winner}] ${parsed.reasoning}`;
      return { score, llmCalls, tokensUsed, judgement };
    }
    judgement = responseText.slice(0, 200);
    return { score: 0.5, llmCalls, tokensUsed, judgement };
  } catch (err) {
    judgement = `Error running judge: ${err instanceof Error ? err.message : String(err)}`;
    return { score: 0.5, llmCalls, tokensUsed, judgement };
  }
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

export interface BenchmarkContext {
  /** Path to the SQLite database (llm_cost_log lives here) */
  dbPath: string;
  /** Currently configured embeddings (for accuracy scoring) */
  embeddings?: unknown;
}

export interface RunBenchmarkOptions {
  /** Run accuracy tests (uses LLM, max 2 calls per feature) */
  accuracy?: boolean;
  /** Judge model for accuracy tests */
  judgeModel?: string;
  /** Output format */
  format?: "text" | "json";
  /** Iterations for latency tests (default 100) */
  iterations?: number;
}

/**
 * Run the full benchmark suite for a feature or all features.
 */
export async function runBenchmark(
  feature: string,
  ctx: BenchmarkContext,
  options: RunBenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const { accuracy = false, judgeModel = "openai/gpt-4.1-nano", format = "text", iterations = 100 } = options;

  // Lazy-load the per-feature benchmark
  const featureModule = await import(`./features/${feature}.js`).catch(() => null);
  if (!featureModule) {
    throw new Error(
      `Unknown feature benchmark: ${feature}. Available: episodes, frequency-autosave, procedure-feedback`,
    );
  }

  const { benchmark, testAccuracy } = featureModule as {
    benchmark: (ctx: BenchmarkContext, iterations: number) => LatencyStats;
    testAccuracy?: (ctx: BenchmarkContext) => Promise<{ featureOn: string; featureOff: string; prompt: string }>;
  };

  // ── 1. Latency ────────────────────────────────────────────────────────────
  const latency = benchmark(ctx, iterations);

  // ── 2. Accuracy (optional) ───────────────────────────────────────────────
  let accuracyResult: AccuracyResult | undefined;
  if (accuracy && testAccuracy) {
    accuracyResult = await scoreAccuracy(() => testAccuracy(ctx), judgeModel);
  }

  // ── 3. Token tracking from llm_cost_log ─────────────────────────────────
  const db = new Database(ctx.dbPath, { readonly: true, fileMustExist: true });
  try {
    const tokens = readTokensFromLog(db, feature);
    if (format === "json") {
      return {
        feature,
        latency,
        accuracy: accuracyResult,
        tokensTracked: tokens.inputTokens + tokens.outputTokens,
        costTrackedUsd: tokens.estimatedCostUsd,
      };
    }
    return {
      feature,
      latency,
      accuracy: accuracyResult,
      tokensTracked: tokens.inputTokens + tokens.outputTokens,
      costTrackedUsd: tokens.estimatedCostUsd,
    };
  } finally {
    db.close();
  }
}

/**
 * Run all benchmarks and return an array of results.
 */
export async function runAllBenchmarks(
  ctx: BenchmarkContext,
  options: RunBenchmarkOptions = {},
): Promise<BenchmarkResult[]> {
  const features = ["episodes", "frequency-autosave", "procedure-feedback"] as const;
  const results: BenchmarkResult[] = [];

  for (const feature of features) {
    try {
      const result = await runBenchmark(feature, ctx, options);
      results.push(result);
    } catch (err) {
      results.push({
        feature,
        latency: { p50: -1, p95: -1, p99: -1, samples: 0 },
        accuracy: {
          score: 0,
          llmCalls: 0,
          tokensUsed: 0,
          judgement: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

export function formatBenchmarkResult(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push(`\n📊 ${result.feature}`);
  lines.push(
    `   Latency  p50=${result.latency.p50.toFixed(2)}ms  p95=${result.latency.p95.toFixed(2)}ms  p99=${result.latency.p99.toFixed(2)}ms  (n=${result.latency.samples})`,
  );

  if (result.latencyDeltaMs !== undefined) {
    const sign = result.latencyDeltaMs >= 0 ? "+" : "";
    lines.push(`   Shadow Δ p50: ${sign}${result.latencyDeltaMs.toFixed(2)}ms`);
  }

  if (result.accuracy) {
    const pct = (result.accuracy.score * 100).toFixed(0);
    lines.push(
      `   Accuracy: ${pct}%  (${result.accuracy.llmCalls} LLM call(s), ${result.accuracy.tokensUsed} tokens) — ${result.accuracy.judgement}`,
    );
  }

  if (result.tokensTracked !== undefined) {
    lines.push(
      `   Tokens tracked: ${result.tokensTracked.toLocaleString()}  (≈$${(result.costTrackedUsd ?? 0).toFixed(6)})`,
    );
  }

  return lines.join("\n");
}

export function formatBenchmarkResults(results: BenchmarkResult[]): string {
  return results.map(formatBenchmarkResult).join("\n");
}
