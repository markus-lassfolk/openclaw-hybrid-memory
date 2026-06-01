/**
 * Batch backfill for fact NER / contact-org layer (#985). Used by `hybrid-mem enrich-entities`.
 */

import type OpenAI from "openai";

import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { getCronModelConfig, getDefaultCronModel } from "../config.js";
import { extractEntityMentionsWithLlm } from "./entity-enrichment.js";

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
  effectiveBatchSize?: number;
  effectiveDelayMs?: number;
};

export type EntityEnrichmentAdaptivePacing = {
  reason: "pressure" | "ramp-up";
  batchSize: number;
  delayMs: number;
  previousBatchSize: number;
  previousDelayMs: number;
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
    onProgress?: (progress: EntityEnrichmentProgress) => void;
    onAdaptivePacing?: (state: EntityEnrichmentAdaptivePacing) => void;
  },
): Promise<{
  /** Candidate count in the selected batch. */
  pending: number;
  /** Full pending backlog count (across all tiers). */
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
  let effectiveBatchSize = sanitizeBatchSize(opts.batchSize ?? 20);
  let effectiveDelayMs = sanitizeBatchDelayMs(opts.batchDelayMs ?? 150);
  if (adaptiveCatchUp) {
    effectiveBatchSize = Math.max(ADAPTIVE_MIN_BATCH_SIZE, Math.min(ADAPTIVE_MAX_BATCH_SIZE, effectiveBatchSize));
    effectiveDelayMs = Math.max(ADAPTIVE_MIN_DELAY_MS, Math.min(ADAPTIVE_MAX_DELAY_MS, effectiveDelayMs));
  }
  let factsEnriched = 0;
  let processed = 0;
  let mentions = 0;
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  let llmFailures = 0;
  const rejectReasons: Record<string, number> = {};
  const enrichedFacts: EntityEnrichmentVerboseFact[] = [];
  opts.onProgress?.({
    processed: 0,
    total: ids.length,
    factsEnriched: 0,
    pendingTotal,
    remainingTotal: pendingTotal,
    estimatedRunsRemaining: mode === "all" ? 0 : Math.ceil(pendingTotal / Math.max(1, limit)),
    mode,
    mentions: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    rejectReasons: {},
    effectiveBatchSize: adaptiveCatchUp ? effectiveBatchSize : undefined,
    effectiveDelayMs: adaptiveCatchUp ? effectiveDelayMs : undefined,
  });
  let successStreak = 0;
  for (let index = 0; index < ids.length; ) {
    const batch = adaptiveCatchUp ? ids.slice(index, index + effectiveBatchSize) : [ids[index]];
    let batchFailures = 0;
    let batchPressureSignals = 0;
    let batchTransientFailures = 0;
    let batchRateLimited = 0;
    let batchRetryAfterMs: number | undefined;
    for (const id of batch) {
      processed++;
      const f = factsDb.getById(id);
      if (f?.text) {
        const extraction = await extractEntityMentionsWithLlm(f.text, openai, model, {
          stopWords: cfg.entityExtraction.stopWords,
        });
        if (adaptiveCatchUp && extraction.pressureSignals.failed) {
          batchFailures++;
        }
        if (adaptiveCatchUp && extraction.pressureSignals.transientFailure) {
          batchTransientFailures++;
        }
        if (adaptiveCatchUp && extraction.pressureSignals.rateLimited) {
          batchRateLimited++;
        }
        if (
          adaptiveCatchUp &&
          (extraction.pressureSignals.rateLimited ||
            extraction.pressureSignals.transientFailure ||
            extraction.pressureSignals.retryAfterMs !== undefined)
        ) {
          batchPressureSignals++;
        }
        if (adaptiveCatchUp && extraction.pressureSignals.retryAfterMs !== undefined) {
          batchRetryAfterMs = Math.max(batchRetryAfterMs ?? 0, extraction.pressureSignals.retryAfterMs);
        }
        if (!extraction.pressureSignals.failed) {
          factsDb.applyEntityEnrichment(id, extraction.mentions, extraction.detectedLang);
        } else {
          llmFailures++;
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
      }
    }
    const currentBacklog = factsDb.getEntityEnrichmentBacklogSummary(24);
    const remainingTotal = currentBacklog.total;
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
      effectiveBatchSize: adaptiveCatchUp ? effectiveBatchSize : undefined,
      effectiveDelayMs: adaptiveCatchUp ? effectiveDelayMs : undefined,
    });
    if (adaptiveCatchUp) {
      const hadPressure = batchPressureSignals > 0 || batchFailures > 0;
      const previousBatchSize = effectiveBatchSize;
      const previousDelayMs = effectiveDelayMs;
      if (hadPressure) {
        successStreak = 0;
        effectiveBatchSize = Math.max(ADAPTIVE_MIN_BATCH_SIZE, Math.floor(effectiveBatchSize / 2));
        const retryAfterDelay = Math.max(batchRetryAfterMs ?? 0, effectiveDelayMs);
        const scaledDelay = Math.ceil(retryAfterDelay * 1.5);
        effectiveDelayMs = Math.min(
          ADAPTIVE_MAX_DELAY_MS,
          Math.max(ADAPTIVE_BACKOFF_MIN_DELAY_MS, scaledDelay, batchRetryAfterMs ?? 0),
        );
      } else {
        successStreak++;
        if (successStreak >= ADAPTIVE_SUCCESS_STREAK_FOR_RAMP_UP) {
          successStreak = 0;
          effectiveBatchSize = Math.min(ADAPTIVE_MAX_BATCH_SIZE, effectiveBatchSize + ADAPTIVE_BATCH_SIZE_STEP);
          effectiveDelayMs = Math.max(ADAPTIVE_MIN_DELAY_MS, effectiveDelayMs - ADAPTIVE_DELAY_STEP_MS);
        }
      }
      if (previousBatchSize !== effectiveBatchSize || previousDelayMs !== effectiveDelayMs) {
        opts.onAdaptivePacing?.({
          reason: hadPressure ? "pressure" : "ramp-up",
          batchSize: effectiveBatchSize,
          delayMs: effectiveDelayMs,
          previousBatchSize,
          previousDelayMs,
          batchPressureSignals,
          batchFailures,
          batchTransientFailures,
          batchRateLimited,
        });
      }
    }
    index += batch.length;
    if (adaptiveCatchUp && index < ids.length) {
      await delay(effectiveDelayMs);
    }
  }
  const finalBacklog = factsDb.getEntityEnrichmentBacklogSummary(24);
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
  };
}
