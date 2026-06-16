/**
 * Fragment-level embedding for long documents (#1914).
 * Chunks parent facts into child fragment rows with vectors; recall can rank fragments
 * while parent context is preserved via parent_fact_id.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { LifecycleAdaptersConfig } from "../config/types/features.js";
import type { MemoryEntry } from "../types/memory.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { chunkMarkdown } from "./document-chunker.js";
import { cleanupEvictedVector } from "./vector-maintenance.js";

export type FragmentIndexResult = {
  fragmentsStored: number;
  skipped: boolean;
};

export async function indexFactFragments(opts: {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  parentFact: MemoryEntry;
  cfg: LifecycleAdaptersConfig["fragmentEmbedding"];
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<FragmentIndexResult> {
  const { factsDb, vectorDb, embeddings, parentFact, cfg, logger } = opts;
  if (!cfg.enabled) return { fragmentsStored: 0, skipped: true };
  if (parentFact.text.length < cfg.minChars) return { fragmentsStored: 0, skipped: true };

  const existing = factsDb.getRawDb().prepare("SELECT COUNT(*) AS c FROM facts WHERE parent_fact_id = ?").get(parentFact.id) as
    | { c: number }
    | undefined;
  if ((existing?.c ?? 0) > 0) return { fragmentsStored: 0, skipped: true };

  const chunks = chunkMarkdown(parentFact.text, { chunkSize: 2000, chunkOverlap: 200 });
  if (chunks.length <= 1) return { fragmentsStored: 0, skipped: true };

  let stored = 0;
  const parentSummary = parentFact.summary?.trim() || parentFact.text.slice(0, 300);

  for (const chunk of chunks) {
    const fragmentText = `[fragment of ${parentFact.id}] ${parentSummary}\n\n${chunk.text}`;
    const result = factsDb.storeWithResult({
      text: fragmentText,
      summary: chunk.sectionHeading ? `${chunk.sectionHeading}: ${chunk.text.slice(0, 160)}` : chunk.text.slice(0, 200),
      category: "fact",
      importance: Math.max(0.3, (parentFact.importance ?? 0.5) * 0.85),
      source: `fragment-of:${parentFact.id}`,
      tags: ["fragment", `parent:${parentFact.id}`],
    });

    if (result.skipped) continue;

    if (result.evictedFactId) {
      await cleanupEvictedVector({
        vectorDb,
        evictedFactId: result.evictedFactId,
        context: "fragment-embedding",
        logger,
      });
    }

    try {
      factsDb.getRawDb().prepare("UPDATE facts SET parent_fact_id = ? WHERE id = ?").run(parentFact.id, result.entry.id);
    } catch {
      /* column may be missing on very old DBs until migration */
    }

    try {
      const vector = await embeddings.embed(fragmentText);
      await vectorDb.store({
        id: result.entry.id,
        text: fragmentText,
        vector,
        importance: result.entry.importance,
        category: result.entry.category,
      });
      stored++;
    } catch (err) {
      logger?.warn?.(`memory-hybrid: fragment embed failed for ${result.entry.id}: ${err}`);
    }
  }

  if (stored > 0) {
    logger?.info?.(`memory-hybrid: indexed ${stored} fragment(s) for fact ${parentFact.id}`);
  }
  return { fragmentsStored: stored, skipped: false };
}
