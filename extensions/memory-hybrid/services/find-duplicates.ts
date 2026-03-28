/**
 * Find-duplicates service (2.2): report pairs of facts with embedding similarity >= threshold.
 * Does not modify store. By default skips identifier-like facts; use includeStructured to include.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import { isStructuredForConsolidation } from "./consolidation.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { shouldSuppressEmbeddingError } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";

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

/** Embed a batch of texts, returning null for each position if the whole batch fails. */
async function safeEmbedBatch(
  provider: EmbeddingProvider,
  texts: string[],
  logWarn: (msg: string) => void,
): Promise<(number[] | null)[]> {
  try {
    return await provider.embedBatch(texts);
  } catch (err) {
    const asErr = err instanceof Error ? err : new Error(String(err));
    if (!shouldSuppressEmbeddingError(err)) {
      capturePluginError(asErr, { operation: "safe-embed-batch", subsystem: "embeddings" });
    }
    logWarn(`memory-hybrid: embedding batch failed: ${err}`);
    return texts.map(() => null);
  }
}

const BATCH_SIZE = 20;

export async function runFindDuplicates(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  opts: FindDuplicatesOptions,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<FindDuplicatesResult> {
  const facts = factsDb.getFactsForConsolidation(opts.limit);
  const skippedStructured = opts.includeStructured
    ? 0
    : facts.filter((f) => isStructuredForConsolidation(f.text, f.entity, f.key)).length;
  const candidateFacts = opts.includeStructured
    ? facts
    : facts.filter((f) => !isStructuredForConsolidation(f.text, f.entity, f.key));
  if (candidateFacts.length < 2) {
    logger.info("memory-hybrid: find-duplicates -- fewer than 2 candidate facts");
    return { pairs: [], candidatesCount: candidateFacts.length, skippedStructured };
  }

  const idToFact = new Map(candidateFacts.map((f) => [f.id, f]));
  const ids = candidateFacts.map((f) => f.id);

  logger.info(`memory-hybrid: find-duplicates -- embedding ${ids.length} facts...`);
  const vectors: number[][] = [];
  const validIds: string[] = [];
  let skippedEmbeddings = 0;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const batchFacts = batch.flatMap((id) => {
      const fact = idToFact.get(id);
      return fact ? [{ id, fact }] : [];
    });
    const batchTexts = batchFacts.map(({ fact }) => fact.text);
    const vecs = await safeEmbedBatch(embeddings, batchTexts, (msg) => logger.warn(msg));
    // Whole batch failed: all slots are null — log once instead of once-per-fact to avoid log spam.
    if (vecs.every((v) => v === null || v.length === 0)) {
      logger.warn(
        `memory-hybrid: find-duplicates -- skipping batch of ${batch.length} facts (ids ${batch[0] ?? "unknown"}…${batch[batch.length - 1] ?? "unknown"}) due to embedding failure`,
      );
      skippedEmbeddings += batch.length;
      continue;
    }
    for (let j = 0; j < batchFacts.length; j++) {
      const item = batchFacts[j];
      if (!item) continue;
      const vec = vecs[j];
      if (!vec || vec.length === 0) {
        logger.warn(`memory-hybrid: find-duplicates -- skipping fact ${item.id} due to embedding failure`);
        skippedEmbeddings++;
        continue;
      }
      vectors.push(vec);
      validIds.push(item.id);
    }
  }

  if (skippedEmbeddings > 0) {
    logger.info(`memory-hybrid: find-duplicates -- skipped ${skippedEmbeddings} facts due to embedding failures`);
  }

  const idToIndex = new Map(validIds.map((id, idx) => [id, idx]));
  const pairs: Array<{ idA: string; idB: string; score: number; textA: string; textB: string }> = [];
  const searchLimit = Math.min(100, validIds.length);

  // Use LanceDB vector search (indexed) instead of O(n^2) pairwise loop
  for (let i = 0; i < validIds.length; i++) {
    const vi = vectors[i];
    const idA = validIds[i];
    if (!vi || !idA) continue;
    const results = await vectorDb.search(vi, searchLimit, opts.threshold);
    for (const r of results) {
      const j = idToIndex.get(r.entry.id);
      const idB = j !== undefined ? validIds[j] : undefined;
      if (j !== undefined && j > i) {
        pairs.push({
          idA,
          idB: idB ?? r.entry.id,
          score: r.score,
          textA: idToFact.get(idA)?.text ?? "",
          textB: idToFact.get(idB ?? r.entry.id)?.text ?? "",
        });
      }
    }
  }
  logger.info(`memory-hybrid: find-duplicates -- ${pairs.length} pairs >= ${opts.threshold}`);
  return { pairs, candidatesCount: candidateFacts.length, skippedStructured };
}
