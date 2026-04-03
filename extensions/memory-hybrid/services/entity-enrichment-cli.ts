/**
 * Batch backfill for fact NER / contact-org layer (#985). Used by `hybrid-mem enrich-entities`.
 */

import type OpenAI from "openai";

import type { FactsDB } from "../backends/facts-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { getCronModelConfig, getDefaultCronModel } from "../config.js";
import { extractEntityMentionsWithLlm } from "./entity-enrichment.js";

export async function runEntityEnrichmentForCli(
  factsDb: FactsDB,
  openai: OpenAI,
  cfg: HybridMemoryConfig,
  opts: { limit: number; dryRun: boolean; model?: string },
): Promise<{ pending: number; processed: number; factsEnriched: number }> {
  const ids = factsDb.listFactIdsNeedingEntityEnrichment(opts.limit, 24);
  if (opts.dryRun) {
    return { pending: ids.length, processed: 0, factsEnriched: 0 };
  }
  const model = opts.model ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
  let factsEnriched = 0;
  let processed = 0;
  for (const id of ids) {
    processed++;
    const f = factsDb.getById(id);
    if (!f?.text) continue;
    const { mentions, detectedLang } = await extractEntityMentionsWithLlm(f.text, openai, model);
    factsDb.applyEntityEnrichment(id, mentions, detectedLang);
    if (mentions.length > 0) {
      factsEnriched++;
    }
  }
  return { pending: ids.length, processed, factsEnriched };
}
