/**
 * Batch backfill for fact NER / contact-org layer (#985). Used by `hybrid-mem enrich-entities`.
 */

import type OpenAI from "openai";

import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { getCronModelConfig, getDefaultCronModel } from "../config.js";
import { computeAdaptivePressureDelayMs } from "./adaptive-catch-up-pacing.js";
import { AsyncSemaphore } from "./embeddings/shared.js";
import { extractEntityMentionsWithLlm } from "./entity-enrichment.js";
import {
  buildEntityEnrichmentAdaptiveSummary,
  type EntityEnrichmentAdaptiveSummary,
  type EntityEnrichmentStopReason,
  sanitizeMaxConcurrency,
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
  for (let index = 0; index < ids.length; ) {
    if (isPastDeadline()) {
      stopReason = "time_budget";
      break;
    }

    const batch = adaptiveCatchUp ? ids.slice(index, index + effectiveBatchSize) : [ids[index]];
    const batchStats: BatchFactStats = {
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

    const processFact = async (id: string): Promise<void> => {
      if (isPastDeadline()) return;
      processed++;
      const f = factsDb.getById(id);
      if (!f?.text) return;

      const extraction = await extractEntityMentionsWithLlm(f.text, openai, model, {
        stopWords: cfg.entityExtraction.stopWords,
      });

      if (adaptiveCatchUp) {
        if (extraction.pressureSignals.failed) batchStats.batchFailures++;
        if (extraction.pressureSignals.transientFailure) batchStats.batchTransientFailures++;
        if (extraction.pressureSignals.rateLimited) batchStats.batchRateLimited++;
        if (
          extraction.pressureSignals.rateLimited ||
          extraction.pressureSignals.transientFailure ||
          extraction.pressureSignals.retryAfterMs !== undefined
        ) {
          batchStats.batchPressureSignals++;
        }
        if (extraction.pressureSignals.retryAfterMs !== undefined) {
          batchStats.batchRetryAfterMs = Math.max(
            batchStats.batchRetryAfterMs ?? 0,
            extraction.pressureSignals.retryAfterMs,
          );
        }
      }

      if (extraction.pressureSignals.rateLimited) rateLimitCount++;
      if (extraction.pressureSignals.transientFailure) transientFailureCount++;
      if (extraction.pressureSignals.failed) {
        if (extraction.pressureSignals.timeoutFailure) timeoutFailureCount++;
        llmFailures++;
        batchStats.llmFailuresDelta++;
      } else {
        factsDb.applyEntityEnrichment(id, extraction.mentions, extraction.detectedLang);
      }

      mentions += extraction.quality.mentions;
      accepted += extraction.quality.accepted;
      rejected += extraction.quality.rejected;
      duplicates += extraction.quality.duplicates;
      for (const [reason, count] of Object.entries(extraction.quality.rejectReasons)) {
        rejectReasons[reason] = (rejectReasons[reason] ?? 0) + count;
      }
      if (extraction.mentions.length > 0) {
        factsEnriched++;
      }
      if (verbose && (extraction.mentions.length > 0 || extraction.rejectedMentions.length > 0)) {
        enrichedFacts.push({
          factId: id,
          mentions: extraction.mentions.map((m) => ({ label: m.label, surfaceText: m.surfaceText })),
          rejected: extraction.rejectedMentions.map((m) => ({
            label: m.label,
            surfaceText: m.surfaceText,
            reason: m.reason,
          })),
        });
      }
    };

    if (adaptiveCatchUp && effectiveConcurrency > 1) {
      const semaphore = new AsyncSemaphore(effectiveConcurrency);
      await Promise.all(
        batch.map(async (id) => {
          await semaphore.acquire();
          try {
            await processFact(id);
          } finally {
            semaphore.release();
          }
        }),
      );
    } else {
      for (const id of batch) {
        if (isPastDeadline()) {
          stopReason = "time_budget";
          break;
        }
        await processFact(id);
      }
    }

    if (isPastDeadline()) {
      stopReason = "time_budget";
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

    index += batch.length;
    if (stopReason === "time_budget") break;
    if (adaptiveCatchUp && index < ids.length) {
      await delay(effectiveDelayMs);
    }
  }

  if (stopReason !== "time_budget") {
    stopReason = processed >= ids.length ? "completed" : "exhausted";
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
  };
}
