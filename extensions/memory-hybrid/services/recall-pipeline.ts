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
  /** Passed through to getCronModelConfig/getLLMModelPreference — the raw cfg object. */
  rawCfg: Parameters<typeof getCronModelConfig>[0];
}

/** Search options that `factsDb.search()` / `factsDb.lookup()` accept. */
export interface RecallSearchOpts {
  tierFilter: "warm" | "all";
  scopeFilter: ScopeFilter | undefined;
  reinforcementBoost: number;
  diversityWeight: number;
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
  },
): Promise<SearchResult[]> {
  const { factsDb, vectorDb, embeddings, openai, cfg, recallOpts, minScore, pendingLLMWarnings, logger } = deps;

  const policy = opts?.policy ?? DEFAULT_INTERACTIVE_RECALL_POLICY;

  const trimmed = query.trim();
  if (!trimmed) return [];

  const stageMs = { fts: 0, embed: 0, vector: 0, merge: 0 };
  let t0 = Date.now();

  let sqliteResults: SearchResult[] = [];
  if (opts?.entity) {
    sqliteResults = factsDb
      .lookup(opts.entity, undefined, undefined, { scopeFilter: recallOpts.scopeFilter })
      .slice(0, limitNum);
  }
  const ftsResults = factsDb.search(trimmed, limitNum, recallOpts);
  stageMs.fts = Date.now() - t0;
  sqliteResults = [...sqliteResults, ...ftsResults];

  // FTS + lookup are synchronous SQLite — yield so gateway WebSocket/health can run (#931).
  await yieldEventLoop();

  let lanceResults: SearchResult[] = [];
  const useSemantic = cfg.retrievalStrategies.includes("semantic");

  if (useSemantic) {
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

        const vector =
          opts?.precomputedVector && textToEmbed === trimmed
            ? opts.precomputedVector
            : await embedWithAbortRace(
                embeddings.embed(textToEmbed),
                directiveAbort.signal,
                `recall pipeline timed out after ${policy.vectorStepTimeoutMs}ms`,
              );
        stageMs.embed = Date.now() - t0;
        t0 = Date.now();
        let results = await vectorDb.search(vector, limitNum * 2, minScore);
        stageMs.vector = Date.now() - t0;
        results = filterByScope(results, (id, o) => factsDb.getById(id, o), recallOpts.scopeFilter);
        results = results.map((r) => {
          const fullEntry = factsDb.getById(r.entry.id);
          if (fullEntry) {
            const salienceScore = computeDynamicSalience(r.score, fullEntry);
            const controlledScore = applyConsolidationRetrievalControls(salienceScore, fullEntry);
            return { ...r, entry: fullEntry, score: controlledScore };
          }
          return r;
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
    }
  }

  await yieldEventLoop();

  t0 = Date.now();
  let results = mergeResults(sqliteResults, lanceResults, limitNum, factsDb);
  stageMs.merge = Date.now() - t0;

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

  return results;
}
