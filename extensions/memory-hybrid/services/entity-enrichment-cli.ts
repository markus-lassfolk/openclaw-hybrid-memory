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

export type EntityEnrichmentMentionSummary = { label: string; surfaceText: string };

export type EntityEnrichmentVerboseFact = {
  factId: string;
  mentions: EntityEnrichmentMentionSummary[];
};

export type EntityEnrichmentProgress = {
  processed: number;
  total: number;
  factsEnriched: number;
  pendingTotal: number;
  remainingTotal: number;
  estimatedRunsRemaining: number;
  mode: "bounded" | "all";
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
    onProgress?: (progress: EntityEnrichmentProgress) => void;
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
  skipped?: boolean;
  pendingFactIds?: string[];
  enrichedFacts?: EntityEnrichmentVerboseFact[];
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
      pendingFactIds: verbose ? [...ids] : undefined,
    };
  }

  const ids = factsDb.listFactIdsNeedingEntityEnrichment(limit, 24, { all: mode === "all" });
  const pending = ids.length;
  const model = opts.model ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
  let factsEnriched = 0;
  let processed = 0;
  const enrichedFacts: EntityEnrichmentVerboseFact[] = [];
  opts.onProgress?.({
    processed: 0,
    total: ids.length,
    factsEnriched: 0,
    pendingTotal,
    remainingTotal: pendingTotal,
    estimatedRunsRemaining: mode === "all" ? 0 : Math.ceil(pendingTotal / Math.max(1, limit)),
    mode,
  });
  for (const id of ids) {
    processed++;
    const f = factsDb.getById(id);
    if (f?.text) {
      const { mentions, detectedLang } = await extractEntityMentionsWithLlm(f.text, openai, model, {
        stopWords: cfg.entityExtraction.stopWords,
      });
      factsDb.applyEntityEnrichment(id, mentions, detectedLang);
      if (mentions.length > 0) {
        factsEnriched++;
        if (verbose) {
          enrichedFacts.push({
            factId: id,
            mentions: mentions.map((m) => ({ label: m.label, surfaceText: m.surfaceText })),
          });
        }
      }
    }
    const currentBacklog = factsDb.getEntityEnrichmentBacklogSummary(24);
    opts.onProgress?.({
      processed,
      total: ids.length,
      factsEnriched,
      pendingTotal,
      remainingTotal: currentBacklog.total,
      estimatedRunsRemaining: mode === "all" ? 0 : Math.ceil(currentBacklog.total / Math.max(1, limit)),
      mode,
    });
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
    enrichedFacts: verbose && enrichedFacts.length > 0 ? enrichedFacts : undefined,
  };
}
