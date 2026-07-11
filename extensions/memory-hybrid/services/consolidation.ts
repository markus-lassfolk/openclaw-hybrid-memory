/**
 * Consolidation service (2.4): find clusters of similar facts (by embedding),
 * merge each cluster with LLM, store one fact and delete cluster.
 *
 * Uses SQLite as source; re-embeds to compute similarity (no Lance scan).
 * Merged fact is stored in both SQLite and Lance.
 */

import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryCategory, MemoryEntry } from "../types/memory.js";
import { CONSOLIDATED_FACT_DECAY_CLASS } from "../utils/consolidation-controls.js";
import { BATCH_STORE_IMPORTANCE, CONSOLIDATION_MERGE_MAX_CHARS } from "../utils/constants.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { SENSITIVE_PATTERNS } from "./auto-capture.js";
import { withCostFeature } from "./cost-context.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { shouldSuppressEmbeddingError } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";
import { isMiniMaxModel } from "./chat.js";
import {
  capTimeoutByMaintenanceRunDeadline,
  getMaintenanceRunAbortSignal,
  maintenanceRunDeadlineReached,
} from "../utils/maintenance-run-deadline.js";
import type { ProvenanceService } from "./provenance.js";
import { dotProductSimilarity, loadReflectionDedupeCorpusVectors } from "./reflection.js";
import { deleteVectorsForFactIds, cleanupEvictedVector } from "./vector-maintenance.js";

interface ConsolidateOptions {
  threshold: number;
  includeStructured: boolean;
  dryRun: boolean;
  limit: number;
  model: string;
  thinkingMode?: import("./chat.js").MiniMaxThinkingMode;
  /** Invoked once per cluster processed by the merge loop (success, skip, or failure). */
  onProgress?: (progress: { clusterIndex: number; totalClusters: number; merged: number }) => void;
}

interface ConsolidateResult {
  clustersFound: number;
  merged: number;
  deleted: number;
  clustersFailed?: number;
  vectorFailures?: number;
  semanticOutcome?: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Union-Find data structure for clustering.
 */
export function unionFind(ids: string[], edges: Array<[string, string]>): Map<string, string> {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  function find(x: string): string {
    const p = parent.get(x)!;
    if (p !== x) parent.set(x, find(p));
    return parent.get(x)!;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const [a, b] of edges) union(a, b);
  return parent;
}

/**
 * Get root ID for a cluster.
 */
export function getRoot(parent: Map<string, string>, id: string): string {
  let r = id;
  while (parent.get(r) !== r) r = parent.get(r)!;
  return r;
}

/**
 * True if fact looks like identifier/number (IP, email, phone, UUID, etc.).
 * Used by consolidate to skip by default (2.2/2.4).
 */
export function isStructuredForConsolidation(text: string, entity: string | null, key: string | null): boolean {
  if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(text)) return true;
  if (/[\w.-]+@[\w.-]+\.\w+/.test(text)) return true;
  if (/\+\d{10,}/.test(text) || /\b\d{10,}\b/.test(text)) return true;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) return true;
  const k = (key ?? "").toLowerCase();
  const e = (entity ?? "").toLowerCase();
  if (["email", "phone", "api_key", "ip", "uuid", "password"].some((x) => k.includes(x) || e.includes(x))) return true;
  // Check for sensitive patterns to prevent credential leakage in consolidation
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return false;
}

function selectConsolidatedKeyValue(facts: MemoryEntry[]): { key: string | null; value: string | null } {
  if (facts.length === 0) return { key: null, value: null };
  const highestConfidence = facts.reduce((best, f) => (f.confidence > best.confidence ? f : best), facts[0]);
  const factsWithKey = facts.filter(
    (f): f is MemoryEntry & { key: string } => typeof f.key === "string" && f.key.trim().length > 0,
  );
  if (factsWithKey.length === 0) return { key: null, value: null };

  const keyToBest = new Map<string, MemoryEntry>();
  for (const fact of factsWithKey) {
    const key = fact.key.trim();
    const prev = keyToBest.get(key);
    if (!prev || fact.confidence > prev.confidence) {
      keyToBest.set(key, fact);
    }
  }

  const keys = [...keyToBest.keys()];
  let selectedKey = keys[0];
  if (keys.length > 1) {
    selectedKey = keys.reduce((bestKey, candidate) => {
      const bestFact = keyToBest.get(bestKey)!;
      const candidateFact = keyToBest.get(candidate)!;
      if (candidateFact.confidence > bestFact.confidence) return candidate;
      if (candidateFact.confidence < bestFact.confidence) return bestKey;
      return candidate.length > bestKey.length ? candidate : bestKey;
    }, selectedKey);
  }

  const bestForKey = keyToBest.get(selectedKey)!;
  const selectedValue =
    highestConfidence.key?.trim() === selectedKey && highestConfidence.value != null
      ? highestConfidence.value
      : (bestForKey.value ?? null);
  return { key: selectedKey, value: selectedValue };
}

/**
 * Run consolidation: cluster similar facts and merge them with LLM.
 */
export async function runConsolidate(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  openai: OpenAI,
  opts: ConsolidateOptions,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  aliasDb?: import("./retrieval-aliases.js").AliasDB | null,
  provenanceService?: ProvenanceService | null,
): Promise<ConsolidateResult> {
  const facts = factsDb.getFactsForConsolidation(opts.limit);
  const candidateFacts = opts.includeStructured
    ? facts
    : facts.filter((f) => !isStructuredForConsolidation(f.text, f.entity, f.key));
  if (candidateFacts.length < 2) {
    logger.info("memory-hybrid: consolidate — fewer than 2 candidate facts");
    return { clustersFound: 0, merged: 0, deleted: 0 };
  }

  const idToFact = new Map(candidateFacts.map((f) => [f.id, f]));
  const ids = candidateFacts.map((f) => f.id);

  logger.info(`memory-hybrid: consolidate — loading vectors for ${ids.length} facts (Lance index + embedding API)...`);
  const vectorResults = await loadReflectionDedupeCorpusVectors(
    candidateFacts as MemoryEntry[],
    embeddings,
    vectorDb,
    logger,
    "memory-hybrid: consolidate",
    "consolidate-embed",
    undefined,
    opts.dryRun,
  );
  const vectors = vectorResults.map((v) => (v === null ? [] : v));

  const _idToIndex = new Map(ids.map((id, idx) => [id, idx]));
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i++) {
    const vi = vectors[i];
    if (vi.length === 0) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const vj = vectors[j];
      if (vj.length === 0) continue;
      // Never cluster facts from different scopes together: merging a tenant-scoped fact into a
      // global one (or vice versa) would either leak private content into the shared global
      // output or silently narrow a previously-global fact's visibility once the merge deletes
      // the sources. Facts must share the exact same (scope, scopeTarget) to be candidates for
      // the same merge.
      const factI = idToFact.get(ids[i]);
      const factJ = idToFact.get(ids[j]);
      if (factI?.scope !== factJ?.scope || factI?.scopeTarget !== factJ?.scopeTarget) continue;
      const score = dotProductSimilarity(vi, vj);
      if (score >= opts.threshold) edges.push([ids[i], ids[j]]);
    }
  }

  // "Same thought, different words" (living-memory P2.2): facts asserting the SAME structured
  // claim — identical non-empty (entity, key), same scope — belong in one cluster even when their
  // phrasing lands below the cosine threshold. Cosine alone was the exact "just embeddings"
  // failure mode: paraphrases drifted apart and expired before ever merging.
  const byClaim = new Map<string, string[]>();
  for (const id of ids) {
    const fact = idToFact.get(id);
    if (!fact?.entity || !fact.key) continue;
    const claimKey = `${fact.scope ?? "global"}\u0000${fact.scopeTarget ?? ""}\u0000${fact.entity.toLowerCase()}\u0000${fact.key.toLowerCase()}`;
    const group = byClaim.get(claimKey) ?? [];
    group.push(id);
    byClaim.set(claimKey, group);
  }
  for (const group of byClaim.values()) {
    for (let i = 1; i < group.length; i++) edges.push([group[0], group[i]]);
  }

  const parent = unionFind(ids, edges);
  const rootToCluster = new Map<string, string[]>();
  for (const id of ids) {
    const r = getRoot(parent, id);
    if (!rootToCluster.has(r)) rootToCluster.set(r, []);
    rootToCluster.get(r)?.push(id);
  }
  const clusters = [...rootToCluster.values()].filter((c) => c.length >= 2);
  logger.info(`memory-hybrid: consolidate — ${clusters.length} clusters (≥2 facts)`);

  if (clusters.length === 0) return { clustersFound: 0, merged: 0, deleted: 0 };

  let merged = 0;
  let deleted = 0;
  let clustersFailed = 0;
  let vectorFailures = 0;
  let storeDedupeVectorFallbackSuppressed = 0;
  const consolidationRunId = provenanceService ? randomUUID() : null;
  let clusterIndex = 0;
  for (const clusterIds of clusters) {
    clusterIndex++;
    const emitClusterProgress = () => opts.onProgress?.({ clusterIndex, totalClusters: clusters.length, merged });
    if (maintenanceRunDeadlineReached()) {
      logger.warn("memory-hybrid: consolidate stopped — maintenance run deadline reached");
      emitClusterProgress();
      break;
    }
    const texts = clusterIds.map((id) => idToFact.get(id)?.text);
    const factsList = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const prompt = fillPrompt(loadPrompt("consolidate"), { facts_list: factsList });
    let mergedText: string;
    try {
      const { chatCompleteWithRetryDetailed, resolveMaintenanceChatTimeoutMs } = await import("./chat.js");
      const detail = await withCostFeature("consolidation", () =>
        chatCompleteWithRetryDetailed({
          model: opts.model,
          content: prompt,
          temperature: 0,
          maxTokens: 300,
          openai,
          label: "memory-hybrid: consolidate",
          timeoutMs: capTimeoutByMaintenanceRunDeadline(resolveMaintenanceChatTimeoutMs(opts.model, opts.thinkingMode)),
          signal: getMaintenanceRunAbortSignal(),
          ...(opts.thinkingMode && isMiniMaxModel(opts.model) ? { thinkingMode: opts.thinkingMode } : {}),
        }),
      );
      mergedText = detail.content.slice(0, CONSOLIDATION_MERGE_MAX_CHARS);
    } catch (err) {
      logger.warn(`memory-hybrid: consolidate LLM failed for cluster: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "consolidate-llm",
        subsystem: "openai",
        clusterSize: clusterIds.length,
      });
      clustersFailed++;
      emitClusterProgress();
      continue;
    }
    if (!mergedText) {
      clustersFailed++;
      emitClusterProgress();
      continue;
    }

    const clusterFacts = clusterIds.map((id) => factsDb.getById(id)).filter(Boolean) as MemoryEntry[];
    const first = clusterFacts[0];
    const category = (first?.category as MemoryCategory) ?? "other";
    const maxSourceDate = clusterFacts.reduce(
      (acc, f) => (f.sourceDate != null && (acc == null || f.sourceDate > acc) ? f.sourceDate : acc),
      null as number | null,
    );
    const mergedTags = [...new Set([...clusterFacts.flatMap((f) => f.tags ?? []), "consolidated"])];
    const { key: mergedKey, value: mergedValue } = selectConsolidatedKeyValue(clusterFacts);

    if (opts.dryRun) {
      logger.info(
        `memory-hybrid: consolidate [dry-run] would merge ${clusterIds.length} facts → "${mergedText.slice(0, 80)}..."`,
      );
      merged++;
      emitClusterProgress();
      continue;
    }

    storeDedupeVectorFallbackSuppressed++;
    const storeResult = factsDb.storeWithResult(
      {
        text: mergedText,
        category,
        importance: BATCH_STORE_IMPORTANCE,
        entity: first?.entity ?? null,
        key: mergedKey,
        value: mergedValue,
        source: "consolidation",
        // Every fact in this cluster shares the same (scope, scopeTarget) — enforced when edges
        // were built above — so the merged output must carry that same scope forward rather than
        // defaulting to global, which would leak a tenant-scoped source fact's content globally.
        scope: (first?.scope as "global" | "user" | "agent" | "session" | undefined) ?? "global",
        scopeTarget: first?.scopeTarget ?? null,
        decayClass: CONSOLIDATED_FACT_DECAY_CLASS,
        sourceDate: maxSourceDate,
        tags: mergedTags.length > 0 ? mergedTags : undefined,
        extractionMethod: "consolidation",
        extractionConfidence: BATCH_STORE_IMPORTANCE,
        provenanceJson: JSON.stringify({
          method: "consolidation",
          consolidatedAt: Math.floor(Date.now() / 1000),
          sourceFactIds: clusterIds,
          sourceFacts: clusterFacts.map((sourceFact) => ({
            id: sourceFact.id,
            text: sourceFact.text.slice(0, 300),
            source: sourceFact.source,
            category: sourceFact.category,
          })),
        }),
      },
      {
        warnContext: "consolidation",
        suppressVectorFallbackWarning: true,
      },
    );
    if (storeResult.skipped) {
      logger.warn(
        `memory-hybrid: consolidate skipped merge store (pre-store guard blocked): "${mergedText.slice(0, 80)}..."`,
      );
      clustersFailed++;
      emitClusterProgress();
      continue;
    }
    if (storeResult.newlyStored === false) {
      logger.warn(
        `memory-hybrid: consolidate skipped merge store (dedupe resolved to existing fact ${storeResult.entry.id.slice(0, 8)}): "${mergedText.slice(0, 80)}..."`,
      );
      clustersFailed++;
      emitClusterProgress();
      continue;
    }
    const entry = storeResult.entry;
    await cleanupEvictedVector({
      vectorDb,
      evictedFactId: storeResult.evictedFactId,
      logger,
      context: "consolidation",
    });
    if (provenanceService && consolidationRunId) {
      try {
        provenanceService.addEdge(entry.id, {
          edgeType: "DERIVED_FROM",
          sourceType: "consolidation",
          sourceId: consolidationRunId,
        });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "consolidate-provenance-derived",
          subsystem: "provenance",
          factId: entry.id,
        });
      }
    }
    let vector: number[] | undefined;
    try {
      vector = await embeddings.embed(mergedText);
    } catch (err) {
      logger.warn(`memory-hybrid: consolidate embed failed: ${err}`);
      vectorFailures++;
      // AllEmbeddingProvidersFailed is expected when all providers are unavailable — don't report (#486)
      if (!shouldSuppressEmbeddingError(err)) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "consolidate-embed",
          subsystem: "embeddings",
          factId: entry.id,
        });
      }
    }
    if (vector !== undefined) {
      try {
        await vectorDb.store({ text: mergedText, vector, importance: BATCH_STORE_IMPORTANCE, category, id: entry.id });
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
      } catch (err) {
        logger.warn(`memory-hybrid: consolidate vector store failed: ${err}`);
        vectorFailures++;
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "consolidate-vector-store",
          subsystem: "vector",
          factId: entry.id,
        });
      }
    }
    // Source lineage is stored on facts.provenance_json. memory_links is reserved for semantic edges.
    if (provenanceService) {
      for (const sourceFact of clusterFacts) {
        try {
          provenanceService.addEdge(entry.id, {
            edgeType: "CONSOLIDATED_FROM",
            sourceType: "consolidation",
            sourceId: sourceFact.id,
            sourceText: sourceFact.text,
          });
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "consolidate-provenance-chain",
            subsystem: "provenance",
            factId: entry.id,
          });
        }
      }
    }
    if (vector === undefined) {
      // The merged fact was stored without a vector (embedding failed above). The source facts
      // still have working vectors and are still semantically searchable; the merged fact is not
      // (until a later re-embed pass fixes it). Deleting the sources here would trade searchable
      // facts for an unsearchable one — net data loss with no compensating benefit. Keep both the
      // new (lexical-only) merged fact and the sources intact; a future consolidation run can
      // retry the merge once embeddings are available again.
      logger.warn(
        `memory-hybrid: consolidate — merged fact ${entry.id.slice(0, 8)} has no vector (embed failed); keeping ${clusterIds.length} source fact(s) instead of deleting them`,
      );
      clustersFailed++;
      emitClusterProgress();
      continue;
    }
    // Delete source vectors before removing SQLite rows: if we deleted SQLite first and then
    // crashed, the vectors would be permanent orphans (no matching SQL row, unreachable by
    // reconciliation).  Deleting vectors first is safe — if we crash after vector delete but
    // before SQL delete, the next run will find the SQLite rows still present and can retry.
    //
    // Unlike every other step in this loop, this cleanup previously had no try/catch: a
    // mid-loop factsDb.delete() failure (e.g. SQLITE_BUSY under concurrent writer contention)
    // would propagate out of runConsolidate entirely, leaving every later cluster in `clusters`
    // completely unprocessed for this run instead of degrading one cluster at a time like the
    // rest of this function does.
    try {
      await deleteVectorsForFactIds(vectorDb, clusterIds, {
        operation: "consolidate-cleanup",
        logger,
      });
      for (const id of clusterIds) {
        factsDb.delete(id);
        aliasDb?.deleteByFactId(id);
        deleted++;
      }
    } catch (err) {
      logger.warn(`memory-hybrid: consolidate cleanup failed for cluster: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "consolidate-cleanup",
        subsystem: "consolidation",
        clusterSize: clusterIds.length,
      });
      clustersFailed++;
      emitClusterProgress();
      continue;
    }
    merged++;
    emitClusterProgress();
  }

  if (storeDedupeVectorFallbackSuppressed > 0) {
    logger.info(
      `memory-hybrid: consolidate — store dedupe used lexical-only for ${storeDedupeVectorFallbackSuppressed} store(s) (vectors are embedded/stored after insert in this pipeline)`,
    );
  }
  return {
    clustersFound: clusters.length,
    merged,
    deleted,
    clustersFailed: clustersFailed > 0 ? clustersFailed : undefined,
    vectorFailures: vectorFailures > 0 ? vectorFailures : undefined,
    semanticOutcome: clustersFailed > 0 || vectorFailures > 0 ? "partial" : "success",
  };
}
