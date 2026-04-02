/**
 * Recall pipeline core — extracted from lifecycle/stage-recall.ts (Issue #498).
 *
 * `runRecallPipelineQuery` is the single-query FTS+vector search step.
 * All dependencies are passed explicitly so the function is unit-testable
 * without instantiating the full LifecycleContext.
 *
 * Engineering Goal 3: Strict Separation of Concerns
 * Engineering Goal 4: Testability (simple stubs, no live API keys)
 */

import type OpenAI from "openai";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { QueryExpansionConfig } from "../config.js";
import type { getCronModelConfig } from "../config.js";
import type { PendingLLMWarnings } from "../services/chat.js";
import { capturePluginError } from "../services/error-reporter.js";
import { filterByScope, mergeResults } from "../services/merge-results.js";
import type { ScopeFilter, SearchResult } from "../types/memory.js";
import { applyConsolidationRetrievalControls } from "../utils/consolidation-controls.js";
import { computeDynamicSalience } from "../utils/salience.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { shouldSuppressEmbeddingError } from "./embeddings.js";
import { expandQueryWithHyde } from "./hyde-helper.js";
import { createRecallSpan, createRecallTimingLogger } from "./recall-timing.js";
import { DEFAULT_INTERACTIVE_RECALL_POLICY, type InteractiveRecallPolicy } from "./retrieval-mode-policy.js";
import { yieldEventLoop } from "../utils/event-loop-yield.js";

async function embedWithAbortRace(
  embedPromise: Promise<number[]>,
  signal: AbortSignal,
  abortMessage: string,
): Promise<number[]> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      embedPromise,
      new Promise<number[]>((_, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error(abortMessage), { name: "AbortError" }));
          return;
        }
        onAbort = () => reject(Object.assign(new Error(abortMessage), { name: "AbortError" }));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Logger subset required by the recall pipeline (avoids importing ClawdbotPluginApi). */
export interface RecallLogger {
  debug?: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Minimal subset of HybridMemoryConfig sections consumed by the pipeline. */
export interface RecallPipelineCfg {
  queryExpansion: QueryExpansionConfig;
  retrievalStrategies: Array<"semantic" | "fts5" | "graph">;
  memoryTieringEnabled: boolean;
  recallTiming?: "off" | "basic" | "verbose";
  /** Passed through to getCronModelConfig/getLLMModelPreference — the raw cfg object. */
  rawCfg: Parameters<typeof getCronModelConfig>[0];
}

/** Search options that `factsDb.search()` / `factsDb.lookup()` accept. */
export interface RecallSearchOpts {
  tierFilter: "warm" | "all";
  scopeFilter: ScopeFilter | undefined;
  reinforcementBoost: number;
  diversityWeight: number;
  /** Passed to `FactsDB.search` — bounded FTS + two-phase fetch on interactive recall. */
  interactiveFtsFastPath?: boolean;
}

/** All explicit dependencies consumed by `runRecallPipelineQuery`. */
export interface RecallPipelineDeps {
  factsDb: Pick<FactsDB, "search" | "getById" | "lookup" | "getSupersededTexts">;
  vectorDb: Pick<VectorDB, "search">;
  embeddings: Pick<EmbeddingProvider, "embed">;
  openai: OpenAI;
  cfg: RecallPipelineCfg;
  recallOpts: RecallSearchOpts;
  minScore: number;
  pendingLLMWarnings: PendingLLMWarnings;
  logger: RecallLogger;
}

/**
 * Run a single recall query: FTS + optional vector search, merge, tier-filter.
 *
 * @param query          - The user query (trimmed internally)
 * @param limitNum       - Max results to return
 * @param deps           - Explicit dependencies (testable via simple stubs)
 * @param hydeUsedRef    - Shared mutable ref: when `limitHydeOnce` is set, the
 *                         first call that runs HyDE sets this to `true` and
 *                         subsequent calls skip HyDE. Pass `{ value: false }`
 *                         per-top-level recall invocation.
 * @param opts           - Per-call options (entity lookup, labels, etc.)
 */
export async function runRecallPipelineQuery(
  query: string,
  limitNum: number,
  deps: RecallPipelineDeps,
  hydeUsedRef: { value: boolean },
  opts?: {
    entity?: string;
    hydeLabel?: string;
    errorPrefix?: string;
    limitHydeOnce?: boolean;
    precomputedVector?: number[];
    policy?: InteractiveRecallPolicy;
    timingSpan?: string;
    timingOp?: string;
  },
): Promise<SearchResult[]> {
  const { factsDb, vectorDb, embeddings, openai, cfg, recallOpts, minScore, pendingLLMWarnings, logger } = deps;

  const policy = opts?.policy ?? DEFAULT_INTERACTIVE_RECALL_POLICY;

  const trimmed = query.trim();
  if (!trimmed) return [];

  const useSemantic = cfg.retrievalStrategies.includes("semantic");
  const recallTiming = createRecallTimingLogger({
    logger,
    mode: cfg.recallTiming ?? "off",
    span: opts?.timingSpan ?? createRecallSpan("recall"),
    op: opts?.timingOp ?? `${opts?.errorPrefix ?? policy.mode}-pipeline`,
  });
  const runStartedAt = recallTiming.phaseStarted("pipeline_run", {
    query_chars: trimmed.length,
    limit: limitNum,
    semantic_enabled: useSemantic,
  });

  const stageMs = { fts: 0, embed: 0, vector: 0, merge: 0 };

  const ftsStartedAt = recallTiming.phaseStarted("fts_search", { limit: limitNum });
  let t0 = Date.now();
  let sqliteResults: SearchResult[] = [];
  let entityLookupRows = 0;
  if (opts?.entity) {
    const entityResults = factsDb
      .lookup(opts.entity, undefined, undefined, { scopeFilter: recallOpts.scopeFilter })
      .slice(0, limitNum);
    entityLookupRows = entityResults.length;
    sqliteResults = entityResults;
  }
  const ftsResults = factsDb.search(trimmed, limitNum, recallOpts);
  stageMs.fts = Date.now() - t0;
  sqliteResults = [...sqliteResults, ...ftsResults];
  recallTiming.phaseCompleted("fts_search", ftsStartedAt, {
    fts_rows: ftsResults.length,
    entity_lookup_rows: entityLookupRows,
    sqlite_rows: sqliteResults.length,
  });

  // FTS + lookup are synchronous SQLite — yield so gateway WebSocket/health can run (#931).
  await yieldEventLoop();

  let lanceResults: SearchResult[] = [];

  if (useSemantic) {
    const vectorStepStartedAt = recallTiming.phaseStarted("vector_step");
    let vectorStepStatus = "ok";
    const directiveAbort = new AbortController();
    try {
      const vectorStepPromise = (async (): Promise<SearchResult[]> => {
        let textToEmbed = trimmed;
        const allowHyde =
          policy.allowHyde && cfg.queryExpansion.enabled && (!opts?.limitHydeOnce || !hydeUsedRef.value);

        t0 = Date.now();
        if (allowHyde) {
          if (opts?.limitHydeOnce) hydeUsedRef.value = true;
          if (!directiveAbort.signal.aborted) {
            const hydeStartedAt = recallTiming.phaseStarted("hyde_generation");
            textToEmbed = await expandQueryWithHyde({
              query: trimmed,
              rawCfg: cfg.rawCfg,
              model: cfg.queryExpansion.model,
              timeoutMs: cfg.queryExpansion.timeoutMs,
              openai,
              label: opts?.hydeLabel ?? "HyDE",
              signal: directiveAbort.signal,
              pendingWarnings: pendingLLMWarnings,
              logger,
              subsystem: "auto-recall",
              operation: `${opts?.errorPrefix ?? ""}hyde-generation`,
            });
            recallTiming.phaseCompleted("hyde_generation", hydeStartedAt, {
              input_chars: trimmed.length,
              output_chars: textToEmbed.length,
            });
          }
        }

        // Guard: if the vector-step timeout already fired, skip the embed call entirely.
        // The HyDE call above may have completed just before the abort — we must not
        // waste an embedding provider call whose result will be discarded.
        if (directiveAbort.signal.aborted) {
          const abortError = new Error(`recall pipeline timed out after ${policy.vectorStepTimeoutMs}ms`);
          abortError.name = "AbortError";
          throw abortError;
        }

        const _precomputedVector = opts?.precomputedVector;
        const usePrecomputedVector = Boolean(_precomputedVector) && textToEmbed === trimmed;
        const embedStartedAt = recallTiming.phaseStarted("embed_query", {
          precomputed_vector: usePrecomputedVector,
        });
        const vector = usePrecomputedVector
          ? (_precomputedVector as number[])
          : await embedWithAbortRace(
              embeddings.embed(textToEmbed),
              directiveAbort.signal,
              `recall pipeline timed out after ${policy.vectorStepTimeoutMs}ms`,
            );
        stageMs.embed = Date.now() - t0;
        recallTiming.phaseCompleted("embed_query", embedStartedAt, {
          precomputed_vector: usePrecomputedVector,
          input_chars: textToEmbed.length,
        });

        const vectorStartedAt = recallTiming.phaseStarted("lancedb_search", {
          limit: limitNum * 2,
          min_score: minScore,
        });
        t0 = Date.now();
        const rawResults = await vectorDb.search(vector, limitNum * 2, minScore);
        stageMs.vector = Date.now() - t0;
        let results = filterByScope(rawResults, (id, o) => factsDb.getById(id, o), recallOpts.scopeFilter);
        results = results.map((r) => {
          const fullEntry = factsDb.getById(r.entry.id);
          if (fullEntry) {
            const salienceScore = computeDynamicSalience(r.score, fullEntry);
            const controlledScore = applyConsolidationRetrievalControls(salienceScore, fullEntry);
            return { ...r, entry: fullEntry, score: controlledScore };
          }
          return r;
        });
        recallTiming.phaseCompleted("lancedb_search", vectorStartedAt, {
          raw_hits: rawResults.length,
          hits: results.length,
        });
        return results;
      })();

      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          directiveAbort.abort();
          reject(new Error(`${policy.mode} timed out after ${policy.vectorStepTimeoutMs}ms`));
        }, policy.vectorStepTimeoutMs);
      });

      try {
        lanceResults = await Promise.race([vectorStepPromise, timeoutPromise]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        vectorStepPromise.catch((err) => {
          if (!directiveAbort.signal.aborted && !shouldSuppressEmbeddingError(err)) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              operation: `${opts?.errorPrefix ?? ""}vector-recall-post-timeout`,
              subsystem: "auto-recall",
            });
          }
        });
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.includes("timed out");
      vectorStepStatus = isTimeout ? "timeout" : "error";
      if (isTimeout) logger.warn(`memory-hybrid: ${err.message}, using FTS-only recall`);
      else {
        if (!shouldSuppressEmbeddingError(err)) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            operation: `${opts?.errorPrefix ?? ""}vector-recall`,
            subsystem: "auto-recall",
            backend: "lancedb",
          });
        }
        logger.warn(`memory-hybrid: ${opts?.errorPrefix ?? ""}vector recall failed: ${err}`);
      }
    } finally {
      recallTiming.phaseCompleted("vector_step", vectorStepStartedAt, {
        status: vectorStepStatus,
        hits: lanceResults.length,
      });
    }
  }

  await yieldEventLoop();

  const mergeStartedAt = recallTiming.phaseStarted("merge_results");
  t0 = Date.now();
  let results = mergeResults(sqliteResults, lanceResults, limitNum, factsDb);
  stageMs.merge = Date.now() - t0;
  recallTiming.phaseCompleted("merge_results", mergeStartedAt, {
    sqlite_rows: sqliteResults.length,
    vector_hits: lanceResults.length,
    merged_rows: results.length,
  });

  if (cfg.memoryTieringEnabled && results.length > 0) {
    results = results
      .filter((r) => {
        const full = factsDb.getById(r.entry.id);
        return full && full.tier !== "cold";
      })
      .slice(0, limitNum);
  }

  logger.debug?.(
    `memory-hybrid: ${policy.mode} timing (ms) — FTS: ${stageMs.fts}, embed: ${stageMs.embed}, vector: ${stageMs.vector}, merge: ${stageMs.merge}, total: ${stageMs.fts + stageMs.embed + stageMs.vector + stageMs.merge}`,
  );
  recallTiming.phaseCompleted("pipeline_run", runStartedAt, {
    fts_ms: stageMs.fts,
    embed_ms: stageMs.embed,
    vector_ms: stageMs.vector,
    merge_ms: stageMs.merge,
    total_ms: stageMs.fts + stageMs.embed + stageMs.vector + stageMs.merge,
    fts_rows: ftsResults.length,
    vector_hits: lanceResults.length,
    merged_rows: results.length,
  });

  return results;
}
