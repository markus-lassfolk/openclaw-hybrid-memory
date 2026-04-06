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
import { yieldEventLoop } from "../utils/event-loop-yield.js";
import { computeDynamicSalience } from "../utils/salience.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { shouldSuppressEmbeddingError } from "./embeddings.js";
import { expandQueryWithHyde } from "./hyde-helper.js";
import { createRecallSpan, createRecallTimingLogger } from "./recall-timing.js";
import { DEFAULT_INTERACTIVE_RECALL_POLICY, type InteractiveRecallPolicy } from "./retrieval-mode-policy.js";

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
  const pipelineWallT0 = Date.now();
  const runStartedAt = recallTiming.phaseStarted("pipeline_run", {
    query_chars: trimmed.length,
    limit: limitNum,
    semantic_enabled: useSemantic,
  });

  const stageMs = { fts: 0, embed: 0, vector: 0, merge: 0 };

  let sqliteResults: SearchResult[] = [];
  let lanceResults: SearchResult[] = [];
  /** FTS row count from `factsDb.search` (for diagnostics). */
  let ftsRowCount = 0;

  /**
   * When semantic search is enabled, schedule FTS on the next macrotask so embedding / HyDE
   * I/O can run concurrently with synchronous SQLite FTS (#1050). Single-threaded CPU time
   * is unchanged, but wall-clock overlaps FTS with network-bound embed.
   */
  const runFtsSearchSync = (): {
    sqliteResults: SearchResult[];
    ftsRowCount: number;
    entityLookupRows: number;
  } => {
    let rows: SearchResult[] = [];
    let entityLookupRows = 0;
    if (opts?.entity) {
      const entityResults = factsDb
        .lookup(opts.entity, undefined, undefined, { scopeFilter: recallOpts.scopeFilter })
        .slice(0, limitNum);
      entityLookupRows = entityResults.length;
      rows = entityResults;
    }
    const ftsPart = factsDb.search(trimmed, limitNum, recallOpts);
    return {
      sqliteResults: [...rows, ...ftsPart],
      ftsRowCount: ftsPart.length,
      entityLookupRows,
    };
  };

  if (!useSemantic) {
    const ftsStartedAt = recallTiming.phaseStarted("fts_search", { limit: limitNum });
    const t0 = Date.now();
    const ftsOut = runFtsSearchSync();
    stageMs.fts = Date.now() - t0;
    sqliteResults = ftsOut.sqliteResults;
    ftsRowCount = ftsOut.ftsRowCount;
    recallTiming.phaseCompleted("fts_search", ftsStartedAt, {
      fts_rows: ftsOut.ftsRowCount,
      entity_lookup_rows: ftsOut.entityLookupRows,
      sqlite_rows: ftsOut.sqliteResults.length,
    });
    await yieldEventLoop();
  } else {
    const vectorStepStartedAt = recallTiming.phaseStarted("vector_step");
    let vectorStepStatus = "ok";
    const directiveAbort = new AbortController();

    // --- Phase 1: Kick off async I/O (HyDE / embed) BEFORE scheduling FTS ---
    // FTS runs synchronously inside setImmediate and can block the event loop for
    // tens of seconds on large fact stores (13k+ rows).  If the vector-step timeout
    // (setTimeout) is registered before FTS, the timer fires after FTS unblocks but
    // the vector step has not had any CPU time — producing a spurious timeout.
    //
    // Fix (#42): initiate the network-bound embed call first so the HTTP request is
    // in-flight while FTS occupies the CPU, then schedule FTS on the next macrotask.
    // The timeout is armed only after FTS yields, so it measures actual vector-step
    // execution time rather than event-loop starvation from FTS.

    let textToEmbed = trimmed;
    const allowHyde = policy.allowHyde && cfg.queryExpansion.enabled && (!opts?.limitHydeOnce || !hydeUsedRef.value);

    const embedT0 = Date.now();
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

    const _precomputedVector = opts?.precomputedVector;
    const usePrecomputedVector = Boolean(_precomputedVector) && textToEmbed === trimmed;

    // Kick off the embed HTTP request NOW (before FTS blocks the loop).
    // The returned promise will resolve once the network response arrives — which
    // can happen while FTS is occupying the CPU on the next macrotask.
    const embedPromise = usePrecomputedVector
      ? Promise.resolve(_precomputedVector as number[])
      : embeddings.embed(textToEmbed);

    // --- Phase 2: Run FTS synchronously on the next macrotask ---
    const ftsPromise = new Promise<SearchResult[]>((resolve, reject) => {
      setImmediate(() => {
        try {
          const ftsStartedAt = recallTiming.phaseStarted("fts_search", { limit: limitNum });
          const t0 = Date.now();
          const ftsOut = runFtsSearchSync();
          stageMs.fts = Date.now() - t0;
          ftsRowCount = ftsOut.ftsRowCount;
          recallTiming.phaseCompleted("fts_search", ftsStartedAt, {
            fts_rows: ftsOut.ftsRowCount,
            entity_lookup_rows: ftsOut.entityLookupRows,
            sqlite_rows: ftsOut.sqliteResults.length,
          });
          resolve(ftsOut.sqliteResults);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    // --- Phase 3: Await FTS first, then arm timeout and run vector step ---
    // By awaiting ftsPromise here we guarantee the timeout is only armed AFTER FTS
    // has finished and the event loop is free.  This prevents FTS event-loop
    // starvation from eating into the vector-step budget.
    const ftsRows = await ftsPromise;

    const vectorStepPromise = (async (): Promise<SearchResult[]> => {
      if (directiveAbort.signal.aborted) {
        const abortError = new Error(`recall pipeline timed out after ${policy.vectorStepTimeoutMs}ms`);
        abortError.name = "AbortError";
        throw abortError;
      }

      const embedStartedAt = recallTiming.phaseStarted("embed_query", {
        precomputed_vector: usePrecomputedVector,
      });
      const vector = usePrecomputedVector
        ? (_precomputedVector as number[])
        : await embedWithAbortRace(
            embedPromise,
            directiveAbort.signal,
            `recall pipeline timed out after ${policy.vectorStepTimeoutMs}ms`,
          );
      stageMs.embed = Date.now() - embedT0;
      recallTiming.phaseCompleted("embed_query", embedStartedAt, {
        precomputed_vector: usePrecomputedVector,
        input_chars: textToEmbed.length,
      });

      const vectorStartedAt = recallTiming.phaseStarted("lancedb_search", {
        limit: limitNum * 2,
        min_score: minScore,
      });
      const vecT0 = Date.now();
      const rawResults = await vectorDb.search(vector, limitNum * 2, minScore);
      stageMs.vector = Date.now() - vecT0;
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

    const vectorRacePromise = Promise.race([vectorStepPromise, timeoutPromise])
      .catch((err: unknown) => {
        const isTimeout = err instanceof Error && err.message.includes("timed out");
        vectorStepStatus = isTimeout ? "timeout" : "error";
        if (isTimeout) logger.warn(`memory-hybrid: ${String(err)}, using FTS-only recall`);
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
        return [] as SearchResult[];
      })
      .finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        recallTiming.phaseCompleted("vector_step", vectorStepStartedAt, {
          status: vectorStepStatus,
          hits: lanceResults.length,
        });
      });

    sqliteResults = ftsRows;
    lanceResults = await vectorRacePromise;

    vectorStepPromise.catch((err) => {
      if (!directiveAbort.signal.aborted && !shouldSuppressEmbeddingError(err)) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: `${opts?.errorPrefix ?? ""}vector-recall-post-timeout`,
          subsystem: "auto-recall",
        });
      }
    });

    await yieldEventLoop();
  }

  await yieldEventLoop();

  const mergeStartedAt = recallTiming.phaseStarted("merge_results");
  const mergeT0 = Date.now();
  let results = mergeResults(sqliteResults, lanceResults, limitNum, factsDb);
  stageMs.merge = Date.now() - mergeT0;
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

  const wallClockMs = Date.now() - pipelineWallT0;
  logger.debug?.(
    `memory-hybrid: ${policy.mode} timing (ms) — FTS: ${stageMs.fts}, embed: ${stageMs.embed}, vector: ${stageMs.vector}, merge: ${stageMs.merge}, wall: ${wallClockMs}`,
  );
  recallTiming.phaseCompleted("pipeline_run", runStartedAt, {
    fts_ms: stageMs.fts,
    embed_ms: stageMs.embed,
    vector_ms: stageMs.vector,
    merge_ms: stageMs.merge,
    wall_ms: wallClockMs,
    fts_rows: ftsRowCount,
    vector_hits: lanceResults.length,
    merged_rows: results.length,
  });

  return results;
}
