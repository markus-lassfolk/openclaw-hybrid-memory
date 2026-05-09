/**
 * Reflection service: pattern synthesis from memory facts.
 *
 * Three layers:
 * 1. Patterns (runReflection): Extract high-level patterns from recent facts
 * 2. Rules (runReflectionRules): Synthesize patterns into actionable one-liners
 * 3. Meta-patterns (runReflectionMeta): Synthesize patterns into 1-3 meta-patterns
 */

import { createHash, randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { MemoryCategory, MemoryEntry } from "../types/memory.js";
import {
  REFLECTION_DEDUPE_THRESHOLD,
  REFLECTION_DEDUPE_LOAD_TIMEOUT_MS,
  REFLECTION_DEDUPE_MAX_ROWS_PER_RUN,
  REFLECTION_DEDUPE_429_CIRCUIT_BREAKER_THRESHOLD,
  REFLECTION_DEDUPE_429_CIRCUIT_BREAKER_BACKOFF_MS,
  REFLECTION_IMPORTANCE,
  REFLECTION_MAX_FACTS_PER_CATEGORY,
  REFLECTION_MAX_FACT_LENGTH,
  REFLECTION_META_MAX_CHARS,
  REFLECTION_PATTERN_MAX_CHARS,
  REFLECTION_TEMPERATURE,
} from "../utils/constants.js";
import { getEnv } from "../utils/env-manager.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { withTimeout } from "../utils/timeout.js";
import { is429OrWrapped, is403QuotaOrRateLimitLike, LLMRetryError } from "./chat.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "./adaptive-maintenance-llm.js";
import { CostFeature } from "./cost-feature-labels.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { shouldSuppressEmbeddingError } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";
import type { ProvenanceService } from "./provenance.js";
import { persistCanonicalFactEmbedding } from "../utils/fact-embeddings.js";

const REFLECTION_PATTERN_MIN_CHARS = 20;
const REFLECTION_RULE_MIN_CHARS = 10;
const REFLECTION_RULE_MAX_CHARS = 120;
const REFLECTION_META_MIN_CHARS = 20;
const REFLECTION_MAX_PATTERNS_FOR_RULES = 50;
const REFLECTION_MAX_PATTERNS_FOR_META = 30;

/** Non-superseded, non-expired pattern facts (same filter as reflection dedupe corpus). */
export function countActivePatternFactsForMaintenance(factsDb: FactsDB): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return factsDb
    .getByCategory("pattern")
    .filter((f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec)).length;
}

export interface ReflectionConfig {
  defaultWindow: number;
  minObservations: number;
  enabled?: boolean;
}

interface ReflectionOptions {
  window: number;
  dryRun: boolean;
  model: string;
  verbose?: boolean;
  fallbackModels?: string[];
  modelSource?: string;
  adaptiveStatePath?: string;
}

interface ReflectionResult {
  factsAnalyzed: number;
  patternsExtracted: number;
  patternsStored: number;
  window: number;
}

interface ReflectionRulesResult {
  rulesExtracted: number;
  rulesStored: number;
}

interface ReflectionMetaResult {
  metaExtracted: number;
  metaStored: number;
}

/**
 * Normalize vector to unit length.
 */
export function normalizeVector(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/**
 * Compute dot product between two PRE-NORMALIZED vectors.
 * This is an optimized version that assumes both vectors are already unit-length.
 * Returns the dot product, which equals cosine similarity for normalized vectors.
 *
 * IMPORTANT: Use this ONLY when vectors are normalized via normalizeVector() first.
 * For arbitrary (non-normalized) vectors, use cosineSimilarity from ambient-retrieval.ts instead.
 */
export function dotProductSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Build normalized dedupe-corpus vectors for existing facts: prefer LanceDB rows (same id as fact),
 * else call the embedding API. Batches API calls (20) with adaptive throttle based on rate limits.
 * Wrapped with timeout to prevent indefinite hangs during VectorDB operations.
 *
 * Implements circuit breaker: after N consecutive 429s, pauses and returns partial results.
 * Supports resumable processing via checkpoint cursor (future enhancement).
 */
export async function loadReflectionDedupeCorpusVectors(
  facts: MemoryEntry[],
  embeddings: EmbeddingProvider,
  vectorDb: VectorDB,
  logger: { info: (msg: string) => void; warn?: (msg: string) => void },
  logPrefix: string,
  captureOperation: string,
  markEmbeddingModel?: (factId: string, model: string) => void,
  dryRun = false,
): Promise<(number[] | null)[]> {
  const loadWithTimeout = async (): Promise<(number[] | null)[]> => {
    const startMs = Date.now();
    const logWarn = (msg: string) => (logger.warn ?? logger.info)(msg);
    const vdb = vectorDb as VectorDB & {
      getVectorDim?: () => number;
      getVectorsByFactIds?: (ids: string[]) => Promise<Map<string, number[]>>;
      store?: (entry: {
        text: string;
        vector: number[];
        importance: number;
        category: string;
        id?: string;
      }) => Promise<string>;
      isLanceDbAvailable?: () => boolean;
      isLanceAvailable?: () => boolean;
    };
    const dim = typeof vdb.getVectorDim === "function" ? vdb.getVectorDim() : 0;
    const canPersistToLance =
      typeof vdb.isLanceDbAvailable === "function"
        ? vdb.isLanceDbAvailable()
        : typeof vdb.isLanceAvailable === "function"
          ? vdb.isLanceAvailable()
          : true;
    let byId = new Map<string, number[]>();

    const maxRowsThisRun = REFLECTION_DEDUPE_MAX_ROWS_PER_RUN;
    const effectiveFacts = facts.length > maxRowsThisRun ? facts.slice(0, maxRowsThisRun) : facts;

    if (facts.length > maxRowsThisRun) {
      logWarn(
        `${logPrefix} — dedupe corpus: limiting to ${maxRowsThisRun} rows (total ${facts.length}) to prevent unbounded backlog work. Remaining ${facts.length - maxRowsThisRun} rows will be processed in future runs.`,
      );
    }

    logger.info(
      `${logPrefix} — dedupe corpus: loading vectors from Lance index for ${effectiveFacts.length} fact(s)${facts.length > effectiveFacts.length ? ` (capped from ${facts.length})` : ""}...`,
    );

    if (typeof vdb.getVectorsByFactIds === "function") {
      try {
        byId = await vdb.getVectorsByFactIds(effectiveFacts.map((f) => f.id));
        const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
        logger.info(
          `${logPrefix} — dedupe corpus: loaded ${byId.size} vector(s) from Lance index (elapsed: ${elapsedS}s)`,
        );
      } catch (err) {
        logger.info(`${logPrefix} — dedupe corpus: Lance index load failed, will use embedding API for all: ${err}`);
        byId = new Map();
      }
    }

    const result: (number[] | null)[] = new Array(facts.length);
    let lanceHits = 0;
    let lanceModelOkHits = 0;
    let lanceModelMissingHits = 0;
    let lanceModelMismatchSkips = 0;
    let apiEmbeds = 0;
    let apiPersisted = 0;
    let apiPersistFailures = 0;
    let embedFailures = 0;
    let nonNullSoFar = 0;
    let embedAttemptsThisRun = 0;
    let consecutive429s = 0;
    let total429s = 0;
    let throttleDelayMs = 200;
    const startedAt = Date.now();
    let lastProgressAt = startedAt;

    logger.info(
      `${logPrefix} — dedupe corpus: processing ${effectiveFacts.length} facts in batches of 20 (${dryRun ? "dry-run: no Lance checkpoint / metadata writes" : "checkpointing API-hydrated vectors"})`,
    );

    const totalBatches = Math.ceil(effectiveFacts.length / 20);
    let batchNumber = 0;

    for (let i = 0; i < effectiveFacts.length; i += 20) {
      const batchStartedAt = Date.now();
      const end = Math.min(i + 20, effectiveFacts.length);
      batchNumber++;
      let hadApiEmbed = false;
      let had429ThisBatch = false;
      let batchLance = 0;
      let batchApi = 0;
      let batchPersisted = 0;
      let batchPersistFailures = 0;
      let batchEmbedFailures = 0;
      let batchMismatchSkips = 0;

      for (let j = i; j < end; j++) {
        const f = effectiveFacts[j]!;
        const cached = byId.get(f.id.toLowerCase()) ?? byId.get(f.id);
        const modelKnown = f.embeddingModel != null && embeddings.modelName != null;
        const modelOk = modelKnown && f.embeddingModel === embeddings.modelName;
        const useCache = dim > 0 && cached != null && cached.length === dim && (!modelKnown || modelOk);
        if (useCache) {
          result[j] = normalizeVector(cached);
          nonNullSoFar++;
          lanceHits++;
          batchLance++;
          if (modelOk) lanceModelOkHits++;
          else if (!f.embeddingModel) {
            lanceModelMissingHits++;
            if (!dryRun && embeddings.modelName && markEmbeddingModel) {
              try {
                markEmbeddingModel(f.id, embeddings.modelName);
              } catch (markErr) {
                logger.info(
                  `${logPrefix} — dedupe corpus: failed to mark embedding model for cached fact ${f.id}: ${markErr}`,
                );
              }
            }
          }
        } else {
          if (dim > 0 && cached != null && cached.length === dim && modelKnown && !modelOk) {
            lanceModelMismatchSkips++;
            batchMismatchSkips++;
          }
          try {
            embedAttemptsThisRun++;
            const vec = await embeddings.embed(f.text);
            result[j] = normalizeVector(vec);
            nonNullSoFar++;
            apiEmbeds++;
            batchApi++;
            hadApiEmbed = true;
            consecutive429s = 0;

            if (!dryRun && typeof vdb.store === "function") {
              let persistSucceeded = !canPersistToLance;
              if (canPersistToLance) {
                try {
                  await vdb.store({
                    text: f.text,
                    vector: vec,
                    importance: typeof f.importance === "number" ? f.importance : REFLECTION_IMPORTANCE,
                    category: f.category,
                    id: f.id,
                  });
                  apiPersisted++;
                  batchPersisted++;
                  persistSucceeded = true;
                } catch (storeErr) {
                  apiPersistFailures++;
                  batchPersistFailures++;
                  logger.info(
                    `${logPrefix} — dedupe corpus: failed to persist hydrated vector for fact ${f.id}: ${storeErr}`,
                  );
                }
              }
              if (persistSucceeded && embeddings.modelName && markEmbeddingModel) {
                try {
                  markEmbeddingModel(f.id, embeddings.modelName);
                } catch (markErr) {
                  logger.info(
                    `${logPrefix} — dedupe corpus: failed to mark embedding model for hydrated fact ${f.id}: ${markErr}`,
                  );
                }
              }
            }
          } catch (err) {
            const isRateLimit =
              is429OrWrapped(err instanceof Error ? err : new Error(String(err))) || is403QuotaOrRateLimitLike(err);

            if (isRateLimit) {
              consecutive429s++;
              total429s++;
              had429ThisBatch = true;

              if (consecutive429s >= REFLECTION_DEDUPE_429_CIRCUIT_BREAKER_THRESHOLD) {
                const failedAtRow = j;
                const remainingInSlice = effectiveFacts.length - failedAtRow;
                logWarn(
                  `[embedding-quota] ${logPrefix} — circuit breaker triggered: ${consecutive429s} consecutive 429s. ` +
                    `Stopped at row ${failedAtRow}/${effectiveFacts.length} in this run, deferring ${remainingInSlice}. ` +
                    `Total 429s this run: ${total429s}. Will resume in next dream-cycle.`,
                );
                for (let k = j; k < effectiveFacts.length; k++) {
                  result[k] = null;
                }
                for (let k = effectiveFacts.length; k < facts.length; k++) {
                  result[k] = null;
                }
                return result;
              }

              throttleDelayMs = Math.min(throttleDelayMs * 2, 10_000);
              logWarn(
                `[embedding-quota] ${logPrefix} — 429 rate limit (${consecutive429s} consecutive, ${total429s} total) — ` +
                  `increasing throttle to ${throttleDelayMs}ms`,
              );
            } else {
              embedFailures++;
              batchEmbedFailures++;
            }

            if (!shouldSuppressEmbeddingError(err)) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                operation: captureOperation,
                subsystem: "embeddings",
                factId: f.id,
              });
            }
            result[j] = null;
            hadApiEmbed = true;
          }
        }
      }

      const elapsedMs = Date.now() - startedAt;
      const batchMs = Date.now() - batchStartedAt;
      const processed = end;
      const remainingSlice = effectiveFacts.length - end;
      const ok = nonNullSoFar;
      const elapsedS = (elapsedMs / 1000).toFixed(1);
      const capDeferred = facts.length - effectiveFacts.length;
      const periodicBatchLog =
        (effectiveFacts.length <= 500 && (batchNumber % 5 === 0 || end === effectiveFacts.length)) ||
        (effectiveFacts.length > 500 &&
          effectiveFacts.length <= 1000 &&
          (batchNumber % 10 === 0 || end % 200 === 0 || end === effectiveFacts.length)) ||
        (effectiveFacts.length > 1000 && (batchNumber % 20 === 0 || end % 400 === 0 || end === effectiveFacts.length));

      const shouldLog =
        periodicBatchLog ||
        effectiveFacts.length > 1000 ||
        batchApi > 0 ||
        had429ThisBatch ||
        batchMs >= 5000 ||
        Date.now() - lastProgressAt >= 10_000 ||
        end === effectiveFacts.length;

      if (shouldLog) {
        lastProgressAt = Date.now();
        logger.info(
          `${logPrefix} — dedupe corpus progress: batch ${batchNumber}/${Math.max(1, totalBatches)}, ${processed}/${effectiveFacts.length} processed, ${remainingSlice} remaining this run` +
            (capDeferred > 0 ? ` (${capDeferred} row(s) capped for next run)` : "") +
            `; batch=${batchMs}ms (Lance ${batchLance}, API ${batchApi}, persisted ${batchPersisted}, persistFailures ${batchPersistFailures}, embedFailures ${batchEmbedFailures}, mismatchSkips ${batchMismatchSkips}); totals: Lance ${lanceHits} (model-ok ${lanceModelOkHits}, missing ${lanceModelMissingHits}, mismatch-skips ${lanceModelMismatchSkips}), API ${apiEmbeds}, persisted ${apiPersisted}, persistFailures ${apiPersistFailures}, embedFailures ${embedFailures}, 429s=${total429s}, throttle=${throttleDelayMs}ms, non-null ${ok}; elapsed=${elapsedMs}ms (${elapsedS}s)`,
        );
      }

      if (hadApiEmbed && end < effectiveFacts.length) {
        const batchDelay = had429ThisBatch
          ? Math.max(throttleDelayMs, REFLECTION_DEDUPE_429_CIRCUIT_BREAKER_BACKOFF_MS / 3)
          : throttleDelayMs;
        await new Promise((r) => setTimeout(r, batchDelay));
      }
    }

    for (let idx = effectiveFacts.length; idx < facts.length; idx++) {
      result[idx] = null;
    }

    if (effectiveFacts.length > 0) {
      const ok = result.filter((v) => v !== null).length;
      const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
      const deferredCap = facts.length - effectiveFacts.length;
      logger.info(
        `${logPrefix} — dedupe corpus: completed ${Math.max(1, totalBatches)} batch(es), ${lanceHits} vector(s) reused from Lance index (model-ok ${lanceModelOkHits}, missing ${lanceModelMissingHits}, mismatch-skips ${lanceModelMismatchSkips}), ${apiEmbeds} row(s) hydrated via embedding API (${embedAttemptsThisRun} attempt(s)), ${apiPersisted} persisted to Lance (${apiPersistFailures} persist failure(s)), ${embedFailures} embed failure(s), ${total429s} embedding rate-limit event(s), throttle=${throttleDelayMs}ms, ${ok}/${facts.length} non-null for cosine check (elapsed: ${elapsedS}s)` +
          (deferredCap > 0 ? `; ${deferredCap} row(s) deferred to next run (per-run cap)` : ""),
      );
    }
    return result;
  };

  // Wrap the entire operation with a timeout
  const result = await withTimeout(REFLECTION_DEDUPE_LOAD_TIMEOUT_MS, loadWithTimeout);

  if (result === null) {
    (logger.warn ?? logger.info)(
      `${logPrefix} — dedupe corpus: timed out after ${REFLECTION_DEDUPE_LOAD_TIMEOUT_MS}ms while loading ${facts.length} vectors; falling back to empty corpus (dedupe disabled for this run)`,
    );
    return new Array(facts.length).fill(null);
  }

  return result;
}

/**
 * Parse PATTERN: lines from reflection LLM response. Exported for tests.
 */
export function parsePatternsFromReflectionResponse(rawResponse: string): string[] {
  const patterns: string[] = [];
  for (const line of rawResponse.split(/\n/)) {
    const m = line.match(/^\s*PATTERN:\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length >= REFLECTION_PATTERN_MIN_CHARS && text.length <= REFLECTION_PATTERN_MAX_CHARS) {
      patterns.push(text);
    }
  }
  const seenInBatch = new Set<string>();
  const unique: string[] = [];
  for (const p of patterns) {
    const key = p.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    unique.push(p);
  }
  return unique;
}

/**
 * Run reflection — gather recent facts, call LLM to extract patterns, dedupe, store.
 */
export async function runReflection(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  openai: OpenAI,
  config: ReflectionConfig,
  opts: ReflectionOptions,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  provenanceService?: ProvenanceService | null,
): Promise<ReflectionResult> {
  // Feature-gating: exit 0 if reflection is disabled
  if (config.enabled === false) {
    return { factsAnalyzed: 0, patternsExtracted: 0, patternsStored: 0, window: opts.window };
  }
  const windowDays = Math.min(90, Math.max(1, opts.window));
  const recentFacts = factsDb.getRecentFacts(windowDays);

  if (recentFacts.length < config.minObservations) {
    logger.info(`memory-hybrid: reflection — ${recentFacts.length} facts in window (min ${config.minObservations})`);
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0, window: windowDays };
  }

  // Group by category, cap length and count
  const byCategory = new Map<string, MemoryEntry[]>();
  for (const f of recentFacts) {
    const cat = f.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    const arr = byCategory.get(cat)!;
    if (arr.length >= REFLECTION_MAX_FACTS_PER_CATEGORY) continue;
    arr.push(f);
  }

  const factLines: string[] = [];
  for (const [cat, entries] of byCategory) {
    for (const e of entries) {
      const text = e.text.slice(0, REFLECTION_MAX_FACT_LENGTH).trim();
      if (text.length < 10) continue;
      factLines.push(`[${cat}] ${text}`);
    }
  }
  if (factLines.length === 0) {
    logger.info(
      `memory-hybrid: reflection — ${recentFacts.length} recent facts but all too short after trimming; skipping LLM`,
    );
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0, window: windowDays };
  }

  const factsBlock = factLines.join("\n");
  const nowSec = Math.floor(Date.now() / 1000);
  const existingPatternFacts = factsDb
    .getByCategory("pattern")
    .filter((f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec));
  const existingPatternsFingerprint = existingPatternFacts
    .map((f) => f.id)
    .sort()
    .join(",");
  const inputHash = createHash("sha256")
    .update(`${windowDays}:${opts.model}:${factsBlock}:${existingPatternsFingerprint}`)
    .digest("hex")
    .slice(0, 16);
  const prevHash = factsDb.getMaintenanceState("reflection_input_hash");
  if (prevHash === inputHash) {
    logger.info("memory-hybrid: reflection — input facts unchanged since last run, skipping LLM call");
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0, window: windowDays };
  }

  const prompt = fillPrompt(loadPrompt("reflection"), { window: String(windowDays), facts: factsBlock });

  if (opts.verbose) {
    logger.info(
      `memory-hybrid: reflection — LLM call (${prompt.length} chars, ${recentFacts.length} facts in window, model=${opts.model})`,
    );
  }

  let rawResponse: string;
  try {
    const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
    const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
      model: opts.model,
      modelSource: opts.modelSource,
      content: prompt,
      temperature: REFLECTION_TEMPERATURE,
      maxTokens: 1500,
      openai,
      fallbackModels: opts.fallbackModels ?? [],
      label: "memory-hybrid: reflection",
      feature: CostFeature.reflection,
      logger,
      adaptiveStatePath: opts.adaptiveStatePath,
      enabled: adaptiveEnabled,
    });
    if (detail.modelUsed !== opts.model) {
      logger.info(`memory-hybrid: reflection — used fallback model ${detail.modelUsed}`);
    }
    rawResponse = detail.content;
  } catch (err) {
    logger.warn(`memory-hybrid: reflection LLM failed: ${err}`);
    const retryAttempt = err instanceof LLMRetryError ? err.attemptNumber : 1;
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "reflection-llm",
      subsystem: "openai",
      windowDays,
      retryAttempt,
    });
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0, window: windowDays };
  }

  const uniqueNewPatterns = parsePatternsFromReflectionResponse(rawResponse);

  if (uniqueNewPatterns.length === 0) {
    logger.info("memory-hybrid: reflection — 0 patterns extracted from LLM");
    if (!opts.dryRun) {
      factsDb.setMaintenanceState("reflection_input_hash", inputHash);
    }
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0, window: windowDays };
  }

  logger.info(
    `memory-hybrid: reflection — LLM completed successfully: ${uniqueNewPatterns.length} candidate pattern(s) after parse (next: load prior pattern vectors for dedupe — Lance index + embedding API as needed — then each new pattern)`,
  );

  if (opts.verbose) {
    logger.info(`memory-hybrid: reflection — extracted ${uniqueNewPatterns.length} patterns:`);
    for (const pattern of uniqueNewPatterns) {
      logger.info(`  PATTERN: ${pattern}`);
    }
  }

  let existingVectors: (number[] | null)[] = [];
  if (existingPatternFacts.length > 0) {
    logger.info(
      `memory-hybrid: reflection — loading ${existingPatternFacts.length} existing pattern row(s) for dedupe (Lance vectors + embedding API when index or model is missing)`,
    );
    existingVectors = await loadReflectionDedupeCorpusVectors(
      existingPatternFacts,
      embeddings,
      vectorDb,
      logger,
      "memory-hybrid: reflection",
      "reflection-embed-existing",
      (factId, model) => factsDb.setEmbeddingModel(factId, model),
      opts.dryRun,
    );
  } else {
    logger.info("memory-hybrid: reflection — no existing pattern facts for dedupe; embedding new candidates only");
  }

  logger.info(
    `memory-hybrid: reflection — embedding ${uniqueNewPatterns.length} new candidate pattern(s) for duplicate check + storage`,
  );

  let stored = 0;
  let duplicatesSkipped = 0;
  let newPatternEmbedFailures = 0;
  const reflectionRunId = provenanceService ? randomUUID() : null;
  const candidateStartMs = Date.now();
  let candidateIndex = 0;

  for (const patternText of uniqueNewPatterns) {
    candidateIndex++;
    let vec: number[];
    try {
      vec = await embeddings.embed(patternText);
    } catch (err) {
      newPatternEmbedFailures++;
      // AllEmbeddingProvidersFailed is expected when all providers are unavailable — don't report (#486)
      if (!shouldSuppressEmbeddingError(err)) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "embed-pattern",
          severity: "info",
          subsystem: "reflection",
        });
      }
      continue; // Skip this pattern on embed failure
    }
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (const ev of existingVectors) {
      if (ev === null || ev.length === 0) continue;
      if (dotProductSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      duplicatesSkipped++;
      if (opts.verbose) {
        logger.info(`memory-hybrid: reflection — skipped duplicate: ${patternText.slice(0, 60)}...`);
      }
      continue;
    }

    if (opts.dryRun) {
      logger.info(`memory-hybrid: reflection [dry-run] would store: ${patternText.slice(0, 60)}...`);
      stored++;
      continue;
    }

    const entry = factsDb.store({
      text: patternText,
      category: "pattern" as MemoryCategory,
      importance: REFLECTION_IMPORTANCE,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "permanent",
      tags: ["reflection", "pattern"],
      extractionMethod: "reflection",
      extractionConfidence: REFLECTION_IMPORTANCE,
    });
    if (provenanceService && reflectionRunId) {
      try {
        provenanceService.addEdge(entry.id, {
          edgeType: "DERIVED_FROM",
          sourceType: "reflection",
          sourceId: reflectionRunId,
        });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "reflection-provenance-derived",
          subsystem: "provenance",
          factId: entry.id,
        });
      }
    }

    if (opts.verbose) {
      logger.info(
        `memory-hybrid: reflection — stored pattern (importance ${REFLECTION_IMPORTANCE}): ${patternText.slice(0, 80)}${patternText.length > 80 ? "..." : ""}`,
      );
    }
    try {
      persistCanonicalFactEmbedding(
        factsDb,
        entry.id,
        embeddings.modelName,
        vec,
        "reflection-fact-embeddings",
        "reflection",
        logger.warn,
      );
      await vectorDb.store({
        text: patternText,
        vector: vec,
        importance: REFLECTION_IMPORTANCE,
        category: "pattern",
        id: entry.id,
      });
      factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
    } catch (err) {
      logger.warn(`memory-hybrid: reflection vector store failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "reflection-vector-store",
        subsystem: "vector",
        factId: entry.id,
      });
    }
    existingVectors.push(normVec);
    stored++;

    // Progress logging during per-candidate dedupe (every 3 candidates or at the end)
    // This is especially helpful when checking against a large existing corpus
    if (
      opts.verbose &&
      existingPatternFacts.length > 100 &&
      (candidateIndex % 3 === 0 || candidateIndex === uniqueNewPatterns.length)
    ) {
      const elapsedS = ((Date.now() - candidateStartMs) / 1000).toFixed(1);
      logger.info(
        `memory-hybrid: reflection — dedupe progress: ${candidateIndex}/${uniqueNewPatterns.length} candidates processed, ${stored} stored, ${duplicatesSkipped} duplicates, ${newPatternEmbedFailures} embed failures (elapsed: ${elapsedS}s)`,
      );
    }
  }

  if (!opts.dryRun) {
    factsDb.setMaintenanceState("reflection_input_hash", inputHash);
  }
  logger.info(
    `memory-hybrid: reflection — finished: ${stored} pattern(s) stored in DB + vector index, ${duplicatesSkipped} skipped as near-duplicate(s), ${newPatternEmbedFailures} new-pattern embed failure(s), ${uniqueNewPatterns.length} candidate(s) total`,
  );

  return {
    factsAnalyzed: recentFacts.length,
    patternsExtracted: uniqueNewPatterns.length,
    patternsStored: stored,
    window: windowDays,
  };
}

/**
 * Rules layer — synthesize patterns into actionable one-line rules (category "rule").
 */
export async function runReflectionRules(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  openai: OpenAI,
  opts: {
    dryRun: boolean;
    model: string;
    verbose?: boolean;
    fallbackModels?: string[];
    modelSource?: string;
    adaptiveStatePath?: string;
  },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  provenanceService?: ProvenanceService | null,
): Promise<ReflectionRulesResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const patternFacts = factsDb
    .getByCategory("pattern")
    .filter((f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec));
  const patterns = patternFacts.slice(0, REFLECTION_MAX_PATTERNS_FOR_RULES).map((f) => f.text);
  if (patterns.length < 2) {
    logger.info(`memory-hybrid: reflect-rules — need at least 2 patterns, have ${patterns.length}`);
    return { rulesExtracted: 0, rulesStored: 0 };
  }
  const patternsBlock = patterns.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const prompt = fillPrompt(loadPrompt("reflection-rules"), { patterns: patternsBlock });
  if (opts.verbose) {
    logger.info(
      `memory-hybrid: reflect-rules — LLM call (${prompt.length} chars, ${patterns.length} patterns, model=${opts.model})`,
    );
  }
  let rawResponse: string;
  try {
    const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
    const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
      model: opts.model,
      modelSource: opts.modelSource,
      content: prompt,
      temperature: REFLECTION_TEMPERATURE,
      maxTokens: 800,
      openai,
      fallbackModels: opts.fallbackModels ?? [],
      label: "memory-hybrid: reflect-rules",
      feature: CostFeature.reflectionRules,
      logger,
      adaptiveStatePath: opts.adaptiveStatePath,
      enabled: adaptiveEnabled,
    });
    if (detail.modelUsed !== opts.model) {
      logger.info(`memory-hybrid: reflect-rules — used fallback model ${detail.modelUsed}`);
    }
    rawResponse = detail.content;
  } catch (err) {
    logger.warn(`memory-hybrid: reflect-rules LLM failed: ${err}`);
    const retryAttempt = err instanceof LLMRetryError ? err.attemptNumber : 1;
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "reflection-rules-llm",
      subsystem: "openai",
      retryAttempt,
    });
    return { rulesExtracted: 0, rulesStored: 0 };
  }
  const rules: string[] = [];
  for (const line of rawResponse.split(/\n/)) {
    const m = line.match(/^\s*RULE:\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length >= REFLECTION_RULE_MIN_CHARS && text.length <= REFLECTION_RULE_MAX_CHARS) rules.push(text);
  }
  const seenInBatch = new Set<string>();
  const uniqueRules: string[] = [];
  for (const r of rules) {
    const key = r.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    uniqueRules.push(r);
  }
  if (uniqueRules.length === 0) {
    logger.info("memory-hybrid: reflect-rules — 0 rules extracted from LLM");
    return { rulesExtracted: rules.length, rulesStored: 0 };
  }

  logger.info(
    `memory-hybrid: reflect-rules — LLM completed successfully: ${uniqueRules.length} candidate rule(s) after parse (next: load prior rule vectors for dedupe, then each new rule)`,
  );

  if (opts.verbose) {
    logger.info(`memory-hybrid: reflect-rules — extracted ${uniqueRules.length} rules:`);
    for (const rule of uniqueRules) {
      logger.info(`  RULE: ${rule}`);
    }
  }
  const existingRuleFacts = factsDb
    .getByCategory("rule")
    .filter((f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec));
  let existingVectors: (number[] | null)[] = [];
  if (existingRuleFacts.length > 0) {
    logger.info(
      `memory-hybrid: reflect-rules — loading ${existingRuleFacts.length} existing rule row(s) for dedupe (Lance vectors + embedding API when index or model is missing)`,
    );
    existingVectors = await loadReflectionDedupeCorpusVectors(
      existingRuleFacts,
      embeddings,
      vectorDb,
      logger,
      "memory-hybrid: reflect-rules",
      "reflection-rules-embed-existing",
      (factId, model) => factsDb.setEmbeddingModel(factId, model),
      opts.dryRun,
    );
  } else {
    logger.info("memory-hybrid: reflect-rules — no existing rule facts for dedupe; embedding new candidates only");
  }

  logger.info(
    `memory-hybrid: reflect-rules — embedding ${uniqueRules.length} new candidate rule(s) for duplicate check + storage`,
  );

  let stored = 0;
  let rulesDuplicatesSkipped = 0;
  let newRuleEmbedFailures = 0;
  const reflectionRunId = provenanceService ? randomUUID() : null;
  for (const ruleText of uniqueRules) {
    let vec: number[];
    try {
      vec = await embeddings.embed(ruleText);
    } catch (err) {
      newRuleEmbedFailures++;
      // AllEmbeddingProvidersFailed is expected when all providers are unavailable — don't report (#486)
      if (!shouldSuppressEmbeddingError(err)) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "embed-rule",
          severity: "info",
          subsystem: "reflection",
        });
      }
      continue; // Skip this rule on embed failure
    }
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (const ev of existingVectors) {
      if (ev === null || ev.length === 0) continue;
      if (dotProductSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      rulesDuplicatesSkipped++;
      if (opts.verbose) {
        logger.info(`memory-hybrid: reflect-rules — skipped duplicate: ${ruleText.slice(0, 50)}...`);
      }
      continue;
    }
    if (opts.dryRun) {
      logger.info(`memory-hybrid: reflect-rules [dry-run] would store: ${ruleText.slice(0, 50)}...`);
      stored++;
      continue;
    }
    const entry = factsDb.store({
      text: ruleText,
      category: "rule" as MemoryCategory,
      importance: REFLECTION_IMPORTANCE,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "permanent",
      tags: ["reflection", "rule"],
      extractionMethod: "reflection",
      extractionConfidence: REFLECTION_IMPORTANCE,
    });
    if (provenanceService && reflectionRunId) {
      try {
        provenanceService.addEdge(entry.id, {
          edgeType: "DERIVED_FROM",
          sourceType: "reflection",
          sourceId: reflectionRunId,
        });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "reflection-rules-provenance-derived",
          subsystem: "provenance",
          factId: entry.id,
        });
      }
    }

    if (opts.verbose) {
      logger.info(
        `memory-hybrid: reflect-rules — stored rule: ${ruleText.slice(0, 100)}${ruleText.length > 100 ? "..." : ""}`,
      );
    }
    try {
      persistCanonicalFactEmbedding(
        factsDb,
        entry.id,
        embeddings.modelName,
        vec,
        "reflection-fact-embeddings",
        "reflection",
        logger.warn,
      );
      await vectorDb.store({
        text: ruleText,
        vector: vec,
        importance: REFLECTION_IMPORTANCE,
        category: "rule",
        id: entry.id,
      });
      factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
    } catch (err) {
      logger.warn(`memory-hybrid: reflect-rules vector store failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "reflection-rules-vector-store",
        subsystem: "vector",
        factId: entry.id,
      });
    }
    existingVectors.push(normVec);
    stored++;
  }

  logger.info(
    `memory-hybrid: reflect-rules — finished: ${stored} rule(s) stored, ${rulesDuplicatesSkipped} skipped as near-duplicate(s), ${newRuleEmbedFailures} new-rule embed failure(s), ${uniqueRules.length} candidate(s) total`,
  );

  return { rulesExtracted: rules.length, rulesStored: stored };
}

/**
 * Reflection on reflections — synthesize patterns into 1-3 meta-patterns (stored as pattern + meta tag).
 */
export async function runReflectionMeta(
  factsDb: FactsDB,
  vectorDb: VectorDB,
  embeddings: EmbeddingProvider,
  openai: OpenAI,
  opts: {
    dryRun: boolean;
    model: string;
    verbose?: boolean;
    fallbackModels?: string[];
    modelSource?: string;
    adaptiveStatePath?: string;
  },
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  provenanceService?: ProvenanceService | null,
): Promise<ReflectionMetaResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const patternFacts = factsDb
    .getByCategory("pattern")
    .filter((f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec));
  const patterns = patternFacts.slice(0, REFLECTION_MAX_PATTERNS_FOR_META).map((f) => f.text);
  if (patterns.length < 3) {
    logger.info(`memory-hybrid: reflect-meta — need at least 3 patterns, have ${patterns.length}`);
    return { metaExtracted: 0, metaStored: 0 };
  }
  const patternsBlock = patterns.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const prompt = fillPrompt(loadPrompt("reflection-meta"), { patterns: patternsBlock });
  if (opts.verbose) {
    logger.info(
      `memory-hybrid: reflect-meta — LLM call (${prompt.length} chars, ${patterns.length} patterns, model=${opts.model})`,
    );
  }
  let rawResponse: string;
  try {
    const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
    const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
      model: opts.model,
      modelSource: opts.modelSource,
      content: prompt,
      temperature: REFLECTION_TEMPERATURE,
      maxTokens: 500,
      openai,
      fallbackModels: opts.fallbackModels ?? [],
      label: "memory-hybrid: reflect-meta",
      feature: CostFeature.reflectionMeta,
      logger,
      adaptiveStatePath: opts.adaptiveStatePath,
      enabled: adaptiveEnabled,
    });
    if (detail.modelUsed !== opts.model) {
      logger.info(`memory-hybrid: reflect-meta — used fallback model ${detail.modelUsed}`);
    }
    rawResponse = detail.content;
  } catch (err) {
    logger.warn(`memory-hybrid: reflect-meta LLM failed: ${err}`);
    const retryAttempt = err instanceof LLMRetryError ? err.attemptNumber : 1;
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: "reflection-meta-llm",
      subsystem: "openai",
      retryAttempt,
    });
    return { metaExtracted: 0, metaStored: 0 };
  }
  const metas: string[] = [];
  for (const line of rawResponse.split(/\n/)) {
    const m = line.match(/^\s*META:\s*(.+)/);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length >= REFLECTION_META_MIN_CHARS && text.length <= REFLECTION_META_MAX_CHARS) metas.push(text);
  }
  const seenInBatch = new Set<string>();
  const uniqueMetas: string[] = [];
  for (const x of metas) {
    const key = x.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);
    uniqueMetas.push(x);
  }
  if (uniqueMetas.length === 0) {
    logger.info("memory-hybrid: reflect-meta — 0 meta-patterns extracted from LLM");
    return { metaExtracted: metas.length, metaStored: 0 };
  }

  logger.info(
    `memory-hybrid: reflect-meta — LLM completed successfully: ${uniqueMetas.length} candidate meta-pattern(s) after parse`,
  );

  if (opts.verbose) {
    logger.info(`memory-hybrid: reflect-meta — extracted ${uniqueMetas.length} meta-patterns:`);
    for (const meta of uniqueMetas) {
      logger.info(`  META: ${meta}`);
    }
  }
  const existingMetaFacts = factsDb
    .getByCategory("pattern")
    .filter(
      (f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec) && f.tags?.includes("meta") === true,
    );
  let existingVectors: (number[] | null)[] = [];
  if (existingMetaFacts.length > 0) {
    logger.info(
      `memory-hybrid: reflect-meta — loading ${existingMetaFacts.length} existing meta-pattern row(s) for dedupe (Lance vectors + embedding API when index or model is missing)`,
    );
    existingVectors = await loadReflectionDedupeCorpusVectors(
      existingMetaFacts,
      embeddings,
      vectorDb,
      logger,
      "memory-hybrid: reflect-meta",
      "reflection-meta-embed-existing",
      (factId, model) => factsDb.setEmbeddingModel(factId, model),
      opts.dryRun,
    );
  } else {
    logger.info("memory-hybrid: reflect-meta — no existing meta-patterns for dedupe; embedding new candidates only");
  }

  logger.info(
    `memory-hybrid: reflect-meta — embedding ${uniqueMetas.length} new candidate meta-pattern(s) for duplicate check + storage`,
  );

  let stored = 0;
  let metaDuplicatesSkipped = 0;
  let newMetaEmbedFailures = 0;
  const reflectionRunId = provenanceService ? randomUUID() : null;
  for (const metaText of uniqueMetas) {
    let vec: number[];
    try {
      vec = await embeddings.embed(metaText);
    } catch (err) {
      newMetaEmbedFailures++;
      // AllEmbeddingProvidersFailed is expected when all providers are unavailable — don't report (#486)
      if (!shouldSuppressEmbeddingError(err)) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "embed-meta",
          severity: "info",
          subsystem: "reflection",
        });
      }
      continue; // Skip this meta-pattern on embed failure
    }
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (const ev of existingVectors) {
      if (ev === null || ev.length === 0) continue;
      if (dotProductSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      metaDuplicatesSkipped++;
      if (opts.verbose) {
        logger.info(`memory-hybrid: reflect-meta — skipped duplicate: ${metaText.slice(0, 50)}...`);
      }
      continue;
    }
    if (opts.dryRun) {
      logger.info(`memory-hybrid: reflect-meta [dry-run] would store: ${metaText.slice(0, 50)}...`);
      stored++;
      continue;
    }
    const entry = factsDb.store({
      text: metaText,
      category: "pattern" as MemoryCategory,
      importance: REFLECTION_IMPORTANCE,
      entity: null,
      key: null,
      value: null,
      source: "reflection",
      decayClass: "permanent",
      tags: ["reflection", "pattern", "meta"],
      extractionMethod: "reflection",
      extractionConfidence: REFLECTION_IMPORTANCE,
    });
    if (provenanceService && reflectionRunId) {
      try {
        provenanceService.addEdge(entry.id, {
          edgeType: "DERIVED_FROM",
          sourceType: "reflection",
          sourceId: reflectionRunId,
        });
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "reflection-meta-provenance-derived",
          subsystem: "provenance",
          factId: entry.id,
        });
      }
    }

    if (opts.verbose) {
      logger.info(
        `memory-hybrid: reflect-meta — stored meta-pattern: ${metaText.slice(0, 100)}${metaText.length > 100 ? "..." : ""}`,
      );
    }
    try {
      persistCanonicalFactEmbedding(
        factsDb,
        entry.id,
        embeddings.modelName,
        vec,
        "reflection-fact-embeddings",
        "reflection",
        logger.warn,
      );
      await vectorDb.store({
        text: metaText,
        vector: vec,
        importance: REFLECTION_IMPORTANCE,
        category: "pattern",
        id: entry.id,
      });
      factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
    } catch (err) {
      logger.warn(`memory-hybrid: reflect-meta vector store failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "reflection-meta-vector-store",
        subsystem: "vector",
        factId: entry.id,
      });
    }
    existingVectors.push(normVec);
    stored++;
  }

  logger.info(
    `memory-hybrid: reflect-meta — finished: ${stored} meta-pattern(s) stored, ${metaDuplicatesSkipped} skipped as near-duplicate(s), ${newMetaEmbedFailures} embed failure(s), ${uniqueMetas.length} candidate(s) total`,
  );

  return { metaExtracted: metas.length, metaStored: stored };
}
