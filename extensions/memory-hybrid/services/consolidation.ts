/**
 * Consolidation service (2.4): find clusters of similar facts (by embedding),
 * merge each cluster with LLM, store one fact and delete cluster.
 *
 * Uses SQLite as source; re-embeds to compute similarity (no Lance scan).
 * Merged fact is stored in both SQLite and Lance.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { Embeddings } from "./embeddings.js";
import type OpenAI from "openai";
import type { MemoryEntry, MemoryCategory } from "../types/memory.js";
import { loadPrompt, fillPrompt } from "../utils/prompt-loader.js";
import { CONSOLIDATION_MERGE_MAX_CHARS, BATCH_STORE_IMPORTANCE } from "../utils/constants.js";
import { extractTags } from "../utils/tags.js";
import { SENSITIVE_PATTERNS } from "./auto-capture.js";
import { capturePluginError } from "./error-reporter.js";
import { cosineSimilarity } from "./reflection.js";

export interface ConsolidateOptions {
  threshold: number;
  includeStructured: boolean;
  dryRun: boolean;
  limit: number;
  model: string;
}

export interface ConsolidateResult {
  clustersFound: number;
  merged: number;
  deleted: number;
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
export function isStructuredForConsolidation(
  text: string,
  entity: string | null,
  key: string | null,
): boolean {
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

/**
 * Run consolidation: cluster similar facts and merge them with LLM.
 */
export async function runConsolidate(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: Embeddings,
  openai: OpenAI,
  opts: ConsolidateOptions,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<ConsolidateResult> {
  const facts = factsDb.getFactsForConsolidation(opts.limit);
  let candidateFacts = opts.includeStructured
    ? facts
    : facts.filter((f) => !isStructuredForConsolidation(f.text, f.entity, f.key));
  if (candidateFacts.length < 2) {
    logger.info("memory-hybrid: consolidate — fewer than 2 candidate facts");
    return { clustersFound: 0, merged: 0, deleted: 0 };
  }

  const idToFact = new Map(candidateFacts.map((f) => [f.id, f]));
  const ids = candidateFacts.map((f) => f.id);

  logger.info(`memory-hybrid: consolidate — embedding ${ids.length} facts...`);
  const vectors: number[][] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    for (const id of batch) {
      const f = idToFact.get(id)!;
      try {
        const vec = await embeddings.embed(f.text);
        vectors.push(vec);
      } catch (err) {
        logger.warn(`memory-hybrid: consolidate embed failed for ${id}: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: 'consolidate-embed',
          subsystem: 'embeddings',
          factId: id,
        });
        vectors.push([]);
      }
    }
    if (i + 20 < ids.length) await new Promise((r) => setTimeout(r, 200));
  }

  const idToIndex = new Map(ids.map((id, idx) => [id, idx]));
  const edges: Array<[string, string]> = [];
  for (let i = 0; i < ids.length; i++) {
    const vi = vectors[i];
    if (vi.length === 0) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const vj = vectors[j];
      if (vj.length === 0) continue;
      const score = cosineSimilarity(vi, vj);
      if (score >= opts.threshold) edges.push([ids[i], ids[j]]);
    }
  }

  const parent = unionFind(ids, edges);
  const rootToCluster = new Map<string, string[]>();
  for (const id of ids) {
    const r = getRoot(parent, id);
    if (!rootToCluster.has(r)) rootToCluster.set(r, []);
    rootToCluster.get(r)!.push(id);
  }
  const clusters = [...rootToCluster.values()].filter((c) => c.length >= 2);
  logger.info(`memory-hybrid: consolidate — ${clusters.length} clusters (≥2 facts)`);

  if (clusters.length === 0) return { clustersFound: 0, merged: 0, deleted: 0 };

  let merged = 0;
  let deleted = 0;
  for (const clusterIds of clusters) {
    const texts = clusterIds.map((id) => idToFact.get(id)!.text);
    const factsList = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const prompt = fillPrompt(loadPrompt("consolidate"), { facts_list: factsList });
    let mergedText: string;
    try {
      // Retry logic for transient errors (rate limits, 5xx)
      const maxRetries = 2;
      let lastError: Error | undefined;
      let resp;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          resp = await openai.chat.completions.create({
            model: opts.model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
            max_tokens: 300,
          });
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      if (!resp) throw lastError;
      mergedText = (resp.choices[0]?.message?.content ?? "").trim().slice(0, CONSOLIDATION_MERGE_MAX_CHARS);
    } catch (err) {
      logger.warn(`memory-hybrid: consolidate LLM failed for cluster: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'consolidate-llm',
        subsystem: 'openai',
        clusterSize: clusterIds.length,
      });
      continue;
    }
    if (!mergedText) continue;

    const clusterFacts = clusterIds.map((id) => factsDb.getById(id)).filter(Boolean) as MemoryEntry[];
    const first = clusterFacts[0];
    const category = (first?.category as MemoryCategory) ?? "other";
    const maxSourceDate = clusterFacts.reduce(
      (acc, f) => (f.sourceDate != null && (acc == null || f.sourceDate > acc) ? f.sourceDate : acc),
      null as number | null,
    );
    const mergedTags = [...new Set(clusterFacts.flatMap((f) => f.tags ?? []))];

    if (opts.dryRun) {
      logger.info(`memory-hybrid: consolidate [dry-run] would merge ${clusterIds.length} facts → "${mergedText.slice(0, 80)}..."`);
      merged++;
      continue;
    }

    const entry = factsDb.store({
      text: mergedText,
      category,
      importance: BATCH_STORE_IMPORTANCE,
      entity: first?.entity ?? null,
      key: null,
      value: null,
      source: "conversation",
      sourceDate: maxSourceDate,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
    });
    try {
      const vector = await embeddings.embed(mergedText);
      await vectorDb.store({ text: mergedText, vector, importance: BATCH_STORE_IMPORTANCE, category, id: entry.id });
    } catch (err) {
      logger.warn(`memory-hybrid: consolidate vector store failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: 'consolidate-vector-store',
        subsystem: 'vector',
        factId: entry.id,
      });
    }
    for (const id of clusterIds) {
      factsDb.delete(id);
      deleted++;
    }
    merged++;
  }

  return { clustersFound: clusters.length, merged, deleted };
}
