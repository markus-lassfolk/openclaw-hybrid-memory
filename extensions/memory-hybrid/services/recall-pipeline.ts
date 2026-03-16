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

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type OpenAI from "openai";
import type { SearchResult, ScopeFilter } from "../types/memory.js";
import type { QueryExpansionConfig } from "../config.js";
import type { PendingLLMWarnings } from "../services/chat.js";
import { mergeResults, filterByScope } from "../services/merge-results.js";
import { chatCompleteWithRetry, is500Like, is404Like, isOllamaOOM } from "../services/chat.js";
import { computeDynamicSalience } from "../utils/salience.js";
import { capturePluginError } from "../services/error-reporter.js";
import { getCronModelConfig, getLLMModelPreference } from "../config.js";

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

const VECTOR_STEP_TIMEOUT_MS = 30_000;

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
  },
): Promise<SearchResult[]> {
  const { factsDb, vectorDb, embeddings, openai, cfg, recallOpts, minScore, pendingLLMWarnings, logger } = deps;

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

  let lanceResults: SearchResult[] = [];
  const useSemantic = cfg.retrievalStrategies.includes("semantic");

  if (useSemantic) {
    const directiveAbort = new AbortController();
    try {
      const vectorStepPromise = (async (): Promise<SearchResult[]> => {
        let textToEmbed = trimmed;
        const allowHyde = cfg.queryExpansion.enabled && (!opts?.limitHydeOnce || !hydeUsedRef.value);
        t0 = Date.now();

        if (allowHyde) {
          if (opts?.limitHydeOnce) hydeUsedRef.value = true;
          try {
            const cronCfg = getCronModelConfig(cfg.rawCfg);
            const pref = getLLMModelPreference(cronCfg, "nano");
            const hydeModel = cfg.queryExpansion.model ?? pref[0];
            const fallbackModels = cfg.queryExpansion.model ? [] : pref.slice(1);
            const hydeContent = await chatCompleteWithRetry({
              model: hydeModel,
              fallbackModels,
              content: `Write a short factual statement (1-2 sentences) that answers: ${trimmed}\n\nOutput only the statement, no preamble.`,
              temperature: 0.3,
              maxTokens: 150,
              openai,
              label: opts?.hydeLabel ?? "HyDE",
              timeoutMs: cfg.queryExpansion.timeoutMs,
              signal: directiveAbort.signal,
              pendingWarnings: pendingLLMWarnings,
            });
            const hydeText = hydeContent.trim();
            if (hydeText.length > 10) textToEmbed = hydeText;
          } catch (err) {
            if (!directiveAbort.signal.aborted) {
              const hydeErr = err instanceof Error ? err : new Error(String(err));
              const isTransient =
                isOllamaOOM(hydeErr) ||
                is500Like(hydeErr) ||
                is404Like(hydeErr) ||
                /timed out|llm request timeout|request was aborted|econnrefused/i.test(hydeErr.message);
              if (!isTransient) {
                capturePluginError(hydeErr, {
                  operation: `${opts?.errorPrefix ?? ""}hyde-generation`,
                  subsystem: "auto-recall",
                });
              }
              if (isOllamaOOM(hydeErr)) {
                logger.warn(
                  `memory-hybrid: Ollama model OOM during HyDE generation — model requires more memory than available. ` +
                    `Using raw query. Consider using a smaller model or configuring a cloud fallback.`,
                );
              } else {
                logger.warn(`memory-hybrid: ${opts?.errorPrefix ?? ""}HyDE generation failed, using raw query: ${err}`);
              }
            }
          }
        }

        const vector =
          opts?.precomputedVector && textToEmbed === trimmed
            ? opts.precomputedVector
            : await embeddings.embed(textToEmbed);
        stageMs.embed = Date.now() - t0;
        t0 = Date.now();
        let results = await vectorDb.search(vector, limitNum * 2, minScore);
        stageMs.vector = Date.now() - t0;
        results = filterByScope(results, (id, o) => factsDb.getById(id, o), recallOpts.scopeFilter);
        results = results.map((r) => {
          const fullEntry = factsDb.getById(r.entry.id);
          if (fullEntry) return { ...r, entry: fullEntry, score: computeDynamicSalience(r.score, fullEntry) };
          return r;
        });
        return results;
      })();

      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          directiveAbort.abort();
          reject(new Error(`recall pipeline timed out after ${VECTOR_STEP_TIMEOUT_MS}ms`));
        }, VECTOR_STEP_TIMEOUT_MS);
      });

      try {
        lanceResults = await Promise.race([vectorStepPromise, timeoutPromise]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        vectorStepPromise.catch((err) => {
          if (!directiveAbort.signal.aborted) {
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
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          operation: `${opts?.errorPrefix ?? ""}vector-recall`,
          subsystem: "auto-recall",
          backend: "lancedb",
        });
        logger.warn(`memory-hybrid: ${opts?.errorPrefix ?? ""}vector recall failed: ${err}`);
      }
    }
  }

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
    `memory-hybrid: recall pipeline timing (ms) — FTS: ${stageMs.fts}, embed: ${stageMs.embed}, vector: ${stageMs.vector}, merge: ${stageMs.merge}, total: ${stageMs.fts + stageMs.embed + stageMs.vector + stageMs.merge}`,
  );

  return results;
}
