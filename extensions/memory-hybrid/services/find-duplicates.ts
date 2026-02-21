/**
 * Find-duplicates service (2.2): report pairs of facts with embedding similarity ≥ threshold.
 * Does not modify store. By default skips identifier-like facts; use includeStructured to include.
 */

import type { FactsDB } from "../backends/facts.js";
import type { VectorDB } from "../backends/vector.js";
import type { Embeddings, safeEmbed } from "./embeddings.js";
import { isStructuredForConsolidation } from "./consolidation.js";

export interface FindDuplicatesOptions {
  threshold: number;
  includeStructured: boolean;
  limit: number;
}

export interface FindDuplicatesResult {
  pairs: Array<{ idA: string; idB: string; score: number; textA: string; textB: string }>;
  candidatesCount: number;
  skippedStructured: number;
}

export async function runFindDuplicates(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  safeEmbedFn: typeof safeEmbed,
  opts: FindDuplicatesOptions,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<FindDuplicatesResult> {
  const facts = factsDb.getFactsForConsolidation(opts.limit);
  const skippedStructured = opts.includeStructured ? 0 : facts.filter((f) => isStructuredForConsolidation(f.text, f.entity, f.key)).length;
  const candidateFacts = opts.includeStructured
    ? facts
    : facts.filter((f) => !isStructuredForConsolidation(f.text, f.entity, f.key));
  if (candidateFacts.length < 2) {
    logger.info("memory-hybrid: find-duplicates — fewer than 2 candidate facts");
    return { pairs: [], candidatesCount: candidateFacts.length, skippedStructured };
  }

  const idToFact = new Map(candidateFacts.map((f) => [f.id, f]));
  const ids = candidateFacts.map((f) => f.id);

  logger.info(`memory-hybrid: find-duplicates — embedding ${ids.length} facts...`);
  const vectors: number[][] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    for (const id of batch) {
      const f = idToFact.get(id)!;
      const vec = await safeEmbedFn(embeddings, f.text, (msg) => logger.warn(msg));
      vectors.push(vec ?? []);
    }
    if (i + 20 < ids.length) await new Promise((r) => setTimeout(r, 200));
  }

  const idToIndex = new Map(ids.map((id, idx) => [id, idx]));
  const pairs: Array<{ idA: string; idB: string; score: number; textA: string; textB: string }> = [];
  const searchLimit = Math.min(100, ids.length);

  // Use LanceDB vector search (indexed) instead of O(n²) pairwise loop
  for (let i = 0; i < ids.length; i++) {
    const vi = vectors[i];
    if (vi.length === 0) continue;
    const results = await vectorDb.search(vi, searchLimit, opts.threshold);
    for (const r of results) {
      const j = idToIndex.get(r.entry.id);
      if (j !== undefined && j > i) {
        pairs.push({
          idA: ids[i],
          idB: ids[j],
          score: r.score,
          textA: idToFact.get(ids[i])!.text,
          textB: idToFact.get(ids[j])!.text,
        });
      }
    }
  }
  logger.info(`memory-hybrid: find-duplicates — ${pairs.length} pairs ≥ ${opts.threshold}`);
  return { pairs, candidatesCount: candidateFacts.length, skippedStructured };
}
