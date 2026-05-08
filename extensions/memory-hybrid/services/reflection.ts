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
  REFLECTION_IMPORTANCE,
  REFLECTION_MAX_FACTS_PER_CATEGORY,
  REFLECTION_MAX_FACT_LENGTH,
  REFLECTION_META_MAX_CHARS,
  REFLECTION_PATTERN_MAX_CHARS,
  REFLECTION_TEMPERATURE,
} from "../utils/constants.js";
import { getEnv } from "../utils/env-manager.js";
import { formatElapsedSec, withVerboseHeartbeat } from "../utils/maintenance-progress.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { LLMRetryError, parseRetryAfterMs } from "./chat.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "./adaptive-maintenance-llm.js";
import { CostFeature } from "./cost-feature-labels.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { shouldSuppressEmbeddingError } from "./embeddings.js";
import { capturePluginError } from "./error-reporter.js";
import type { ProvenanceService } from "./provenance.js";
import {
  computeDedupeCorpusFingerprint,
  CONSOLIDATE_REFLECTION_DEDUPE_HYDRATION,
  DEFAULT_REFLECTION_DEDUPE_HYDRATION,
  dedupeHydrationStateKey,
  isEmbeddingRateLimitError,
  readDedupeHydrationCheckpoint,
  REFLECTION_DEDUPE_CHECKPOINT_VERSION,
  reflectionLexicalNearDuplicateAgainstFact,
  writeDedupeHydrationCheckpoint,
  type DedupeCorpusCheckpointKind,
  type ReflectionDedupeHydrationResolved,
} from "./reflection-dedupe-hydration.js";

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
  /** Resolved hydration throttle + cap (#1229). When omitted, defaults for consolidate-style paths. */
  dedupeHydration?: ReflectionDedupeHydrationResolved;
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

export interface ReflectionDedupeCorpusCheckpointOpts {
  factsDb: FactsDB;
  kind: DedupeCorpusCheckpointKind;
}

export interface ReflectionDedupeCorpusOptions {
  /** When true, emit Lance chunk lines, embedding batch milestones, and idle heartbeats (#1228). */
  verbose?: boolean;
  /** Short label for progress lines (e.g. `reflection dedupe`). */
  progressLabel?: string;
  /** When set, persist/resume hydration cursor across runs (#1229). */
  checkpoint?: ReflectionDedupeCorpusCheckpointOpts;
  /** Throttle + cap; default depends on checkpoint (dream-cycle vs consolidate). */
  hydrationPolicy?: ReflectionDedupeHydrationResolved;
}

export interface ReflectionDedupeCorpusResult {
  vectors: (number[] | null)[];
  hydration: {
    complete: boolean;
    totalRows: number;
    needEmbedTotal: number;
    /** Next index into the sorted need-embed list for resume (see maintenance_state). */
    checkpointNextNeedIdx: number;
    deferredDueToRateLimit: boolean;
    deferredDueToCap: boolean;
    apiEmbedsThisRun: number;
    lanceHits: number;
    vectorsNonNull: number;
    /** False when some rows still lack vectors — use lexical fallback for those slots (#1229). */
    vectorsCompleteForCosine: boolean;
  };
}

/**
 * Build normalized dedupe-corpus vectors: Lance first, then throttled embedding with
 * checkpoints, 429 backpressure, per-run caps, and resumable backlog (#1229).
 */
export async function loadReflectionDedupeCorpusVectors(
  facts: MemoryEntry[],
  embeddings: EmbeddingProvider,
  vectorDb: VectorDB,
  logger: { info: (msg: string) => void; warn?: (msg: string) => void },
  logPrefix: string,
  captureOperation: string,
  corpusOpts?: ReflectionDedupeCorpusOptions,
): Promise<ReflectionDedupeCorpusResult> {
  const verbose = corpusOpts?.verbose === true;
  const progressLabel = corpusOpts?.progressLabel ?? "dedupe corpus";
  const policy =
    corpusOpts?.hydrationPolicy ??
    (corpusOpts?.checkpoint ? DEFAULT_REFLECTION_DEDUPE_HYDRATION : CONSOLIDATE_REFLECTION_DEDUPE_HYDRATION);
  const hb = { lanceHits: 0, apiEmbeds: 0, rowEnd: 0, needK: 0, needTotal: 0 };

  const runBody = async (): Promise<ReflectionDedupeCorpusResult> => {
    const vdb = vectorDb as VectorDB & {
      getVectorDim?: () => number;
      getVectorsByFactIds?: (
        ids: string[],
        opts?: { onChunkProgress?: (loaded: number, total: number) => void },
      ) => Promise<Map<string, number[]>>;
      isMemoriesVectorSchemaValid?: () => boolean;
      isLanceAvailable?: () => boolean;
    };
    const dim = typeof vdb.getVectorDim === "function" ? vdb.getVectorDim() : 0;
    let byId = new Map<string, number[]>();
    const lanceSchemaOk =
      typeof vdb.isMemoriesVectorSchemaValid === "function" ? vdb.isMemoriesVectorSchemaValid() : true;
    const lanceUp = typeof vdb.isLanceAvailable === "function" ? vdb.isLanceAvailable() : true;

    if (verbose && facts.length > 0) {
      logger.info(
        `${logPrefix} — ${progressLabel}: starting (${facts.length} row(s); Lance available=${lanceUp}, memories vector schema valid=${lanceSchemaOk}, embedModel=${embeddings.modelName ?? "unknown"}; maxEmbedsPerRun=${policy.maxEmbedsPerRun || "∞"}, minIntervalMs=${policy.minIntervalMsBetweenEmbeds})`,
      );
    }

    const prefetchStart = Date.now();
    if (typeof vdb.getVectorsByFactIds === "function") {
      try {
        if (verbose) {
          logger.info(
            `${logPrefix} — ${progressLabel}: Lance bulk fetch for ${facts.length} fact id(s) (indexed id IN queries, chunked)`,
          );
        }
        byId = await vdb.getVectorsByFactIds(
          facts.map((f) => f.id),
          verbose
            ? {
                onChunkProgress: (loaded, total) => {
                  logger.info(
                    `${logPrefix} — ${progressLabel}: Lance id scan ${loaded}/${total}, elapsed=${formatElapsedSec(prefetchStart)}`,
                  );
                },
              }
            : undefined,
        );
      } catch {
        byId = new Map();
      }
      if (verbose) {
        logger.info(
          `${logPrefix} — ${progressLabel}: Lance bulk fetch done — ${byId.size} vector(s) present in Lance for requested ids, elapsed=${formatElapsedSec(prefetchStart)}`,
        );
      }
    } else if (verbose) {
      logger.info(
        `${logPrefix} — ${progressLabel}: no getVectorsByFactIds on backend — per-row embedding API on cache miss`,
      );
    }

    const result: (number[] | null)[] = new Array(facts.length).fill(null);
    let lanceHits = 0;
    const modelKey = embeddings.modelName ?? "";
    for (let j = 0; j < facts.length; j++) {
      const f = facts[j]!;
      const cached = byId.get(f.id.toLowerCase());
      const modelOk =
        f.embeddingModel != null && embeddings.modelName != null && f.embeddingModel === embeddings.modelName;
      const useCache = dim > 0 && cached != null && cached.length === dim && modelOk;
      if (useCache) {
        result[j] = normalizeVector(cached);
        lanceHits++;
      }
    }

    const needEmbedIndices: number[] = [];
    for (let j = 0; j < facts.length; j++) {
      if (result[j] === null) needEmbedIndices.push(j);
    }
    needEmbedIndices.sort((a, b) => facts[a]!.id.toLowerCase().localeCompare(facts[b]!.id.toLowerCase()));
    const sortedIds = [...facts.map((f) => f.id)].map((id) => id.toLowerCase()).sort();
    const fp = computeDedupeCorpusFingerprint(sortedIds, modelKey);
    const stateKey = corpusOpts?.checkpoint ? dedupeHydrationStateKey(corpusOpts.checkpoint.kind) : "";

    let nextK = 0;
    if (corpusOpts?.checkpoint) {
      const cp = readDedupeHydrationCheckpoint(corpusOpts.checkpoint.factsDb, stateKey);
      if (cp && cp.fp === fp && cp.model === modelKey) {
        nextK = Math.min(cp.nextNeedIdx, needEmbedIndices.length);
      }
    }

    let checkpointNextIdx = nextK;
    let apiEmbedsThisRun = 0;
    let deferredDueToRateLimit = false;
    let deferredDueToCap = false;
    let lastEmbedAt = 0;
    let consecutive429 = 0;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const embedPhaseStart = Date.now();
    hb.needTotal = needEmbedIndices.length;

    const persistCheckpoint = (nextNeedIdx: number) => {
      checkpointNextIdx = nextNeedIdx;
      if (!corpusOpts?.checkpoint) return;
      writeDedupeHydrationCheckpoint(corpusOpts.checkpoint.factsDb, stateKey, {
        v: REFLECTION_DEDUPE_CHECKPOINT_VERSION,
        fp,
        model: modelKey,
        nextNeedIdx,
      });
    };

    for (let kk = nextK; kk < needEmbedIndices.length; kk++) {
      hb.needK = kk;
      if (policy.maxEmbedsPerRun > 0 && apiEmbedsThisRun >= policy.maxEmbedsPerRun) {
        deferredDueToCap = true;
        persistCheckpoint(kk);
        logger.info(
          `${logPrefix} — ${progressLabel}: hydration cap — processed=${kk}/${needEmbedIndices.length} embed API calls this run=${apiEmbedsThisRun} cap=${policy.maxEmbedsPerRun} remaining=${needEmbedIndices.length - kk} checkpoint nextNeedIdx=${kk} (#1229)`,
        );
        break;
      }

      const j = needEmbedIndices[kk]!;
      const f = facts[j]!;
      const gap = lastEmbedAt + policy.minIntervalMsBetweenEmbeds - Date.now();
      if (gap > 0) await sleep(gap);

      let done = false;
      while (!done && !deferredDueToRateLimit) {
        try {
          const vec = await embeddings.embed(f.text);
          result[j] = normalizeVector(vec);
          apiEmbedsThisRun++;
          consecutive429 = 0;
          lastEmbedAt = Date.now();
          done = true;
          hb.rowEnd = j + 1;
          hb.lanceHits = lanceHits;
          hb.apiEmbeds = apiEmbedsThisRun;
          if (corpusOpts?.checkpoint && (apiEmbedsThisRun % 8 === 0 || kk === needEmbedIndices.length - 1)) {
            persistCheckpoint(kk + 1);
          }
        } catch (err) {
          if (isEmbeddingRateLimitError(err)) {
            consecutive429++;
            const e = err instanceof Error ? err : new Error(String(err));
            const ra = parseRetryAfterMs(e);
            const exp = policy.baseBackoffMsAfter429 * 2 ** Math.max(0, consecutive429 - 1);
            const backMs = Math.min(180_000, Math.max(ra ?? 0, exp));
            const logWarn = logger.warn ?? ((m: string) => logger.info(m));
            logWarn(
              `${logPrefix} — ${progressLabel}: embedding rate-limited — backing off ${backMs}ms (consecutive=${consecutive429}/${policy.maxConsecutive429BeforeDefer}, backlog kk=${kk}/${needEmbedIndices.length}) (#1229)`,
            );
            await sleep(backMs);
            if (consecutive429 >= policy.maxConsecutive429BeforeDefer) {
              deferredDueToRateLimit = true;
              persistCheckpoint(kk);
              logger.info(
                `${logPrefix} — ${progressLabel}: deferring hydration — processed=${kk}/${needEmbedIndices.length} remaining=${needEmbedIndices.length - kk} deferred_due_to_rate_limit=1 checkpoint nextNeedIdx=${kk} vectors_created_this_run=${apiEmbedsThisRun} (#1229)`,
              );
            }
          } else {
            if (!shouldSuppressEmbeddingError(err)) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                operation: captureOperation,
                subsystem: "embeddings",
                factId: f.id,
              });
            }
            result[j] = null;
            done = true;
          }
        }
      }
      if (deferredDueToRateLimit) break;

      if (verbose) {
        const logEvery =
          needEmbedIndices.length <= 80 || kk === 0 || kk === needEmbedIndices.length - 1 || kk % 40 === 0;
        if (logEvery) {
          logger.info(
            `${logPrefix} — ${progressLabel}: embed progress kk=${kk + 1}/${needEmbedIndices.length} apiEmbeds=${apiEmbedsThisRun} lanceHits=${lanceHits} elapsed=${formatElapsedSec(embedPhaseStart)}`,
          );
        }
      }
    }

    const nonNull = result.filter((v) => v !== null).length;
    const complete = !deferredDueToRateLimit && !deferredDueToCap;
    const remainingNeed = Math.max(0, needEmbedIndices.length - checkpointNextIdx);

    if (facts.length > 0) {
      logger.info(
        `${logPrefix} — dedupe corpus: ${lanceHits} vector(s) reused from Lance index, ${apiEmbedsThisRun} via embedding API, ${nonNull}/${facts.length} non-null for cosine check` +
          (deferredDueToRateLimit || deferredDueToCap
            ? ` | backlog need_embed_total=${needEmbedIndices.length} remaining=${remainingNeed} checkpoint_nextNeedIdx=${checkpointNextIdx} deferred429=${deferredDueToRateLimit ? 1 : 0} deferredCap=${deferredDueToCap ? 1 : 0} (#1229)`
            : ""),
      );
    }

    return {
      vectors: result,
      hydration: {
        complete,
        totalRows: facts.length,
        needEmbedTotal: needEmbedIndices.length,
        checkpointNextNeedIdx: checkpointNextIdx,
        deferredDueToRateLimit,
        deferredDueToCap,
        apiEmbedsThisRun,
        lanceHits,
        vectorsNonNull: nonNull,
        vectorsCompleteForCosine: facts.length === 0 || nonNull === facts.length,
      },
    };
  };

  if (!verbose) {
    return runBody();
  }
  return withVerboseHeartbeat({
    verbose: true,
    log: (m) => logger.info(m),
    prefix: `${logPrefix} — ${progressLabel}`,
    detail: () =>
      `rows=${hb.rowEnd}/${facts.length} lanceHits=${hb.lanceHits} apiEmbeds=${hb.apiEmbeds} needEmbed=${hb.needK}/${hb.needTotal}`,
    fn: runBody,
  });
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
  let patternCorpusHydration = {
    vectorsCompleteForCosine: true,
    complete: true,
    needEmbedTotal: 0,
    checkpointNextNeedIdx: 0,
    deferredDueToRateLimit: false,
    deferredDueToCap: false,
    apiEmbedsThisRun: 0,
    vectorsNonNull: 0,
  };
  const corpusLoadStarted = Date.now();
  if (existingPatternFacts.length > 0) {
    logger.info(
      `memory-hybrid: reflection — loading ${existingPatternFacts.length} existing pattern row(s) for dedupe (Lance vectors + embedding API when index or model is missing)`,
    );
    const corpusRes = await loadReflectionDedupeCorpusVectors(
      existingPatternFacts,
      embeddings,
      vectorDb,
      logger,
      "memory-hybrid: reflection",
      "reflection-embed-existing",
      {
        verbose: opts.verbose,
        progressLabel: "reflection dedupe (existing corpus)",
        checkpoint: { factsDb, kind: "pattern" },
        hydrationPolicy: opts.dedupeHydration ?? DEFAULT_REFLECTION_DEDUPE_HYDRATION,
      },
    );
    existingVectors = corpusRes.vectors;
    patternCorpusHydration = corpusRes.hydration;
    if (!corpusRes.hydration.vectorsCompleteForCosine) {
      logger.info(
        `memory-hybrid: reflection — dedupe corpus hydration partial: vectors_non_null=${corpusRes.hydration.vectorsNonNull}/${corpusRes.hydration.totalRows} need_embed_total=${corpusRes.hydration.needEmbedTotal} remaining_next_idx=${corpusRes.hydration.checkpointNextNeedIdx} — lexical fallback for rows without vectors (#1229)`,
      );
    }
  } else {
    logger.info("memory-hybrid: reflection — no existing pattern facts for dedupe; embedding new candidates only");
  }
  if (opts.verbose && existingPatternFacts.length > 0) {
    logger.info(
      `memory-hybrid: reflection — existing corpus vectors ready: ${existingVectors.length} slot(s), elapsed=${formatElapsedSec(corpusLoadStarted)}`,
    );
  }

  logger.info(
    `memory-hybrid: reflection — embedding ${uniqueNewPatterns.length} new candidate pattern(s) for duplicate check + storage`,
  );

  let stored = 0;
  let duplicatesSkipped = 0;
  let newPatternEmbedFailures = 0;
  const reflectionRunId = provenanceService ? randomUUID() : null;
  const newCandidatePhaseStart = Date.now();
  let candIndex = 0;
  for (const patternText of uniqueNewPatterns) {
    candIndex++;
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
      if (opts.verbose) {
        logger.info(
          `memory-hybrid: reflection — dedupe candidate ${candIndex}/${uniqueNewPatterns.length}: embed failed, skipped | elapsed=${formatElapsedSec(newCandidatePhaseStart)}`,
        );
      }
      continue; // Skip this pattern on embed failure
    }
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (let ei = 0; ei < existingVectors.length; ei++) {
      const ev = existingVectors[ei];
      if (ev !== null && ev.length > 0) {
        if (dotProductSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
          isDuplicate = true;
          break;
        }
      } else if (!patternCorpusHydration.vectorsCompleteForCosine) {
        const prior = existingPatternFacts[ei];
        if (prior && reflectionLexicalNearDuplicateAgainstFact(patternText, prior.text)) {
          isDuplicate = true;
          break;
        }
      }
    }
    if (opts.verbose) {
      logger.info(
        `memory-hybrid: reflection — dedupe candidate ${candIndex}/${uniqueNewPatterns.length}: cosine/lexical check done, duplicate=${isDuplicate} | elapsed=${formatElapsedSec(newCandidatePhaseStart)}`,
      );
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
  }

  if (!opts.dryRun) {
    factsDb.setMaintenanceState("reflection_input_hash", inputHash);
  }
  logger.info(
    `memory-hybrid: reflection — finished: ${stored} pattern(s) stored in DB + vector index, ${duplicatesSkipped} skipped as near-duplicate(s), ${newPatternEmbedFailures} new-pattern embed failure(s), ${uniqueNewPatterns.length} candidate(s) total` +
      (opts.verbose ? ` | new-candidate phase elapsed=${formatElapsedSec(newCandidatePhaseStart)}` : ""),
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
    dedupeHydration?: ReflectionDedupeHydrationResolved;
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
  let rulesCorpusHydration = {
    vectorsCompleteForCosine: true,
    vectorsNonNull: 0,
    totalRows: 0,
  };
  if (existingRuleFacts.length > 0) {
    logger.info(
      `memory-hybrid: reflect-rules — loading ${existingRuleFacts.length} existing rule row(s) for dedupe (Lance vectors + embedding API when index or model is missing)`,
    );
    const corpusRes = await loadReflectionDedupeCorpusVectors(
      existingRuleFacts,
      embeddings,
      vectorDb,
      logger,
      "memory-hybrid: reflect-rules",
      "reflection-rules-embed-existing",
      {
        verbose: opts.verbose,
        progressLabel: "reflect-rules dedupe (existing corpus)",
        checkpoint: { factsDb, kind: "rule" },
        hydrationPolicy: opts.dedupeHydration ?? DEFAULT_REFLECTION_DEDUPE_HYDRATION,
      },
    );
    existingVectors = corpusRes.vectors;
    rulesCorpusHydration = {
      vectorsCompleteForCosine: corpusRes.hydration.vectorsCompleteForCosine,
      vectorsNonNull: corpusRes.hydration.vectorsNonNull,
      totalRows: corpusRes.hydration.totalRows,
    };
    if (!corpusRes.hydration.vectorsCompleteForCosine) {
      logger.info(
        `memory-hybrid: reflect-rules — dedupe corpus hydration partial (${corpusRes.hydration.vectorsNonNull}/${corpusRes.hydration.totalRows}); lexical fallback for null-vector rows (#1229)`,
      );
    }
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
  const rulesCandidatePhaseStart = Date.now();
  let ruleCandIndex = 0;
  for (const ruleText of uniqueRules) {
    ruleCandIndex++;
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
      if (opts.verbose) {
        logger.info(
          `memory-hybrid: reflect-rules — dedupe candidate ${ruleCandIndex}/${uniqueRules.length}: embed failed, skipped | elapsed=${formatElapsedSec(rulesCandidatePhaseStart)}`,
        );
      }
      continue; // Skip this rule on embed failure
    }
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (let ei = 0; ei < existingVectors.length; ei++) {
      const ev = existingVectors[ei];
      if (ev !== null && ev.length > 0) {
        if (dotProductSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
          isDuplicate = true;
          break;
        }
      } else if (!rulesCorpusHydration.vectorsCompleteForCosine) {
        const prior = existingRuleFacts[ei];
        if (prior && reflectionLexicalNearDuplicateAgainstFact(ruleText, prior.text)) {
          isDuplicate = true;
          break;
        }
      }
    }
    if (opts.verbose) {
      logger.info(
        `memory-hybrid: reflect-rules — dedupe candidate ${ruleCandIndex}/${uniqueRules.length}: duplicate=${isDuplicate} | elapsed=${formatElapsedSec(rulesCandidatePhaseStart)}`,
      );
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
    `memory-hybrid: reflect-rules — finished: ${stored} rule(s) stored, ${rulesDuplicatesSkipped} skipped as near-duplicate(s), ${newRuleEmbedFailures} new-rule embed failure(s), ${uniqueRules.length} candidate(s) total` +
      (opts.verbose ? ` | new-candidate phase elapsed=${formatElapsedSec(rulesCandidatePhaseStart)}` : ""),
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
    dedupeHydration?: ReflectionDedupeHydrationResolved;
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
  let metaCorpusHydration = { vectorsCompleteForCosine: true };
  if (existingMetaFacts.length > 0) {
    logger.info(
      `memory-hybrid: reflect-meta — loading ${existingMetaFacts.length} existing meta-pattern row(s) for dedupe (Lance vectors + embedding API when index or model is missing)`,
    );
    const corpusRes = await loadReflectionDedupeCorpusVectors(
      existingMetaFacts,
      embeddings,
      vectorDb,
      logger,
      "memory-hybrid: reflect-meta",
      "reflection-meta-embed-existing",
      {
        verbose: opts.verbose,
        progressLabel: "reflect-meta dedupe (existing corpus)",
        checkpoint: { factsDb, kind: "meta" },
        hydrationPolicy: opts.dedupeHydration ?? DEFAULT_REFLECTION_DEDUPE_HYDRATION,
      },
    );
    existingVectors = corpusRes.vectors;
    metaCorpusHydration = { vectorsCompleteForCosine: corpusRes.hydration.vectorsCompleteForCosine };
    if (!corpusRes.hydration.vectorsCompleteForCosine) {
      logger.info(
        `memory-hybrid: reflect-meta — dedupe corpus hydration partial; lexical fallback for null-vector rows (#1229)`,
      );
    }
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
  const metaCandidatePhaseStart = Date.now();
  let metaCandIndex = 0;
  for (const metaText of uniqueMetas) {
    metaCandIndex++;
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
      if (opts.verbose) {
        logger.info(
          `memory-hybrid: reflect-meta — dedupe candidate ${metaCandIndex}/${uniqueMetas.length}: embed failed, skipped | elapsed=${formatElapsedSec(metaCandidatePhaseStart)}`,
        );
      }
      continue; // Skip this meta-pattern on embed failure
    }
    const normVec = normalizeVector(vec);
    let isDuplicate = false;
    for (let ei = 0; ei < existingVectors.length; ei++) {
      const ev = existingVectors[ei];
      if (ev !== null && ev.length > 0) {
        if (dotProductSimilarity(normVec, ev) >= REFLECTION_DEDUPE_THRESHOLD) {
          isDuplicate = true;
          break;
        }
      } else if (!metaCorpusHydration.vectorsCompleteForCosine) {
        const prior = existingMetaFacts[ei];
        if (prior && reflectionLexicalNearDuplicateAgainstFact(metaText, prior.text)) {
          isDuplicate = true;
          break;
        }
      }
    }
    if (opts.verbose) {
      logger.info(
        `memory-hybrid: reflect-meta — dedupe candidate ${metaCandIndex}/${uniqueMetas.length}: duplicate=${isDuplicate} | elapsed=${formatElapsedSec(metaCandidatePhaseStart)}`,
      );
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
    `memory-hybrid: reflect-meta — finished: ${stored} meta-pattern(s) stored, ${metaDuplicatesSkipped} skipped as near-duplicate(s), ${newMetaEmbedFailures} embed failure(s), ${uniqueMetas.length} candidate(s) total` +
      (opts.verbose ? ` | new-candidate phase elapsed=${formatElapsedSec(metaCandidatePhaseStart)}` : ""),
  );

  return { metaExtracted: metas.length, metaStored: stored };
}
