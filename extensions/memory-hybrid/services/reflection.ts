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
  REFLECTION_DEDUPE_429_CIRCUIT_BREAKER_BACKOFF_MS,
  REFLECTION_DEDUPE_429_CIRCUIT_BREAKER_THRESHOLD,
  REFLECTION_DEDUPE_LOAD_TIMEOUT_MS,
  REFLECTION_DEDUPE_MAX_ROWS_PER_RUN,
  REFLECTION_DEDUPE_THRESHOLD,
  REFLECTION_IMPORTANCE,
  REFLECTION_MAX_FACT_LENGTH,
  REFLECTION_MAX_FACTS_PER_CATEGORY,
  REFLECTION_META_MAX_CHARS,
  REFLECTION_PATTERN_MAX_CHARS,
  REFLECTION_TEMPERATURE,
} from "../utils/constants.js";
import { getEnv } from "../utils/env-manager.js";
import { persistCanonicalFactEmbedding } from "../utils/fact-embeddings.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { withTimeout } from "../utils/timeout.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "./adaptive-maintenance-llm.js";
import { is403QuotaOrRateLimitLike, is429OrWrapped, LLMRetryError } from "./chat.js";
import { CostFeature } from "./cost-feature-labels.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { shouldSuppressEmbeddingError } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";
import { recordMaintenanceTimestamp } from "./maintenance-timestamp.js";
import type { ProvenanceService } from "./provenance.js";
import {
  dotProductSimilarity,
  normalizeVector,
  parsePatternsFromReflectionResponse,
  REFLECTION_MAX_PATTERNS_FOR_META,
  REFLECTION_MAX_PATTERNS_FOR_RULES,
  REFLECTION_META_MIN_CHARS,
  REFLECTION_PATTERN_MIN_CHARS,
  REFLECTION_RULE_MAX_CHARS,
  REFLECTION_RULE_MIN_CHARS,
} from "./reflection/shared.js";

export { dotProductSimilarity, normalizeVector, parsePatternsFromReflectionResponse } from "./reflection/shared.js";

import { stripThinkingWrapperBlocks } from "../utils/llm-json-array.js";
import { cleanupEvictedVector } from "./vector-maintenance.js";

/** Non-superseded, non-expired pattern facts (same filter as reflection dedupe corpus). */
export function countActivePatternFactsForMaintenance(factsDb: FactsDB): number {
  return factsDb.countActiveFactsByCategory("pattern");
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
  diagnostics: ReflectionRulesDiagnostics;
}

export interface ReflectionRulesDiagnostics {
  modelResponseChars: number;
  parseSuccess: boolean;
  parsedCandidates: number;
  rejectedDuplicates: number;
  rejectedLowConfidence: number;
  stored: number;
  zeroRulesReason?: string;
  status: "ok" | "partial" | "degraded";
}

// Accepted model phrases when "0 rules" is a valid no-op rather than parse failure.
// Anchored to start-of-string but allows leading whitespace so phrases like
// "No actionable rules detected from ..." are correctly classified.
// Uses [\s\S]* to allow trailing text including newlines for multiline responses.
const VALID_NO_RULES_PATTERN =
  /^\s*(no\s+(actionable\s+)?rules?|no rules (detected|identified)|unable to extract rules|insufficient information for rules)[\s\S]*/i;

const THINKING_WRAPPER_TAGS_PATTERN = /<\/?(?:redacted_thinking|thinking|reasoning|think)>/gi;

function stripThinkingWrapperTagsKeepContent(s: string): string {
  return s.replace(THINKING_WRAPPER_TAGS_PATTERN, "").trim();
}

function extractThinkingWrapperContents(s: string): string[] {
  const matches = s.matchAll(
    /<(?:redacted_thinking|thinking|reasoning|think)>([\s\S]*?)<\/(?:redacted_thinking|thinking|reasoning|think)>/gi,
  );
  const contents: string[] = [];
  for (const match of matches) {
    const content = match[1]?.trim();
    if (content) contents.push(content);
  }
  return contents;
}

function derivePreMergeText(mergedText: string, appendedText: string): string | null {
  const appendSuffix = `\n${appendedText}`;
  const maxSuffixLen = Math.min(appendSuffix.length, mergedText.length);
  for (let suffixLen = maxSuffixLen; suffixLen >= 1; suffixLen--) {
    if (mergedText.endsWith(appendSuffix.slice(0, suffixLen))) {
      return mergedText.slice(0, mergedText.length - suffixLen);
    }
  }
  return null;
}

function rollbackMergedFactText(
  factsDb: FactsDB,
  logger: { warn: (msg: string) => void },
  opts: {
    context: string;
    factId: string;
    mergedText: string;
    appendedText: string;
    preMergeText?: string | null;
    reason: "merge-reembed-failure" | "vector-store-failure" | "metadata-update-failure";
  },
): boolean {
  const previousText = opts.preMergeText ?? derivePreMergeText(opts.mergedText, opts.appendedText);
  if (previousText == null) {
    logger.warn(
      `memory-hybrid: ${opts.context} — failed to derive pre-merge text for fact ${opts.factId.slice(0, 8)} after ${opts.reason}; leaving merged text in place`,
    );
    return false;
  }
  const restoreMergedFactText = (factsDb as FactsDB & { restoreMergedFactText?: (id: string, text: string) => boolean })
    .restoreMergedFactText;
  if (typeof restoreMergedFactText !== "function") {
    logger.warn(
      `memory-hybrid: ${opts.context} — factsDb.restoreMergedFactText unavailable for fact ${opts.factId.slice(0, 8)} after ${opts.reason}; leaving merged text in place`,
    );
    return false;
  }
  try {
    const restored = restoreMergedFactText.call(factsDb, opts.factId, previousText);
    if (!restored) {
      logger.warn(
        `memory-hybrid: ${opts.context} — rollback update did not affect fact ${opts.factId.slice(0, 8)} after ${opts.reason}; leaving merged text in place`,
      );
      return false;
    }
    logger.warn(
      `memory-hybrid: ${opts.context} — rolled back merged text for fact ${opts.factId.slice(0, 8)} after ${opts.reason} to preserve text/vector consistency`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `memory-hybrid: ${opts.context} — failed to roll back merged text for fact ${opts.factId.slice(0, 8)} after ${opts.reason}: ${err}`,
    );
    return false;
  }
}

function resolvePreMergeText(mergedText: string, appendedText: string, preMergeText?: string | null): string | null {
  return preMergeText ?? derivePreMergeText(mergedText, appendedText);
}

async function restoreMergedFactVectorState(opts: {
  context: string;
  factId: string;
  category: "pattern" | "rule";
  preMergeText: string | null;
  preMergeVector: number[] | null;
  preMergeEmbeddingModel: string | null;
  fallbackEmbeddingModel: string;
  vectorDb: VectorDB;
  factsDb: FactsDB;
  logger: { warn: (msg: string) => void };
}): Promise<void> {
  if (!opts.preMergeText) {
    opts.logger.warn(
      `memory-hybrid: ${opts.context} — pre-merge text unavailable for ${opts.factId.slice(0, 8)}; cannot restore vector state`,
    );
    return;
  }
  if (!opts.preMergeVector || opts.preMergeVector.length === 0) {
    opts.logger.warn(
      `memory-hybrid: ${opts.context} — pre-merge vector unavailable for ${opts.factId.slice(0, 8)}; leaving post-rollback vector state empty`,
    );
    return;
  }
  try {
    await opts.vectorDb.store({
      text: opts.preMergeText,
      vector: opts.preMergeVector,
      importance: REFLECTION_IMPORTANCE,
      category: opts.category,
      id: opts.factId,
    });
  } catch (err) {
    opts.logger.warn(
      `memory-hybrid: ${opts.context} — failed to restore pre-merge vector for ${opts.factId.slice(0, 8)} after rollback: ${err}`,
    );
    try {
      await opts.vectorDb.delete(opts.factId);
      opts.logger.warn(
        `memory-hybrid: ${opts.context} — deleted merged vector for ${opts.factId.slice(0, 8)} to prevent Lance drift after restore failure`,
      );
    } catch (delErr) {
      opts.logger.warn(
        `memory-hybrid: ${opts.context} — failed to delete merged vector for ${opts.factId.slice(0, 8)} after restore failure: ${delErr}`,
      );
    }
    return;
  }
  const embeddingModel =
    opts.preMergeEmbeddingModel && opts.preMergeEmbeddingModel.trim().length > 0
      ? opts.preMergeEmbeddingModel
      : opts.fallbackEmbeddingModel;
  try {
    persistCanonicalFactEmbedding(
      opts.factsDb,
      opts.factId,
      embeddingModel,
      opts.preMergeVector,
      "reflection-fact-embeddings",
      opts.context,
      opts.logger.warn.bind(opts.logger),
    );
    opts.factsDb.setEmbeddingModel(opts.factId, embeddingModel);
  } catch (err) {
    opts.logger.warn(
      `memory-hybrid: ${opts.context} — failed to restore canonical embeddings for ${opts.factId.slice(0, 8)} after rollback: ${err}`,
    );
  }
}

function reusedExistingStoreEntry(
  storeResult: {
    entry: MemoryEntry;
    embeddingStale?: boolean;
    newlyStored?: boolean;
  },
  candidateText: string,
): boolean {
  if (storeResult.newlyStored === false) return true;
  return storeResult.embeddingStale !== true && storeResult.entry.text !== candidateText;
}

interface ReflectionMetaResult {
  metaExtracted: number;
  metaStored: number;
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
          `${logPrefix} — dedupe corpus progress: batch ${batchNumber}/${Math.max(1, totalBatches)}, ${processed}/${effectiveFacts.length} processed, ${remainingSlice} remaining this run${capDeferred > 0 ? ` (${capDeferred} row(s) capped for next run)` : ""}; batch=${batchMs}ms (Lance ${batchLance}, API ${batchApi}, persisted ${batchPersisted}, persistFailures ${batchPersistFailures}, embedFailures ${batchEmbedFailures}, mismatchSkips ${batchMismatchSkips}); totals: Lance ${lanceHits} (model-ok ${lanceModelOkHits}, missing ${lanceModelMissingHits}, mismatch-skips ${lanceModelMismatchSkips}), API ${apiEmbeds}, persisted ${apiPersisted}, persistFailures ${apiPersistFailures}, embedFailures ${embedFailures}, 429s=${total429s}, throttle=${throttleDelayMs}ms, non-null ${ok}; elapsed=${elapsedMs}ms (${elapsedS}s)`,
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
        `${logPrefix} — dedupe corpus: completed ${Math.max(1, totalBatches)} batch(es), ${lanceHits} vector(s) reused from Lance index (model-ok ${lanceModelOkHits}, missing ${lanceModelMissingHits}, mismatch-skips ${lanceModelMismatchSkips}), ${apiEmbeds} row(s) hydrated via embedding API (${embedAttemptsThisRun} attempt(s)), ${apiPersisted} persisted to Lance (${apiPersistFailures} persist failure(s)), ${embedFailures} embed failure(s), ${total429s} embedding rate-limit event(s), throttle=${throttleDelayMs}ms, ${ok}/${facts.length} non-null for cosine check (elapsed: ${elapsedS}s)${deferredCap > 0 ? `; ${deferredCap} row(s) deferred to next run (per-run cap)` : ""}`,
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
  const touchReflectLastRun = () => {
    if (!opts.dryRun) recordMaintenanceTimestamp(factsDb.sqlitePath, ".reflect_last_run");
  };
  const recentFacts = factsDb.getRecentFacts(windowDays);

  if (recentFacts.length < config.minObservations) {
    logger.info(`memory-hybrid: reflection — ${recentFacts.length} facts in window (min ${config.minObservations})`);
    touchReflectLastRun();
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
    touchReflectLastRun();
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
    touchReflectLastRun();
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
    touchReflectLastRun();
    return { factsAnalyzed: recentFacts.length, patternsExtracted: 0, patternsStored: 0, window: windowDays };
  }

  const uniqueNewPatterns = parsePatternsFromReflectionResponse(rawResponse);

  if (uniqueNewPatterns.length === 0) {
    logger.info("memory-hybrid: reflection — 0 patterns extracted from LLM");
    if (!opts.dryRun) {
      factsDb.setMaintenanceState("reflection_input_hash", inputHash);
    }
    touchReflectLastRun();
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
  let storeDedupeVectorFallbackSuppressed = 0;
  const reflectionRunId = provenanceService ? randomUUID() : null;
  const candidateStartMs = Date.now();
  let candidateIndex = 0;
  const inRunFactVectors = new Map<string, { vector: number[]; embeddingModel: string }>();

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

    storeDedupeVectorFallbackSuppressed++;
    const storeResult = factsDb.storeWithResult(
      {
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
      },
      {
        warnContext: "reflection",
        suppressVectorFallbackWarning: true,
      },
    );
    if (storeResult.skipped) {
      continue;
    }
    const entry = storeResult.entry;
    const mergeExistingIndex = storeResult.embeddingStale
      ? existingPatternFacts.findIndex((f) => f.id === entry.id)
      : -1;
    const inRunMerge = storeResult.embeddingStale && mergeExistingIndex < 0 ? inRunFactVectors.get(entry.id) : null;
    const preMergeVector =
      mergeExistingIndex >= 0 && mergeExistingIndex < existingVectors.length
        ? existingVectors[mergeExistingIndex]
        : (inRunMerge?.vector ?? null);
    const preMergeEmbeddingModel =
      mergeExistingIndex >= 0
        ? (existingPatternFacts[mergeExistingIndex]?.embeddingModel ?? null)
        : (inRunMerge?.embeddingModel ?? null);
    // Skip reused existing facts unless this was a merge update that requires re-embed.
    if (reusedExistingStoreEntry(storeResult, patternText) && !storeResult.embeddingStale) {
      duplicatesSkipped++;
      // Keep this candidate in the in-run dedupe corpus so later patterns don't miss near-duplicates.
      existingVectors.push(normVec);
      if (opts.verbose) {
        logger.info(`memory-hybrid: reflection — skipped store-level duplicate: ${patternText.slice(0, 60)}...`);
      }
      continue;
    }
    // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
    await cleanupEvictedVector({
      vectorDb: vectorDb,
      evictedFactId: storeResult.evictedFactId,
      logger: logger,
      context: "reflection",
    });
    if (opts.verbose) {
      logger.info(
        `memory-hybrid: reflection — stored pattern (importance ${REFLECTION_IMPORTANCE}): ${patternText.slice(0, 80)}${patternText.length > 80 ? "..." : ""}`,
      );
    }
    // If embeddingStale=true (merge path), re-embed the updated merged text
    const textToEmbed = storeResult.embeddingStale ? entry.text : patternText;
    let vectorToStore: number[];
    try {
      vectorToStore = storeResult.embeddingStale ? await embeddings.embed(textToEmbed) : vec;
    } catch (err) {
      newPatternEmbedFailures++;
      if (!shouldSuppressEmbeddingError(err)) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "embed-pattern-merge",
          severity: "info",
          subsystem: "reflection",
        });
      }
      if (storeResult.embeddingStale) {
        rollbackMergedFactText(factsDb, logger, {
          context: "reflection",
          factId: entry.id,
          mergedText: entry.text,
          appendedText: patternText,
          preMergeText: storeResult.preMergeText,
          reason: "merge-reembed-failure",
        });
      }
      continue;
    }
    let vectorStored = false;
    try {
      await vectorDb.store({
        text: textToEmbed,
        vector: vectorToStore,
        importance: REFLECTION_IMPORTANCE,
        category: "pattern",
        id: entry.id,
      });
      vectorStored = true;
    } catch (err) {
      logger.warn(`memory-hybrid: reflection vector store failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "reflection-vector-store",
        subsystem: "vector",
        factId: entry.id,
      });
      if (storeResult.embeddingStale) {
        const preMergeText = resolvePreMergeText(entry.text, patternText, storeResult.preMergeText);
        const rolledBack = rollbackMergedFactText(factsDb, logger, {
          context: "reflection",
          factId: entry.id,
          mergedText: entry.text,
          appendedText: patternText,
          preMergeText: storeResult.preMergeText,
          reason: "vector-store-failure",
        });
        if (rolledBack) {
          await restoreMergedFactVectorState({
            context: "reflection",
            factId: entry.id,
            category: "pattern",
            preMergeText,
            preMergeVector,
            preMergeEmbeddingModel,
            fallbackEmbeddingModel: embeddings.modelName,
            vectorDb,
            factsDb,
            logger,
          });
        }
        continue;
      }
      if (storeResult.newlyStored === false) {
        logger.warn(
          `memory-hybrid: reflection — preserving existing pattern fact ${entry.id.slice(0, 8)} after vector store failure on reused entry`,
        );
        continue;
      }
      if (!storeResult.embeddingStale) {
        try {
          factsDb.delete(entry.id);
          if (provenanceService) {
            try {
              provenanceService.deleteEdgesByFactId(entry.id);
            } catch (provErr) {
              logger.warn(
                `memory-hybrid: reflection — failed to clean up provenance for pattern fact ${entry.id.slice(0, 8)}: ${provErr}`,
              );
            }
          }
          try {
            await vectorDb.delete(entry.id);
          } catch (vecErr) {
            logger.warn(
              `memory-hybrid: reflection — failed to clean up vector for pattern fact ${entry.id.slice(0, 8)}: ${vecErr}`,
            );
          }
          logger.warn(
            `memory-hybrid: reflection — deleted pattern fact ${entry.id.slice(0, 8)} after vector store failure to prevent SQLite/LanceDB split`,
          );
        } catch (deleteErr) {
          logger.warn(
            `memory-hybrid: reflection — failed to delete pattern fact ${entry.id.slice(0, 8)} after vector store failure: ${deleteErr}`,
          );
        }
        continue;
      }
    }
    if (vectorStored) {
      try {
        persistCanonicalFactEmbedding(
          factsDb,
          entry.id,
          embeddings.modelName,
          vectorToStore,
          "reflection-fact-embeddings",
          "reflection",
          logger.warn?.bind(logger),
        );
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
      } catch (err) {
        logger.warn(`memory-hybrid: reflection metadata update failed after vector store: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "reflection-metadata-update",
          subsystem: "sqlite",
          factId: entry.id,
        });
        if (storeResult.embeddingStale) {
          const preMergeText = resolvePreMergeText(entry.text, patternText, storeResult.preMergeText);
          const hasPreMergeVector = Array.isArray(preMergeVector) && preMergeVector.length > 0;
          if (!preMergeText || !hasPreMergeVector) {
            logger.warn(
              `memory-hybrid: reflection — metadata rollback skipped for pattern fact ${entry.id.slice(0, 8)} because pre-merge vector state is unavailable; keeping merged text to avoid SQLite/LanceDB mismatch`,
            );
            continue;
          }
          try {
            (factsDb as FactsDB & { deleteEmbeddings?: (factId: string) => void }).deleteEmbeddings?.(entry.id);
          } catch (embErr) {
            logger.warn(
              `memory-hybrid: reflection — failed to delete canonical embeddings for pattern fact ${entry.id.slice(0, 8)} after metadata failure: ${embErr}`,
            );
          }
          if (preMergeVector && preMergeVector.length > 0) {
            try {
              await vectorDb.delete(entry.id);
            } catch (vecErr) {
              logger.warn(
                `memory-hybrid: reflection — failed to delete merged vector for pattern fact ${entry.id.slice(0, 8)} before rollback: ${vecErr}`,
              );
            }
          }
          const rolledBack = rollbackMergedFactText(factsDb, logger, {
            context: "reflection",
            factId: entry.id,
            mergedText: entry.text,
            appendedText: patternText,
            preMergeText: storeResult.preMergeText,
            reason: "metadata-update-failure",
          });
          if (rolledBack) {
            if (preMergeVector && preMergeVector.length > 0) {
              await restoreMergedFactVectorState({
                context: "reflection",
                factId: entry.id,
                category: "pattern",
                preMergeText,
                preMergeVector,
                preMergeEmbeddingModel,
                fallbackEmbeddingModel: embeddings.modelName,
                vectorDb,
                factsDb,
                logger,
              });
            } else {
              try {
                await vectorDb.delete(entry.id);
                logger.warn(
                  `memory-hybrid: reflection — deleted merged vector for pattern fact ${entry.id.slice(0, 8)} after metadata failure (no pre-merge vector to restore)`,
                );
              } catch (vecErr) {
                logger.warn(
                  `memory-hybrid: reflection — failed to delete merged vector for pattern fact ${entry.id.slice(0, 8)} after metadata failure: ${vecErr}`,
                );
              }
            }
          }
          vectorStored = false;
          continue;
        }
        // For new inserts, clean up the partial state
        if (storeResult.newlyStored !== false) {
          try {
            (factsDb as FactsDB & { deleteEmbeddings?: (factId: string) => void }).deleteEmbeddings?.(entry.id);
          } catch (embErr) {
            logger.warn(
              `memory-hybrid: reflection — failed to delete canonical embeddings for pattern fact ${entry.id.slice(0, 8)} after metadata failure: ${embErr}`,
            );
          }
          try {
            await vectorDb.delete(entry.id);
          } catch (vecErr) {
            logger.warn(
              `memory-hybrid: reflection — failed to delete Lance vector for pattern fact ${entry.id.slice(0, 8)} after metadata failure: ${vecErr}`,
            );
          }
          try {
            factsDb.delete(entry.id);
          } catch (deleteErr) {
            logger.warn(
              `memory-hybrid: reflection — failed to delete pattern fact ${entry.id.slice(0, 8)} after metadata failure: ${deleteErr}`,
            );
          }
          if (provenanceService) {
            try {
              provenanceService.deleteEdgesByFactId(entry.id);
            } catch (provErr) {
              logger.warn(
                `memory-hybrid: reflection — failed to clean up provenance for pattern fact ${entry.id.slice(0, 8)}: ${provErr}`,
              );
            }
          }
          logger.warn(
            `memory-hybrid: reflection — deleted pattern fact ${entry.id.slice(0, 8)} after metadata failure to prevent partial store`,
          );
        }
        vectorStored = false;
        continue;
      }
    }
    if (vectorStored) {
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
      // If this was a merge (embeddingStale=true), replace the existing vector for this fact ID
      // instead of pushing a duplicate vector for the same fact.
      if (storeResult.embeddingStale) {
        const existingIndex = existingPatternFacts.findIndex((f) => f.id === entry.id);
        if (existingIndex >= 0 && existingIndex < existingVectors.length) {
          existingVectors[existingIndex] = normalizeVector(vectorToStore);
        } else {
          // Fact was inserted earlier in this loop, not in pre-run snapshot
          existingVectors.push(normalizeVector(vectorToStore));
        }
        inRunFactVectors.set(entry.id, { vector: vectorToStore, embeddingModel: embeddings.modelName });
      } else {
        existingVectors.push(normalizeVector(vectorToStore));
        inRunFactVectors.set(entry.id, { vector: vectorToStore, embeddingModel: embeddings.modelName });
      }
      stored++;
    }

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
  if (storeDedupeVectorFallbackSuppressed > 0) {
    logger.info(
      `memory-hybrid: reflection — store dedupe used lexical-only for ${storeDedupeVectorFallbackSuppressed} store(s) (phase-level cosine dedupe already handled near-duplicates)`,
    );
  }

  touchReflectLastRun();
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
  const baseDiagnostics: ReflectionRulesDiagnostics = {
    modelResponseChars: 0,
    parseSuccess: false,
    parsedCandidates: 0,
    rejectedDuplicates: 0,
    rejectedLowConfidence: 0,
    stored: 0,
    status: "ok",
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const patternFacts = factsDb
    .getByCategory("pattern")
    .filter((f) => !f.supersededAt && (f.expiresAt === null || f.expiresAt > nowSec));
  const patterns = patternFacts.slice(0, REFLECTION_MAX_PATTERNS_FOR_RULES).map((f) => f.text);
  if (patterns.length < 2) {
    logger.info(`memory-hybrid: reflect-rules — need at least 2 patterns, have ${patterns.length}`);
    const diagnostics: ReflectionRulesDiagnostics = {
      ...baseDiagnostics,
      zeroRulesReason: "insufficient_patterns",
      status: "ok",
    };
    logger.info(
      "memory-hybrid: reflect-rules — diagnostics: " +
        `model_response_chars=${diagnostics.modelResponseChars} ` +
        `parse_success=${diagnostics.parseSuccess} ` +
        `parsed_candidates=${diagnostics.parsedCandidates} ` +
        `rejected_duplicates=${diagnostics.rejectedDuplicates} ` +
        `rejected_low_confidence=${diagnostics.rejectedLowConfidence} ` +
        `stored=${diagnostics.stored} ` +
        `status=${diagnostics.status} zero_rules_reason=${diagnostics.zeroRulesReason}`,
    );
    return { rulesExtracted: 0, rulesStored: 0, diagnostics };
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
    const diagnostics: ReflectionRulesDiagnostics = {
      ...baseDiagnostics,
      zeroRulesReason: "llm_call_failed",
      status: "degraded",
    };
    logger.info(
      "memory-hybrid: reflect-rules — diagnostics: " +
        `model_response_chars=${diagnostics.modelResponseChars} ` +
        `parse_success=${diagnostics.parseSuccess} ` +
        `parsed_candidates=${diagnostics.parsedCandidates} ` +
        `rejected_duplicates=${diagnostics.rejectedDuplicates} ` +
        `rejected_low_confidence=${diagnostics.rejectedLowConfidence} ` +
        `stored=${diagnostics.stored} ` +
        `status=${diagnostics.status} zero_rules_reason=${diagnostics.zeroRulesReason}`,
    );
    return { rulesExtracted: 0, rulesStored: 0, diagnostics };
  }
  const trimmedResponse = rawResponse.trim();
  const strippedResponse = stripThinkingWrapperBlocks(trimmedResponse);
  const responseForParsing = strippedResponse.length > 0 ? strippedResponse : trimmedResponse;
  const rules: string[] = [];
  const rejectedLowConfidence = 0;
  let rejectedLength = 0;
  let parseableLines = 0;
  for (const line of responseForParsing.split(/\n/)) {
    const m = line.match(/^\s*RULE:\s*(.+)/);
    if (!m) continue;
    parseableLines++;
    const text = m[1].trim();
    if (text.length >= REFLECTION_RULE_MIN_CHARS && text.length <= REFLECTION_RULE_MAX_CHARS) {
      rules.push(text);
    } else {
      rejectedLength++;
    }
  }
  const seenInBatch = new Set<string>();
  const uniqueRules: string[] = [];
  let rejectedDuplicates = 0;
  for (const r of rules) {
    const key = r.toLowerCase().replace(/\s+/g, " ");
    if (seenInBatch.has(key)) {
      rejectedDuplicates++;
      continue;
    }
    seenInBatch.add(key);
    uniqueRules.push(r);
  }
  const wrapperTagStrippedResponse = stripThinkingWrapperTagsKeepContent(trimmedResponse);
  const wrapperContents = extractThinkingWrapperContents(trimmedResponse);
  const noRulesClassificationResponse = strippedResponse.length > 0 ? strippedResponse : wrapperTagStrippedResponse;
  const looksLikeValidNoRules =
    VALID_NO_RULES_PATTERN.test(noRulesClassificationResponse) ||
    wrapperContents.some((content) => VALID_NO_RULES_PATTERN.test(content));
  const parseSuccess = parseableLines > 0 || looksLikeValidNoRules;
  const modelResponseChars = rawResponse.length;
  if (uniqueRules.length === 0) {
    logger.info("memory-hybrid: reflect-rules — 0 rules extracted from LLM");
    const zeroRulesReason =
      parseableLines > 0 && rejectedDuplicates > 0 && rejectedLowConfidence === 0 && rejectedLength === 0
        ? "all_candidates_duplicate"
        : parseableLines > 0 && rejectedLength > 0 && rejectedLowConfidence === 0 && rejectedDuplicates === 0
          ? "all_candidates_rejected_length"
          : parseableLines > 0
            ? "all_candidates_rejected"
            : looksLikeValidNoRules
              ? "valid_no_actionable_rules"
              : noRulesClassificationResponse.length === 0
                ? "empty_model_response"
                : "invalid_response_format";
    const diagnostics: ReflectionRulesDiagnostics = {
      modelResponseChars,
      parseSuccess,
      parsedCandidates: parseableLines,
      rejectedDuplicates,
      rejectedLowConfidence,
      stored: 0,
      zeroRulesReason,
      status:
        zeroRulesReason === "invalid_response_format" || zeroRulesReason === "empty_model_response"
          ? "degraded"
          : zeroRulesReason === "all_candidates_duplicate"
            ? "partial"
            : "ok",
    };
    logger.info(
      "memory-hybrid: reflect-rules — diagnostics: " +
        `model_response_chars=${diagnostics.modelResponseChars} ` +
        `parse_success=${diagnostics.parseSuccess} ` +
        `parsed_candidates=${diagnostics.parsedCandidates} ` +
        `rejected_duplicates=${diagnostics.rejectedDuplicates} ` +
        `rejected_low_confidence=${diagnostics.rejectedLowConfidence} ` +
        `stored=${diagnostics.stored} ` +
        `status=${diagnostics.status} zero_rules_reason=${diagnostics.zeroRulesReason}`,
    );
    return { rulesExtracted: uniqueRules.length, rulesStored: 0, diagnostics };
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
  const batchDuplicatesSkipped = rejectedDuplicates;
  let embeddingBasedDuplicates = 0;
  let storeLevelDuplicates = 0;
  let newRuleEmbedFailures = 0;
  let vectorStoreFailures = 0;
  let metadataFailures = 0;
  let storeSkipped = 0;
  let storeDedupeVectorFallbackSuppressed = 0;
  const reflectionRunId = provenanceService ? randomUUID() : null;
  const inRunFactVectors = new Map<string, { vector: number[]; embeddingModel: string }>();
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
      embeddingBasedDuplicates++;
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
    storeDedupeVectorFallbackSuppressed++;
    const storeResult = factsDb.storeWithResult(
      {
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
      },
      {
        warnContext: "reflect-rules",
        suppressVectorFallbackWarning: true,
      },
    );
    if (storeResult.skipped) {
      storeSkipped++;
      continue;
    }
    const entry = storeResult.entry;
    const mergeExistingIndex = storeResult.embeddingStale ? existingRuleFacts.findIndex((f) => f.id === entry.id) : -1;
    const inRunMerge = storeResult.embeddingStale && mergeExistingIndex < 0 ? inRunFactVectors.get(entry.id) : null;
    const preMergeVector =
      mergeExistingIndex >= 0 && mergeExistingIndex < existingVectors.length
        ? existingVectors[mergeExistingIndex]
        : (inRunMerge?.vector ?? null);
    const preMergeEmbeddingModel =
      mergeExistingIndex >= 0
        ? (existingRuleFacts[mergeExistingIndex]?.embeddingModel ?? null)
        : (inRunMerge?.embeddingModel ?? null);
    // Skip reused existing facts unless this was a merge update that requires re-embed.
    if (reusedExistingStoreEntry(storeResult, ruleText) && !storeResult.embeddingStale) {
      storeLevelDuplicates++;
      rulesDuplicatesSkipped++;
      // Keep this candidate in the in-run dedupe corpus so later rules don't miss near-duplicates.
      existingVectors.push(normVec);
      if (opts.verbose) {
        logger.info(`memory-hybrid: reflect-rules — skipped store-level duplicate: ${ruleText.slice(0, 50)}...`);
      }
      continue;
    }
    // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
    await cleanupEvictedVector({
      vectorDb: vectorDb,
      evictedFactId: storeResult.evictedFactId,
      logger: logger,
      context: "reflection",
    });
    if (opts.verbose) {
      logger.info(
        `memory-hybrid: reflect-rules — stored rule: ${ruleText.slice(0, 100)}${ruleText.length > 100 ? "..." : ""}`,
      );
    }
    // If embeddingStale=true (merge path), re-embed the updated merged text
    let textToEmbed = ruleText;
    let vectorToStore: number[];
    if (storeResult.embeddingStale) {
      try {
        textToEmbed = entry.text;
        vectorToStore = await embeddings.embed(textToEmbed);
      } catch (err) {
        newRuleEmbedFailures++;
        if (!shouldSuppressEmbeddingError(err)) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "embed-rule-merge",
            severity: "info",
            subsystem: "reflection",
          });
        }
        rollbackMergedFactText(factsDb, logger, {
          context: "reflect-rules",
          factId: entry.id,
          mergedText: entry.text,
          appendedText: ruleText,
          preMergeText: storeResult.preMergeText,
          reason: "merge-reembed-failure",
        });
        continue;
      }
    } else {
      vectorToStore = vec;
    }
    let vectorStored = false;
    try {
      await vectorDb.store({
        text: textToEmbed,
        vector: vectorToStore,
        importance: REFLECTION_IMPORTANCE,
        category: "rule",
        id: entry.id,
      });
      vectorStored = true;
    } catch (err) {
      vectorStoreFailures++;
      logger.warn(`memory-hybrid: reflect-rules vector store failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "reflection-rules-vector-store",
        subsystem: "vector",
        factId: entry.id,
      });
      if (storeResult.embeddingStale) {
        const preMergeText = resolvePreMergeText(entry.text, ruleText, storeResult.preMergeText);
        const rolledBack = rollbackMergedFactText(factsDb, logger, {
          context: "reflect-rules",
          factId: entry.id,
          mergedText: entry.text,
          appendedText: ruleText,
          preMergeText: storeResult.preMergeText,
          reason: "vector-store-failure",
        });
        if (rolledBack) {
          await restoreMergedFactVectorState({
            context: "reflect-rules",
            factId: entry.id,
            category: "rule",
            preMergeText,
            preMergeVector,
            preMergeEmbeddingModel,
            fallbackEmbeddingModel: embeddings.modelName,
            vectorDb,
            factsDb,
            logger,
          });
        }
        continue;
      }
      if (storeResult.newlyStored === false) {
        logger.warn(
          `memory-hybrid: reflect-rules — preserving existing rule fact ${entry.id.slice(0, 8)} after vector store failure on reused entry`,
        );
        continue;
      }
      if (!storeResult.embeddingStale) {
        try {
          factsDb.delete(entry.id);
          if (provenanceService) {
            try {
              provenanceService.deleteEdgesByFactId(entry.id);
            } catch (provErr) {
              logger.warn(
                `memory-hybrid: reflect-rules — failed to clean up provenance for rule fact ${entry.id.slice(0, 8)}: ${provErr}`,
              );
            }
          }
          try {
            await vectorDb.delete(entry.id);
          } catch (vecErr) {
            logger.warn(
              `memory-hybrid: reflect-rules — failed to clean up vector for rule fact ${entry.id.slice(0, 8)}: ${vecErr}`,
            );
          }
          logger.warn(
            `memory-hybrid: reflect-rules — deleted rule fact ${entry.id.slice(0, 8)} after vector store failure to prevent SQLite/LanceDB split`,
          );
        } catch (deleteErr) {
          logger.warn(
            `memory-hybrid: reflect-rules — failed to delete rule fact ${entry.id.slice(0, 8)} after vector store failure: ${deleteErr}`,
          );
        }
        continue;
      }
    }
    if (vectorStored) {
      try {
        persistCanonicalFactEmbedding(
          factsDb,
          entry.id,
          embeddings.modelName,
          vectorToStore,
          "reflection-fact-embeddings",
          "reflection",
          logger.warn?.bind(logger),
        );
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
      } catch (err) {
        metadataFailures++;
        logger.warn(`memory-hybrid: reflect-rules metadata update failed after vector store: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "reflection-rules-metadata-update",
          subsystem: "sqlite",
          factId: entry.id,
        });
        if (storeResult.embeddingStale) {
          const preMergeText = resolvePreMergeText(entry.text, ruleText, storeResult.preMergeText);
          const hasPreMergeVector = Array.isArray(preMergeVector) && preMergeVector.length > 0;
          if (!preMergeText || !hasPreMergeVector) {
            logger.warn(
              `memory-hybrid: reflect-rules — metadata rollback skipped for rule fact ${entry.id.slice(0, 8)} because pre-merge vector state is unavailable; keeping merged text to avoid SQLite/LanceDB mismatch`,
            );
            continue;
          }
          try {
            (factsDb as FactsDB & { deleteEmbeddings?: (factId: string) => void }).deleteEmbeddings?.(entry.id);
          } catch (embErr) {
            logger.warn(
              `memory-hybrid: reflect-rules — failed to delete canonical embeddings for rule fact ${entry.id.slice(0, 8)} after metadata failure: ${embErr}`,
            );
          }
          if (preMergeVector && preMergeVector.length > 0) {
            try {
              await vectorDb.delete(entry.id);
            } catch (vecErr) {
              logger.warn(
                `memory-hybrid: reflect-rules — failed to delete merged vector for rule fact ${entry.id.slice(0, 8)} before rollback: ${vecErr}`,
              );
            }
          }
          const rolledBack = rollbackMergedFactText(factsDb, logger, {
            context: "reflect-rules",
            factId: entry.id,
            mergedText: entry.text,
            appendedText: ruleText,
            preMergeText: storeResult.preMergeText,
            reason: "metadata-update-failure",
          });
          if (rolledBack) {
            if (preMergeVector && preMergeVector.length > 0) {
              await restoreMergedFactVectorState({
                context: "reflect-rules",
                factId: entry.id,
                category: "rule",
                preMergeText,
                preMergeVector,
                preMergeEmbeddingModel,
                fallbackEmbeddingModel: embeddings.modelName,
                vectorDb,
                factsDb,
                logger,
              });
            } else {
              try {
                await vectorDb.delete(entry.id);
                logger.warn(
                  `memory-hybrid: reflect-rules — deleted merged vector for rule fact ${entry.id.slice(0, 8)} after metadata failure (no pre-merge vector to restore)`,
                );
              } catch (vecErr) {
                logger.warn(
                  `memory-hybrid: reflect-rules — failed to delete merged vector for rule fact ${entry.id.slice(0, 8)} after metadata failure: ${vecErr}`,
                );
              }
            }
          }
          vectorStored = false;
          continue;
        }
        // For new inserts, clean up the partial state
        if (storeResult.newlyStored !== false) {
          try {
            (factsDb as FactsDB & { deleteEmbeddings?: (factId: string) => void }).deleteEmbeddings?.(entry.id);
          } catch (embErr) {
            logger.warn(
              `memory-hybrid: reflect-rules — failed to delete canonical embeddings for rule fact ${entry.id.slice(0, 8)} after metadata failure: ${embErr}`,
            );
          }
          try {
            await vectorDb.delete(entry.id);
          } catch (vecErr) {
            logger.warn(
              `memory-hybrid: reflect-rules — failed to delete Lance vector for rule fact ${entry.id.slice(0, 8)} after metadata failure: ${vecErr}`,
            );
          }
          try {
            factsDb.delete(entry.id);
          } catch (deleteErr) {
            logger.warn(
              `memory-hybrid: reflect-rules — failed to delete rule fact ${entry.id.slice(0, 8)} after metadata failure: ${deleteErr}`,
            );
          }
          if (provenanceService) {
            try {
              provenanceService.deleteEdgesByFactId(entry.id);
            } catch (provErr) {
              logger.warn(
                `memory-hybrid: reflect-rules — failed to clean up provenance for rule fact ${entry.id.slice(0, 8)}: ${provErr}`,
              );
            }
          }
          logger.warn(
            `memory-hybrid: reflect-rules — deleted rule fact ${entry.id.slice(0, 8)} after metadata failure to prevent partial store`,
          );
        }
        vectorStored = false;
        continue;
      }
    }
    if (vectorStored) {
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
      // If this was a merge (embeddingStale=true), replace the existing vector for this fact ID
      // instead of pushing a duplicate vector for the same fact.
      if (storeResult.embeddingStale) {
        const existingIndex = existingRuleFacts.findIndex((f) => f.id === entry.id);
        if (existingIndex >= 0 && existingIndex < existingVectors.length) {
          existingVectors[existingIndex] = normalizeVector(vectorToStore);
        } else {
          // Fact was inserted earlier in this loop, not in pre-run snapshot
          existingVectors.push(normalizeVector(vectorToStore));
        }
        inRunFactVectors.set(entry.id, { vector: vectorToStore, embeddingModel: embeddings.modelName });
      } else {
        existingVectors.push(normalizeVector(vectorToStore));
        inRunFactVectors.set(entry.id, { vector: vectorToStore, embeddingModel: embeddings.modelName });
      }
      stored++;
    }
  }

  logger.info(
    `memory-hybrid: reflect-rules — finished: ${stored} rule(s) stored, ${batchDuplicatesSkipped} skipped as batch duplicate(s), ${rulesDuplicatesSkipped} skipped as near-duplicate(s), ${newRuleEmbedFailures} new-rule embed failure(s), ${uniqueRules.length} candidate(s) total`,
  );
  if (storeDedupeVectorFallbackSuppressed > 0) {
    logger.info(
      `memory-hybrid: reflect-rules — store dedupe used lexical-only for ${storeDedupeVectorFallbackSuppressed} store(s) (phase-level cosine dedupe already handled near-duplicates)`,
    );
  }

  let zeroRulesReason: ReflectionRulesDiagnostics["zeroRulesReason"];
  if (stored <= 0) {
    const allCandidatesBlocked =
      newRuleEmbedFailures +
        embeddingBasedDuplicates +
        storeLevelDuplicates +
        vectorStoreFailures +
        metadataFailures +
        storeSkipped ===
      uniqueRules.length;
    if (vectorStoreFailures === uniqueRules.length) {
      // All candidates failed only at vector store
      zeroRulesReason = "vector_store_failed";
    } else if (newRuleEmbedFailures === uniqueRules.length) {
      // All candidates failed at embedding
      zeroRulesReason = "all_candidates_embedding_failed";
    } else if (metadataFailures === uniqueRules.length) {
      // All candidates failed at metadata persistence
      zeroRulesReason = "all_candidates_metadata_failed";
    } else if (embeddingBasedDuplicates + storeLevelDuplicates === uniqueRules.length) {
      // All candidates are duplicates (no failures)
      zeroRulesReason = "all_candidates_duplicate";
    } else if (
      allCandidatesBlocked &&
      vectorStoreFailures > 0 &&
      (embeddingBasedDuplicates > 0 || storeLevelDuplicates > 0)
    ) {
      // Mixed: some vector store failures and some duplicates
      zeroRulesReason = "candidates_duplicate_or_vector_store_failed";
    } else if (allCandidatesBlocked && newRuleEmbedFailures > 0) {
      // Mixed: some embedding failures and other blocks
      zeroRulesReason = "candidates_duplicate_or_embedding_failed";
    } else {
      zeroRulesReason = "no_storable_candidates";
    }
  }
  const diagnostics: ReflectionRulesDiagnostics = {
    modelResponseChars,
    parseSuccess,
    parsedCandidates: parseableLines,
    rejectedDuplicates: batchDuplicatesSkipped + rulesDuplicatesSkipped,
    rejectedLowConfidence,
    stored,
    zeroRulesReason,
    status:
      stored > 0 &&
      stored === uniqueRules.length &&
      newRuleEmbedFailures === 0 &&
      vectorStoreFailures === 0 &&
      metadataFailures === 0
        ? "ok"
        : stored > 0
          ? "partial"
          : zeroRulesReason === "all_candidates_embedding_failed"
            ? "degraded"
            : zeroRulesReason === "candidates_duplicate_or_embedding_failed"
              ? "degraded"
              : zeroRulesReason === "all_candidates_duplicate"
                ? "partial"
                : zeroRulesReason === "candidates_duplicate_or_vector_store_failed"
                  ? "partial"
                  : zeroRulesReason === "vector_store_failed"
                    ? "partial"
                    : zeroRulesReason === "all_candidates_metadata_failed"
                      ? "partial"
                      : "partial",
  };
  logger.info(
    "memory-hybrid: reflect-rules — diagnostics: " +
      `model_response_chars=${diagnostics.modelResponseChars} ` +
      `parse_success=${diagnostics.parseSuccess} ` +
      `parsed_candidates=${diagnostics.parsedCandidates} ` +
      `rejected_duplicates=${diagnostics.rejectedDuplicates} ` +
      `rejected_low_confidence=${diagnostics.rejectedLowConfidence} ` +
      `stored=${diagnostics.stored} ` +
      `status=${diagnostics.status}` +
      (diagnostics.zeroRulesReason ? ` zero_rules_reason=${diagnostics.zeroRulesReason}` : ""),
  );
  return { rulesExtracted: uniqueRules.length, rulesStored: stored, diagnostics };
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
  let storeDedupeVectorFallbackSuppressed = 0;
  const reflectionRunId = provenanceService ? randomUUID() : null;
  const inRunFactVectors = new Map<string, { vector: number[]; embeddingModel: string }>();
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
    storeDedupeVectorFallbackSuppressed++;
    const storeResult = factsDb.storeWithResult(
      {
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
      },
      {
        warnContext: "reflect-meta",
        suppressVectorFallbackWarning: true,
      },
    );
    if (storeResult.skipped) {
      continue;
    }
    const entry = storeResult.entry;
    const mergeExistingIndex = storeResult.embeddingStale ? existingMetaFacts.findIndex((f) => f.id === entry.id) : -1;
    const inRunMerge = storeResult.embeddingStale && mergeExistingIndex < 0 ? inRunFactVectors.get(entry.id) : null;
    const preMergeVector =
      mergeExistingIndex >= 0 && mergeExistingIndex < existingVectors.length
        ? existingVectors[mergeExistingIndex]
        : (inRunMerge?.vector ?? null);
    const preMergeEmbeddingModel =
      mergeExistingIndex >= 0
        ? (existingMetaFacts[mergeExistingIndex]?.embeddingModel ?? null)
        : (inRunMerge?.embeddingModel ?? null);
    // Skip reused existing facts unless this was a merge update that requires re-embed.
    if (reusedExistingStoreEntry(storeResult, metaText) && !storeResult.embeddingStale) {
      metaDuplicatesSkipped++;
      // Keep this candidate in the in-run dedupe corpus so later meta-patterns don't miss near-duplicates.
      existingVectors.push(normVec);
      if (opts.verbose) {
        logger.info(`memory-hybrid: reflect-meta — skipped store-level duplicate: ${metaText.slice(0, 50)}...`);
      }
      continue;
    }
    // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
    await cleanupEvictedVector({
      vectorDb: vectorDb,
      evictedFactId: storeResult.evictedFactId,
      logger: logger,
      context: "reflection",
    });
    if (opts.verbose) {
      logger.info(
        `memory-hybrid: reflect-meta — stored meta-pattern: ${metaText.slice(0, 100)}${metaText.length > 100 ? "..." : ""}`,
      );
    }
    // If embeddingStale=true (merge path), re-embed the updated merged text
    let textToEmbed: string;
    let vectorToStore: number[];
    if (storeResult.embeddingStale) {
      try {
        textToEmbed = entry.text;
        vectorToStore = await embeddings.embed(textToEmbed);
      } catch (err) {
        newMetaEmbedFailures++;
        if (!shouldSuppressEmbeddingError(err)) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: "embed-meta-merge",
            severity: "info",
            subsystem: "reflection",
          });
        }
        rollbackMergedFactText(factsDb, logger, {
          context: "reflect-meta",
          factId: entry.id,
          mergedText: entry.text,
          appendedText: metaText,
          preMergeText: storeResult.preMergeText,
          reason: "merge-reembed-failure",
        });
        continue;
      }
    } else {
      textToEmbed = metaText;
      vectorToStore = vec;
    }
    let vectorStored = false;
    try {
      await vectorDb.store({
        text: textToEmbed,
        vector: vectorToStore,
        importance: REFLECTION_IMPORTANCE,
        category: "pattern",
        id: entry.id,
      });
      vectorStored = true;
    } catch (err) {
      logger.warn(`memory-hybrid: reflect-meta vector store failed: ${err}`);
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        operation: "reflection-meta-vector-store",
        subsystem: "vector",
        factId: entry.id,
      });
      if (storeResult.embeddingStale) {
        const preMergeText = resolvePreMergeText(entry.text, metaText, storeResult.preMergeText);
        const rolledBack = rollbackMergedFactText(factsDb, logger, {
          context: "reflect-meta",
          factId: entry.id,
          mergedText: entry.text,
          appendedText: metaText,
          preMergeText: storeResult.preMergeText,
          reason: "vector-store-failure",
        });
        if (rolledBack) {
          await restoreMergedFactVectorState({
            context: "reflect-meta",
            factId: entry.id,
            category: "pattern",
            preMergeText,
            preMergeVector,
            preMergeEmbeddingModel,
            fallbackEmbeddingModel: embeddings.modelName,
            vectorDb,
            factsDb,
            logger,
          });
        }
        continue;
      }
      if (storeResult.newlyStored === false) {
        logger.warn(
          `memory-hybrid: reflect-meta — preserving existing meta-pattern fact ${entry.id.slice(0, 8)} after vector store failure on reused entry`,
        );
        continue;
      }
      if (!storeResult.embeddingStale) {
        try {
          factsDb.delete(entry.id);
          if (provenanceService) {
            try {
              provenanceService.deleteEdgesByFactId(entry.id);
            } catch (provErr) {
              logger.warn(
                `memory-hybrid: reflect-meta — failed to clean up provenance for meta-pattern fact ${entry.id.slice(0, 8)}: ${provErr}`,
              );
            }
          }
          try {
            await vectorDb.delete(entry.id);
          } catch (vecErr) {
            logger.warn(
              `memory-hybrid: reflect-meta — failed to clean up vector for meta-pattern fact ${entry.id.slice(0, 8)}: ${vecErr}`,
            );
          }
          logger.warn(
            `memory-hybrid: reflect-meta — deleted meta-pattern fact ${entry.id.slice(0, 8)} after vector store failure to prevent SQLite/LanceDB split`,
          );
        } catch (deleteErr) {
          logger.warn(
            `memory-hybrid: reflect-meta — failed to delete meta-pattern fact ${entry.id.slice(0, 8)} after vector store failure: ${deleteErr}`,
          );
        }
        continue;
      }
    }
    if (vectorStored) {
      try {
        persistCanonicalFactEmbedding(
          factsDb,
          entry.id,
          embeddings.modelName,
          vectorToStore,
          "reflection-fact-embeddings",
          "reflection",
          logger.warn?.bind(logger),
        );
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
      } catch (err) {
        logger.warn(`memory-hybrid: reflect-meta metadata update failed after vector store: ${err}`);
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: "reflection-meta-metadata-update",
          subsystem: "sqlite",
          factId: entry.id,
        });
        if (storeResult.embeddingStale) {
          const preMergeText = resolvePreMergeText(entry.text, metaText, storeResult.preMergeText);
          const hasPreMergeVector = Array.isArray(preMergeVector) && preMergeVector.length > 0;
          if (!preMergeText || !hasPreMergeVector) {
            logger.warn(
              `memory-hybrid: reflect-meta — metadata rollback skipped for meta-pattern fact ${entry.id.slice(0, 8)} because pre-merge vector state is unavailable; keeping merged text to avoid SQLite/LanceDB mismatch`,
            );
            continue;
          }
          try {
            (factsDb as FactsDB & { deleteEmbeddings?: (factId: string) => void }).deleteEmbeddings?.(entry.id);
          } catch (embErr) {
            logger.warn(
              `memory-hybrid: reflect-meta — failed to delete canonical embeddings for meta-pattern fact ${entry.id.slice(0, 8)} after metadata failure: ${embErr}`,
            );
          }
          if (preMergeVector && preMergeVector.length > 0) {
            try {
              await vectorDb.delete(entry.id);
            } catch (vecErr) {
              logger.warn(
                `memory-hybrid: reflect-meta — failed to delete merged vector for meta-pattern fact ${entry.id.slice(0, 8)} before rollback: ${vecErr}`,
              );
            }
          }
          const rolledBack = rollbackMergedFactText(factsDb, logger, {
            context: "reflect-meta",
            factId: entry.id,
            mergedText: entry.text,
            appendedText: metaText,
            preMergeText: storeResult.preMergeText,
            reason: "metadata-update-failure",
          });
          if (rolledBack) {
            if (preMergeVector && preMergeVector.length > 0) {
              await restoreMergedFactVectorState({
                context: "reflect-meta",
                factId: entry.id,
                category: "pattern",
                preMergeText,
                preMergeVector,
                preMergeEmbeddingModel,
                fallbackEmbeddingModel: embeddings.modelName,
                vectorDb,
                factsDb,
                logger,
              });
            } else {
              try {
                await vectorDb.delete(entry.id);
                logger.warn(
                  `memory-hybrid: reflect-meta — deleted merged vector for meta-pattern fact ${entry.id.slice(0, 8)} after metadata failure (no pre-merge vector to restore)`,
                );
              } catch (vecErr) {
                logger.warn(
                  `memory-hybrid: reflect-meta — failed to delete merged vector for meta-pattern fact ${entry.id.slice(0, 8)} after metadata failure: ${vecErr}`,
                );
              }
            }
          }
          vectorStored = false;
          continue;
        }
        // For new inserts, clean up the partial state
        if (storeResult.newlyStored !== false) {
          try {
            (factsDb as FactsDB & { deleteEmbeddings?: (factId: string) => void }).deleteEmbeddings?.(entry.id);
          } catch (embErr) {
            logger.warn(
              `memory-hybrid: reflect-meta — failed to delete canonical embeddings for meta-pattern fact ${entry.id.slice(0, 8)} after metadata failure: ${embErr}`,
            );
          }
          try {
            await vectorDb.delete(entry.id);
          } catch (vecErr) {
            logger.warn(
              `memory-hybrid: reflect-meta — failed to delete Lance vector for meta-pattern fact ${entry.id.slice(0, 8)} after metadata failure: ${vecErr}`,
            );
          }
          try {
            factsDb.delete(entry.id);
          } catch (deleteErr) {
            logger.warn(
              `memory-hybrid: reflect-meta — failed to delete meta-pattern fact ${entry.id.slice(0, 8)} after metadata failure: ${deleteErr}`,
            );
          }
          if (provenanceService) {
            try {
              provenanceService.deleteEdgesByFactId(entry.id);
            } catch (provErr) {
              logger.warn(
                `memory-hybrid: reflect-meta — failed to clean up provenance for meta-pattern fact ${entry.id.slice(0, 8)}: ${provErr}`,
              );
            }
          }
          logger.warn(
            `memory-hybrid: reflect-meta — deleted meta-pattern fact ${entry.id.slice(0, 8)} after metadata failure to prevent partial store`,
          );
        }
        vectorStored = false;
        continue;
      }
    }
    if (vectorStored) {
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
      // If this was a merge (embeddingStale=true), replace the existing vector for this fact ID
      // instead of pushing a duplicate vector for the same fact.
      if (storeResult.embeddingStale) {
        const existingIndex = existingMetaFacts.findIndex((f) => f.id === entry.id);
        if (existingIndex >= 0 && existingIndex < existingVectors.length) {
          existingVectors[existingIndex] = normalizeVector(vectorToStore);
        } else {
          // Fact was inserted earlier in this loop, not in pre-run snapshot
          existingVectors.push(normalizeVector(vectorToStore));
        }
        inRunFactVectors.set(entry.id, { vector: vectorToStore, embeddingModel: embeddings.modelName });
      } else {
        existingVectors.push(normalizeVector(vectorToStore));
        inRunFactVectors.set(entry.id, { vector: vectorToStore, embeddingModel: embeddings.modelName });
      }
      stored++;
    }
  }

  logger.info(
    `memory-hybrid: reflect-meta — finished: ${stored} meta-pattern(s) stored, ${metaDuplicatesSkipped} skipped as near-duplicate(s), ${newMetaEmbedFailures} embed failure(s), ${uniqueMetas.length} candidate(s) total`,
  );
  if (storeDedupeVectorFallbackSuppressed > 0) {
    logger.info(
      `memory-hybrid: reflect-meta — store dedupe used lexical-only for ${storeDedupeVectorFallbackSuppressed} store(s) (phase-level cosine dedupe already handled near-duplicates)`,
    );
  }

  return { metaExtracted: metas.length, metaStored: stored };
}
