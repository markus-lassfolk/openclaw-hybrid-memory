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

export async function runEntityEnrichmentForCli(
  factsDb: FactsDB,
  openai: OpenAI,
  cfg: HybridMemoryConfig,
  opts: { limit: number; dryRun: boolean; model?: string; verbose?: boolean },
): Promise<{
  pending: number;
  processed: number;
  factsEnriched: number;
  skipped?: boolean;
  pendingFactIds?: string[];
  enrichedFacts?: EntityEnrichmentVerboseFact[];
}> {
  const limit = sanitizeEnrichmentLimit(opts.limit);
  const verbose = !!opts.verbose;
  if (!cfg.graph?.enabled) {
    const ids = factsDb.listFactIdsNeedingEntityEnrichment(limit, 24);
    return { pending: ids.length, processed: 0, factsEnriched: 0, skipped: true };
  }
  const ids = factsDb.listFactIdsNeedingEntityEnrichment(limit, 24);
  if (opts.dryRun) {
    return {
      pending: ids.length,
      processed: 0,
      factsEnriched: 0,
      pendingFactIds: verbose ? [...ids] : undefined,
    };
  }
  const model = opts.model ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
  let factsEnriched = 0;
  let processed = 0;
  const enrichedFacts: EntityEnrichmentVerboseFact[] = [];
  for (const id of ids) {
    processed++;
    const f = factsDb.getById(id);
    if (!f?.text) continue;
    const { mentions, detectedLang } = await extractEntityMentionsWithLlm(f.text, openai, model);
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
  return {
    pending: ids.length,
    processed,
    factsEnriched,
    enrichedFacts: verbose && enrichedFacts.length > 0 ? enrichedFacts : undefined,
  };
}
