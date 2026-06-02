/**
 * Batch backfill for fact NER / contact-org layer (#985). Used by `hybrid-mem enrich-entities`.
 */

import type OpenAI from "openai";

import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { getCronModelConfig, getDefaultCronModel } from "../config.js";
import { capDelayMsByDeadline, computeAdaptivePressureDelayMs } from "./adaptive-catch-up-pacing.js";
import { extractEntityMentionsWithLlm } from "./entity-enrichment.js";
import {
  buildEntityEnrichmentAdaptiveSummary,
  buildIssue1791AdaptiveTelemetry,
  type EntityEnrichmentAdaptiveSummary,
  type EntityEnrichmentStopReason,
  type Issue1791AdaptiveTelemetry,
  sanitizeMaxConcurrency,
  sanitizeProviderPressureBudget,
  sanitizeTimeBudgetSec,
} from "./entity-enrichment-adaptive.js";

function sanitizeEnrichmentLimit(n: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x) || x < 1) return 200;
  return Math.min(100_000, x);
}

function sanitizeBatchSize(n: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x) || x < 1) return 20;
  return Math.min(100, x);
}

function sanitizeBatchDelayMs(n: number): number {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x) || x < 0) return 150;
  return Math.min(5_000, x);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type EntityEnrichmentMentionSummary = { label: string; surfaceText: string };

export type EntityEnrichmentVerboseFact = {
  factId: string;
  mentions: EntityEnrichmentMentionSummary[];
  rejected?: Array<{ label: string; surfaceText: string; reason: string }>;
};

export type EntityEnrichmentProgress = {
  processed: number;
  total: number;
  factsEnriched: number;
  pendingTotal: number;
  remainingTotal: number;
  estimatedRunsRemaining: number;
  mode: "bounded" | "all";
  mentions: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  rejectReasons: Record<string, number>;
  llmFailures?: number;
  effectiveBatchSize?: number;
  effectiveDelayMs?: number;
  effectiveConcurrency?: number;
  stopReason?: EntityEnrichmentStopReason;
};

export type EntityEnrichmentAdaptivePacing = {
  reason: "pressure" | "ramp-up";
  batchSize: number;
  delayMs: number;
  concurrency: number;
  previousBatchSize: number;
  previousDelayMs: number;
  previousConcurrency: number;
  batchPressureSignals: number;
  batchFailures: number;
  batchTransientFailures: number;
  batchRateLimited: number;
};

const ADAPTIVE_MIN_BATCH_SIZE = 5;
const ADAPTIVE_MAX_BATCH_SIZE = 100;
const ADAPTIVE_MIN_DELAY_MS = 0;
const ADAPTIVE_MAX_DELAY_MS = 5_000;
const ADAPTIVE_BACKOFF_MIN_DELAY_MS = 50;
const ADAPTIVE_SUCCESS_STREAK_FOR_RAMP_UP = 2;
const ADAPTIVE_BATCH_SIZE_STEP = 5;
const ADAPTIVE_DELAY_STEP_MS = 25;
const ADAPTIVE_MIN_CONCURRENCY = 1;
const ADAPTIVE_MAX_CONCURRENCY = 8;

type BatchFactStats = {
  batchFailures: number;
  batchPressureSignals: number;
  batchTransientFailures: number;
  batchRateLimited: number;
  batchTimeoutFailures: number;
  batchRetryAfterMs?: number;
  factsEnrichedDelta: number;
  mentionsDelta: number;
  acceptedDelta: number;
  rejectedDelta: number;
  duplicatesDelta: number;
  rejectReasonsDelta: Record<string, number>;
  llmFailuresDelta: number;
  enrichedFactsDelta: EntityEnrichmentVerboseFact[];
};

type FactProcessResult = {
  processed: number;
  stats: BatchFactStats;
  rateLimitCount: number;
  transientFailureCount: number;
  timeoutFailureCount: number;
};

function emptyBatchStats(): BatchFactStats {
  return {
    batchFailures: 0,
    batchPressureSignals: 0,
    batchTransientFailures: 0,
    batchRateLimited: 0,
    batchTimeoutFailures: 0,
    factsEnrichedDelta: 0,
    mentionsDelta: 0,
    acceptedDelta: 0,
    rejectedDelta: 0,
    duplicatesDelta: 0,
    rejectReasonsDelta: {},
    llmFailuresDelta: 0,
    enrichedFactsDelta: [],
  };
}

function mergeBatchStats(target: BatchFactStats, delta: BatchFactStats): void {
  target.batchFailures += delta.batchFailures;
  target.batchPressureSignals += delta.batchPressureSignals;
  target.batchTransientFailures += delta.batchTransientFailures;
  target.batchRateLimited += delta.batchRateLimited;
  target.batchTimeoutFailures += delta.batchTimeoutFailures;
  if (delta.batchRetryAfterMs !== undefined) {
    target.batchRetryAfterMs = Math.max(target.batchRetryAfterMs ?? 0, delta.batchRetryAfterMs);
  }
  target.factsEnrichedDelta += delta.factsEnrichedDelta;
  target.mentionsDelta += delta.mentionsDelta;
  target.acceptedDelta += delta.acceptedDelta;
  target.rejectedDelta += delta.rejectedDelta;
  target.duplicatesDelta += delta.duplicatesDelta;
  target.llmFailuresDelta += delta.llmFailuresDelta;
  for (const [reason, count] of Object.entries(delta.rejectReasonsDelta)) {
    target.rejectReasonsDelta[reason] = (target.rejectReasonsDelta[reason] ?? 0) + count;
  }
  target.enrichedFactsDelta.push(...delta.enrichedFactsDelta);
}

function applyFactProcessResult(
  result: FactProcessResult,
  counters: {
    batchStats: BatchFactStats;
    rateLimitCount: { value: number };
    transientFailureCount: { value: number };
    timeoutFailureCount: { value: number };
    llmFailures: { value: number };
    mentions: { value: number };
    accepted: { value: number };
    rejected: { value: number };
    duplicates: { value: number };
    rejectReasons: Record<string, number>;
    factsEnriched: { value: number };
    enrichedFacts: EntityEnrichmentVerboseFact[];
    processed: { value: number };
  },
): void {
  counters.processed.value += result.processed;
  mergeBatchStats(counters.batchStats, result.stats);
  counters.rateLimitCount.value += result.rateLimitCount;
  counters.transientFailureCount.value += result.transientFailureCount;
  counters.timeoutFailureCount.value += result.timeoutFailureCount;
  counters.llmFailures.value += result.stats.llmFailuresDelta;
  counters.mentions.value += result.stats.mentionsDelta;
  counters.accepted.value += result.stats.acceptedDelta;
  counters.rejected.value += result.stats.rejectedDelta;
  counters.duplicates.value += result.stats.duplicatesDelta;
  for (const [reason, count] of Object.entries(result.stats.rejectReasonsDelta)) {
    counters.rejectReasons[reason] = (counters.rejectReasons[reason] ?? 0) + count;
  }
  counters.factsEnriched.value += result.stats.factsEnrichedDelta;
  counters.enrichedFacts.push(...result.stats.enrichedFactsDelta);
}

export async function runEntityEnrichmentForCli(
  factsDb: FactsDB,
  openai: OpenAI,
  cfg: HybridMemoryConfig,
  opts: {
    limit: number;
    dryRun: boolean;
    model?: string;
    all?: boolean;
    verbose?: boolean;
    adaptiveCatchUp?: boolean;
    batchSize?: number;
    batchDelayMs?: number;
    timeBudgetSec?: number;
    targetDurationSec?: number;
    maxConcurrency?: number;
    providerPressureBudget?: number;
    onProgress?: (progress: EntityEnrichmentProgress) => void;
    onAdaptivePacing?: (state: EntityEnrichmentAdaptivePacing) => void;
  },
): Promise<{
  pending: number;
  pendingTotal: number;
  pendingByTier: { hot: number; warm: number; structural: number; cold: number; unknown: number };
  processed: number;
  factsEnriched: number;
  mode: "bounded" | "all";
  effectiveLimit: number | "all";
  remainingTotal: number;
  estimatedRunsRemaining: number;
  mentions: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  rejectReasons: Record<string, number>;
  skipped?: boolean;
  pendingFactIds?: string[];
  enrichedFacts?: EntityEnrichmentVerboseFact[];
  llmFailures?: number;
  stopReason?: EntityEnrichmentStopReason;
  adaptiveSummary?: EntityEnrichmentAdaptiveSummary;
  telemetry?: Issue1791AdaptiveTelemetry;
}> {
  const limit = sanitizeEnrichmentLimit(opts.limit);
  const mode: "bounded" | "all" = opts.all ? "all" : "bounded";
  const effectiveLimit: number | "all" = mode === "all" ? "all" : limit;
  const verbose = !!opts.verbose;
  const backlog = factsDb.getEntityEnrichmentBacklogSummary(24);
  const pendingTotal = backlog.total;
  if (!cfg.graph?.enabled) {
    const pending = mode === "all" ? pendingTotal : Math.min(pendingTotal, limit);
    return {
      pending,
      pendingTotal,
      pendingByTier: backlog.byTier,
      processed: 0,
      factsEnriched: 0,
      mode,
      effectiveLimit,
      remainingTotal: pendingTotal,
      estimatedRunsRemaining: mode === "all" ? 0 : Math.ceil(pendingTotal / Math.max(1, limit)),
      mentions: 0,
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      rejectReasons: {},
      skipped: true,
    };
  }

  if (opts.dryRun) {
    const ids = verbose ? factsDb.listFactIdsNeedingEntityEnrichment(limit, 24, { all: mode === "all" }) : [];
    const pending = verbose ? ids.length : mode === "all" ? pendingTotal : Math.min(pendingTotal, limit);
    return {
      pending,
      pendingTotal,
      pendingByTier: backlog.byTier,
      processed: 0,
      factsEnriched: 0,
      mode,
      effectiveLimit,
      remainingTotal: pendingTotal,
      estimatedRunsRemaining: mode === "all" ? 0 : Math.ceil(pendingTotal / Math.max(1, limit)),
      mentions: 0,
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      rejectReasons: {},
      pendingFactIds: verbose ? [...ids] : undefined,
    };
  }

  const ids = factsDb.listFactIdsNeedingEntityEnrichment(limit, 24, { all: mode === "all" });
  const pending = ids.length;
  const model = opts.model ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
  const adaptiveCatchUp = !!opts.adaptiveCatchUp;
  const timeBudgetSec = sanitizeTimeBudgetSec(opts.timeBudgetSec ?? opts.targetDurationSec);
  const providerPressureBudget = sanitizeProviderPressureBudget(opts.providerPressureBudget);
  const startedAtMs = Date.now();
  const deadlineMs = timeBudgetSec != null ? startedAtMs + timeBudgetSec * 1000 : undefined;
  const isPastDeadline = (): boolean => deadlineMs != null && Date.now() >= deadlineMs;

  let effectiveBatchSize = sanitizeBatchSize(opts.batchSize ?? 20);
  let effectiveDelayMs = sanitizeBatchDelayMs(opts.batchDelayMs ?? 150);
  let effectiveConcurrency = sanitizeMaxConcurrency(opts.maxConcurrency, adaptiveCatchUp);
  const startBatchSize = effectiveBatchSize;
  const startDelayMs = effectiveDelayMs;
  const startConcurrency = effectiveConcurrency;
  if (adaptiveCatchUp) {
    effectiveBatchSize = Math.max(ADAPTIVE_MIN_BATCH_SIZE, Math.min(ADAPTIVE_MAX_BATCH_SIZE, effectiveBatchSize));
    effectiveDelayMs = Math.max(ADAPTIVE_MIN_DELAY_MS, Math.min(ADAPTIVE_MAX_DELAY_MS, effectiveDelayMs));
    effectiveConcurrency = Math.max(ADAPTIVE_MIN_CONCURRENCY, Math.min(ADAPTIVE_MAX_CONCURRENCY, effectiveConcurrency));
  }

  let factsEnriched = 0;
  let processed = 0;
  let mentions = 0;
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  let llmFailures = 0;
  let rateLimitCount = 0;
  let transientFailureCount = 0;
  let timeoutFailureCount = 0;
  const isPastProviderBudget = (rate = rateLimitCount, timeout = timeoutFailureCount): boolean =>
    providerPressureBudget != null && rate + timeout >= providerPressureBudget;
  const rejectReasons: Record<string, number> = {};
  const enrichedFacts: EntityEnrichmentVerboseFact[] = [];

  let stopReason: EntityEnrichmentStopReason = "exhausted";

  const emitProgress = (remainingTotal: number) => {
    opts.onProgress?.({
      processed,
      total: ids.length,
      factsEnriched,
      pendingTotal,
      remainingTotal,
      estimatedRunsRemaining: mode === "all" ? 0 : Math.ceil(remainingTotal / Math.max(1, limit)),
      mode,
      mentions,
      accepted,
      rejected,
      duplicates,
      rejectReasons: { ...rejectReasons },
      llmFailures,
      effectiveBatchSize: adaptiveCatchUp ? effectiveBatchSize : undefined,
      effectiveDelayMs: adaptiveCatchUp ? effectiveDelayMs : undefined,
      effectiveConcurrency: adaptiveCatchUp ? effectiveConcurrency : undefined,
      stopReason: stopReason === "exhausted" ? undefined : stopReason,
    });
  };

  emitProgress(pendingTotal);

  let successStreak = 0;
  let index = 0;
  for (; index < ids.length; ) {
    if (isPastDeadline()) {
      stopReason = "time_budget";
      break;
    }
    if (isPastProviderBudget()) {
      stopReason = "provider_budget";
      break;
    }

    const batch = adaptiveCatchUp ? ids.slice(index, index + effectiveBatchSize) : [ids[index]];
    const processedBeforeBatch = processed;
    const batchStats = emptyBatchStats();
    const mergeCounters = {
      batchStats,
      rateLimitCount: { value: rateLimitCount },
      transientFailureCount: { value: transientFailureCount },
      timeoutFailureCount: { value: timeoutFailureCount },
      llmFailures: { value: llmFailures },
      mentions: { value: mentions },
      accepted: { value: accepted },
      rejected: { value: rejected },
      duplicates: { value: duplicates },
      rejectReasons,
      factsEnriched: { value: factsEnriched },
      enrichedFacts,
      processed: { value: processed },
      pendingLlmCalls: { value: 0 },
    };
    const observedProviderPressureInBatch = (): number =>
      mergeCounters.rateLimitCount.value + mergeCounters.timeoutFailureCount.value;
    const isPastProviderBudgetInBatch = (): boolean => {
      if (providerPressureBudget == null) return false;
      const observed = observedProviderPressureInBatch();
      if (observed >= providerPressureBudget) return true;
      return mergeCounters.pendingLlmCalls.value >= providerPressureBudget - observed;
    };

    const processFact = async (id: string): Promise<FactProcessResult | null> => {
      if (isPastDeadline()) return null;
      const f = factsDb.getById(id);
      if (!f?.text) {
        return {
          processed: 1,
          stats: emptyBatchStats(),
          rateLimitCount: 0,
          transientFailureCount: 0,
          timeoutFailureCount: 0,
        };
      }

      if (isPastProviderBudgetInBatch()) return null;

      mergeCounters.pendingLlmCalls.value++;
      try {
        const extraction = await extractEntityMentionsWithLlm(f.text, openai, model, {
          stopWords: cfg.entityExtraction.stopWords,
        });

        const stats = emptyBatchStats();
        let factRateLimit = 0;
        let factTransient = 0;
        let factTimeout = 0;

        if (adaptiveCatchUp) {
          if (extraction.pressureSignals.failed) stats.batchFailures++;
          if (extraction.pressureSignals.transientFailure) stats.batchTransientFailures++;
          if (extraction.pressureSignals.rateLimited) stats.batchRateLimited++;
          if (
            extraction.pressureSignals.rateLimited ||
            extraction.pressureSignals.transientFailure ||
            extraction.pressureSignals.retryAfterMs !== undefined
          ) {
            stats.batchPressureSignals++;
          }
          if (extraction.pressureSignals.retryAfterMs !== undefined) {
            stats.batchRetryAfterMs = extraction.pressureSignals.retryAfterMs;
          }
        }

        if (extraction.pressureSignals.rateLimited) factRateLimit = 1;
        if (extraction.pressureSignals.transientFailure) factTransient = 1;
        if (extraction.pressureSignals.failed) {
          if (extraction.pressureSignals.timeoutFailure) factTimeout = 1;
          stats.llmFailuresDelta++;
        } else {
          factsDb.applyEntityEnrichment(id, extraction.mentions, extraction.detectedLang);
        }

        stats.mentionsDelta = extraction.quality.mentions;
        stats.acceptedDelta = extraction.quality.accepted;
        stats.rejectedDelta = extraction.quality.rejected;
        stats.duplicatesDelta = extraction.quality.duplicates;
        stats.rejectReasonsDelta = { ...extraction.quality.rejectReasons };
        if (extraction.mentions.length > 0) {
          stats.factsEnrichedDelta = 1;
        }
        if (verbose && (extraction.mentions.length > 0 || extraction.rejectedMentions.length > 0)) {
          stats.enrichedFactsDelta.push({
            factId: id,
            mentions: extraction.mentions.map((m) => ({ label: m.label, surfaceText: m.surfaceText })),
            rejected: extraction.rejectedMentions.map((m) => ({
              label: m.label,
              surfaceText: m.surfaceText,
              reason: m.reason,
            })),
          });
        }

        return {
          processed: 1,
          stats,
          rateLimitCount: factRateLimit,
          transientFailureCount: factTransient,
          timeoutFailureCount: factTimeout,
        };
      } finally {
        mergeCounters.pendingLlmCalls.value--;
      }
    };

    let attemptedThisBatch = 0;
    if (adaptiveCatchUp && effectiveConcurrency > 1) {
      const results: Array<FactProcessResult | null | undefined> = new Array(batch.length);
      let nextIdx = 0;
      const canStartAnotherLlm = (): boolean => {
        if (providerPressureBudget == null) return true;
        const observed = observedProviderPressureInBatch();
        if (observed >= providerPressureBudget) return false;
        return mergeCounters.pendingLlmCalls.value < providerPressureBudget - observed;
      };
      const hasObservedProviderBudgetPressure = (): boolean =>
        providerPressureBudget != null && observedProviderPressureInBatch() >= providerPressureBudget;
      const slotWaiters: Array<() => void> = [];
      const waitForProviderSlot = async (): Promise<void> => {
        await new Promise<void>((resolve) => {
          slotWaiters.push(resolve);
        });
      };
      const notifyNextProviderSlotWaiter = () => {
        slotWaiters.shift()?.();
      };
      const notifyAllProviderSlotWaiters = () => {
        while (slotWaiters.length > 0) notifyNextProviderSlotWaiter();
      };
      const workerCount = Math.min(effectiveConcurrency, batch.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          try {
            while (true) {
              if (isPastDeadline()) {
                stopReason = "time_budget";
                return;
              }
              if (hasObservedProviderBudgetPressure()) {
                stopReason = "provider_budget";
                return;
              }
              while (!canStartAnotherLlm()) {
                if (hasObservedProviderBudgetPressure()) {
                  stopReason = "provider_budget";
                  return;
                }
                if (isPastDeadline()) {
                  stopReason = "time_budget";
                  return;
                }
                await waitForProviderSlot();
              }
              const idx = nextIdx++;
              if (idx >= batch.length) return;
              const result = await processFact(batch[idx]!);
              results[idx] = result;
              if (result == null) {
                notifyNextProviderSlotWaiter();
                continue;
              }
              applyFactProcessResult(result, mergeCounters);
              if (hasObservedProviderBudgetPressure()) {
                stopReason = "provider_budget";
                notifyAllProviderSlotWaiters();
              } else {
                notifyNextProviderSlotWaiter();
              }
            }
          } finally {
            notifyAllProviderSlotWaiters();
          }
        }),
      );
      for (const result of results) {
        if (result === undefined) continue;
        attemptedThisBatch++;
      }
      if (isPastProviderBudgetInBatch()) stopReason = "provider_budget";
      rateLimitCount = mergeCounters.rateLimitCount.value;
      transientFailureCount = mergeCounters.transientFailureCount.value;
      timeoutFailureCount = mergeCounters.timeoutFailureCount.value;
      llmFailures = mergeCounters.llmFailures.value;
      mentions = mergeCounters.mentions.value;
      accepted = mergeCounters.accepted.value;
      rejected = mergeCounters.rejected.value;
      duplicates = mergeCounters.duplicates.value;
      factsEnriched = mergeCounters.factsEnriched.value;
      processed = mergeCounters.processed.value;
    } else {
      for (const id of batch) {
        if (isPastDeadline()) {
          stopReason = "time_budget";
          break;
        }
        if (isPastProviderBudgetInBatch()) {
          stopReason = "provider_budget";
          break;
        }
        const result = await processFact(id);
        if (result == null) continue;
        attemptedThisBatch++;
        applyFactProcessResult(result, mergeCounters);
        if (isPastProviderBudgetInBatch()) stopReason = "provider_budget";
      }
      rateLimitCount = mergeCounters.rateLimitCount.value;
      transientFailureCount = mergeCounters.transientFailureCount.value;
      timeoutFailureCount = mergeCounters.timeoutFailureCount.value;
      llmFailures = mergeCounters.llmFailures.value;
      mentions = mergeCounters.mentions.value;
      accepted = mergeCounters.accepted.value;
      rejected = mergeCounters.rejected.value;
      duplicates = mergeCounters.duplicates.value;
      factsEnriched = mergeCounters.factsEnriched.value;
      processed = mergeCounters.processed.value;
    }

    if (isPastDeadline()) {
      stopReason = "time_budget";
    } else if (isPastProviderBudgetInBatch()) {
      stopReason = "provider_budget";
    }

    const currentBacklog = factsDb.getEntityEnrichmentBacklogSummary(24);
    emitProgress(currentBacklog.total);

    if (adaptiveCatchUp) {
      const hadPressure = batchStats.batchPressureSignals > 0 || batchStats.batchFailures > 0;
      const previousBatchSize = effectiveBatchSize;
      const previousDelayMs = effectiveDelayMs;
      const previousConcurrency = effectiveConcurrency;
      if (hadPressure) {
        successStreak = 0;
        effectiveBatchSize = Math.max(ADAPTIVE_MIN_BATCH_SIZE, Math.floor(effectiveBatchSize / 2));
        effectiveConcurrency = Math.max(ADAPTIVE_MIN_CONCURRENCY, Math.floor(effectiveConcurrency / 2));
        effectiveDelayMs = computeAdaptivePressureDelayMs({
          currentDelayMs: effectiveDelayMs,
          batchRetryAfterMs: batchStats.batchRetryAfterMs,
          maxAdaptiveDelayMs: ADAPTIVE_MAX_DELAY_MS,
          backoffMinDelayMs: ADAPTIVE_BACKOFF_MIN_DELAY_MS,
        });
      } else {
        successStreak++;
        if (successStreak >= ADAPTIVE_SUCCESS_STREAK_FOR_RAMP_UP) {
          successStreak = 0;
          effectiveBatchSize = Math.min(ADAPTIVE_MAX_BATCH_SIZE, effectiveBatchSize + ADAPTIVE_BATCH_SIZE_STEP);
          effectiveConcurrency = Math.min(ADAPTIVE_MAX_CONCURRENCY, effectiveConcurrency + 1);
          effectiveDelayMs = Math.max(ADAPTIVE_MIN_DELAY_MS, effectiveDelayMs - ADAPTIVE_DELAY_STEP_MS);
        }
      }
      if (
        previousBatchSize !== effectiveBatchSize ||
        previousDelayMs !== effectiveDelayMs ||
        previousConcurrency !== effectiveConcurrency
      ) {
        opts.onAdaptivePacing?.({
          reason: hadPressure ? "pressure" : "ramp-up",
          batchSize: effectiveBatchSize,
          delayMs: effectiveDelayMs,
          concurrency: effectiveConcurrency,
          previousBatchSize,
          previousDelayMs,
          previousConcurrency,
          batchPressureSignals: batchStats.batchPressureSignals,
          batchFailures: batchStats.batchFailures,
          batchTransientFailures: batchStats.batchTransientFailures,
          batchRateLimited: batchStats.batchRateLimited,
        });
      }
    }

    if (attemptedThisBatch === 0) {
      attemptedThisBatch = Math.max(0, processed - processedBeforeBatch);
    }
    index += attemptedThisBatch;
    if (stopReason === "time_budget" || stopReason === "provider_budget") break;
    if (adaptiveCatchUp && index < ids.length) {
      if (deadlineMs != null && Date.now() >= deadlineMs) {
        stopReason = "time_budget";
        break;
      }
      const sleepMs = capDelayMsByDeadline(effectiveDelayMs, deadlineMs);
      if (sleepMs > 0) {
        await delay(sleepMs);
      }
      if (deadlineMs != null && Date.now() >= deadlineMs) {
        stopReason = "time_budget";
        break;
      }
    }
  }

  if (stopReason !== "time_budget" && stopReason !== "provider_budget") {
    const allIdsAttempted = index >= ids.length;
    const hasRunPressure =
      llmFailures > 0 || rateLimitCount > 0 || timeoutFailureCount > 0 || transientFailureCount > 0;
    stopReason = allIdsAttempted && !hasRunPressure ? "completed" : "exhausted";
  }

  const finalBacklog = factsDb.getEntityEnrichmentBacklogSummary(24);
  const adaptiveSummary = adaptiveCatchUp
    ? buildEntityEnrichmentAdaptiveSummary({
        startedAtMs,
        processed,
        remainingTotal: finalBacklog.total,
        limit,
        mode,
        rateLimitCount,
        transientFailureCount,
        timeoutFailureCount,
        llmFailureCount: llmFailures,
        startBatchSize,
        endBatchSize: effectiveBatchSize,
        startDelayMs,
        endDelayMs: effectiveDelayMs,
        startConcurrency,
        endConcurrency: effectiveConcurrency,
        stopReason,
        timeBudgetSec,
      })
    : undefined;
  const telemetry =
    adaptiveSummary != null ? buildIssue1791AdaptiveTelemetry(adaptiveSummary, factsEnriched) : undefined;

  return {
    pending,
    pendingTotal,
    pendingByTier: finalBacklog.byTier,
    processed,
    factsEnriched,
    mode,
    effectiveLimit,
    remainingTotal: finalBacklog.total,
    estimatedRunsRemaining: mode === "all" ? 0 : Math.ceil(finalBacklog.total / Math.max(1, limit)),
    mentions,
    accepted,
    rejected,
    duplicates,
    rejectReasons,
    enrichedFacts: verbose && enrichedFacts.length > 0 ? enrichedFacts : undefined,
    llmFailures: llmFailures > 0 ? llmFailures : undefined,
    stopReason,
    adaptiveSummary,
    telemetry,
  };
}

export type EntityEnrichmentCliResult = Awaited<ReturnType<typeof runEntityEnrichmentForCli>>;
