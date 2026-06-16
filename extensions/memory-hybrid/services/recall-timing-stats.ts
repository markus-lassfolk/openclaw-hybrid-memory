/**
 * Always-on recall stage timing aggregates (Issue #1910).
 * Surfaces p50/p95/p99 via audit health and /api/viewer/recall-stats.
 */

export type StageTimingBucket = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  samples: number[];
};

const MAX_SAMPLES = 500;
const buckets = new Map<string, number[]>();
const featureCounters = new Map<string, { on: number; off: number }>();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function recordRecallStageTiming(stage: string, durationMs: number): void {
  let samples = buckets.get(stage);
  if (!samples) {
    samples = [];
    buckets.set(stage, samples);
  }
  samples.push(durationMs);
  if (samples.length > MAX_SAMPLES) {
    samples.shift();
  }
}

export function recordFeatureCounter(feature: string, enabled: boolean): void {
  const entry = featureCounters.get(feature) ?? { on: 0, off: 0 };
  if (enabled) entry.on++;
  else entry.off++;
  featureCounters.set(feature, entry);
}

export function getStageTimingBucket(stage: string): StageTimingBucket {
  const samples = [...(buckets.get(stage) ?? [])].sort((a, b) => a - b);
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    samples,
  };
}

export type RecallStatsSnapshot = {
  stages: Record<string, Omit<StageTimingBucket, "samples">>;
  features: Record<string, { on: number; off: number }>;
  bypassRate: number;
  intentDistribution: Record<string, number>;
};

let bypassTotal = 0;
let bypassHits = 0;
const intentCounts = new Map<string, number>();

export function recordBypassDecision(bypassed: boolean): void {
  bypassTotal++;
  if (bypassed) bypassHits++;
}

export function recordIntentDistribution(intent: string): void {
  intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + 1);
}

export function getRecallStatsSnapshot(): RecallStatsSnapshot {
  const stages: RecallStatsSnapshot["stages"] = {};
  for (const [stage, samples] of buckets) {
    const sorted = [...samples].sort((a, b) => a - b);
    stages[stage] = {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    };
  }
  const features: RecallStatsSnapshot["features"] = {};
  for (const [k, v] of featureCounters) features[k] = { ...v };
  const intentDistribution: Record<string, number> = {};
  for (const [k, v] of intentCounts) intentDistribution[k] = v;
  return {
    stages,
    features,
    bypassRate: bypassTotal > 0 ? bypassHits / bypassTotal : 0,
    intentDistribution,
  };
}

/** Reset stats (for tests). */
export function resetRecallStats(): void {
  buckets.clear();
  featureCounters.clear();
  bypassTotal = 0;
  bypassHits = 0;
  intentCounts.clear();
}
