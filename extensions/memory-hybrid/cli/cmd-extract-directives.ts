/** Directive extraction CLI (`runExtractDirectivesForCli`). Split from cmd-extract.ts. */
import type { MemoryCategory } from "../config.js";
import { shouldReportVectorDedupeFallback } from "../services/dedupe-policy.js";
import {
  DIRECTIVE_EXTRACTION_METHOD,
  type DirectiveExtractResult,
  runDirectiveExtract,
} from "../services/directive-extract.js";
import { capturePluginError } from "../services/error-reporter.js";
import { preFilterSessions } from "../services/session-pre-filter.js";
import { cleanupEvictedVector } from "../services/vector-maintenance.js";
import { getDirectiveSignalRegex } from "../utils/language-keywords.js";
import { buildPreFilterConfig } from "./cmd-install.js";
import type { HandlerContext } from "./handlers.js";
import { acquireScanSlot, clearScanLock } from "./shared.js";

import { getSessionFilePathsSince, getMaxMtime } from "./cmd-extract-sessions.js";

const VECTOR_CANDIDATE_LIMIT = 10;
const VECTOR_CANDIDATE_MIN_SCORE = 0;

/**
 * Identifies transient/retryable store errors (SQLite busy, network issues) vs permanent errors.
 * Permanent errors (TypeError, schema bugs, etc.) should not block cursor advancement.
 */
function isRetryableStoreError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";

  // SQLite busy/lock errors are retryable
  if (/SQLITE_BUSY|database is locked/i.test(message) || /SQLITE_BUSY/i.test(code)) {
    return true;
  }

  // Transient network errors are retryable
  if (
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|fetch failed|network timeout|connect\s+ETIMEDOUT/i.test(
      message,
    ) ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(code)
  ) {
    return true;
  }

  // All other errors (TypeError, schema bugs, programming errors) are permanent
  return false;
}

function getVectorSearchFailReason(vectorDb: unknown): string | null {
  const getter = (vectorDb as { getLastSearchFailReason?: unknown }).getLastSearchFailReason;
  if (typeof getter !== "function") return null;
  try {
    const reason = getter.call(vectorDb);
    return typeof reason === "string" && reason.length > 0 ? reason : null;
  } catch {
    return null;
  }
}

export async function runExtractDirectivesForCli(
  ctx: HandlerContext,
  opts: { days?: number; verbose?: boolean; dryRun?: boolean; full?: boolean },
): Promise<
  DirectiveExtractResult & {
    stored?: number;
    partial?: boolean;
    dedupeDegraded?: boolean;
    directiveDedupeMode?: "vector" | "lexical-only" | "mixed";
    directiveRejected?: {
      permanent: number;
      retryable: number;
      parserOrModelFailure: number;
      boundedPartialRetry: number;
    };
    cursorAdvanced?: boolean;
    cursorBlockedReason?: "retryable_rejections" | "parser_or_model_failure" | "bounded_partial_retry";
  }
> {
  const { factsDb, vectorDb, embeddings, cfg, logger } = ctx;
  const SCAN_TYPE = "extract-directives";
  logger.info?.("memory-hybrid: extract-directives — regex extraction (no LLM model selection)");
  const sessionDir = cfg.procedures.sessionsDir;
  const days = opts.days ?? 3;
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock (skip when not full mode)
  if (!opts.full && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip)
      return {
        incidents: [],
        sessionsScanned: 0,
        rejected: 0,
        stored: 0,
        partial: false,
        dedupeDegraded: false,
        skipped: true,
      } as DirectiveExtractResult & {
        stored?: number;
        partial?: boolean;
        dedupeDegraded?: boolean;
        skipped?: boolean;
      };
  }

  try {
    let filePaths: string[];
    if (!opts.full && cursor) {
      filePaths = getSessionFilePathsSince(sessionDir, days, cursor.lastSessionTs);
      logger.info?.(`memory-hybrid: ${SCAN_TYPE} incremental — ${filePaths.length} new sessions since last run`);
    } else {
      filePaths = getSessionFilePathsSince(sessionDir, days);
    }

    // Two-tier pre-filter: use local Ollama to triage sessions before regex scan (Issue #290).
    // NOTE: filePaths (the full candidate set) is preserved for cursor watermarking below so
    // that skipped sessions still advance the watermark and are not re-triaged on every run.
    let extractionPaths = filePaths;
    const pfCfgDir = buildPreFilterConfig(cfg);
    if (pfCfgDir.enabled && filePaths.length > 0) {
      const pfResult = await preFilterSessions(filePaths, pfCfgDir);
      if (!pfResult.ollamaUnavailable) {
        logger.info?.(
          `memory-hybrid: ${SCAN_TYPE} pre-filter: ${pfResult.kept.length}/${filePaths.length} sessions flagged as interesting`,
        );
        extractionPaths = pfResult.kept;
      } else {
        logger.info?.(`memory-hybrid: ${SCAN_TYPE} pre-filter: Ollama unavailable — scanning all sessions`);
      }
    }

    const directiveRegex = getDirectiveSignalRegex();
    const result = runDirectiveExtract({
      filePaths: extractionPaths,
      directiveRegex,
    });

    if (opts.verbose) {
      for (const incident of result.incidents) {
        console.log(`[${incident.sessionFile}] ${incident.categories.join(", ")}: ${incident.extractedRule}`);
      }
    }

    // Store directives as facts if not dry-run
    let stored = 0;
    let storeDedupeVectorFallbackSuppressed = 0;
    let vectorDedupeStores = 0;
    let lexicalOnlyDedupeStores = 0;
    let retryableRejected = 0;
    let parserOrModelRejected = 0;
    let boundedPartialRetryRejected = 0;
    if (!opts.dryRun) {
      for (const incident of result.incidents) {
        try {
          if (factsDb.hasDuplicate(incident.extractedRule, `directive:${incident.sessionFile}`)) continue;
          const category = incident.categories.includes("preference")
            ? "preference"
            : incident.categories.includes("absolute_rule")
              ? "rule"
              : incident.categories.includes("conditional_rule")
                ? "rule"
                : incident.categories.includes("warning")
                  ? "rule"
                  : incident.categories.includes("future_behavior")
                    ? "rule"
                    : incident.categories.includes("procedural")
                      ? "pattern"
                      : incident.categories.includes("correction")
                        ? "decision"
                        : incident.categories.includes("implicit_correction")
                          ? "decision"
                          : incident.categories.includes("explicit_memory")
                            ? "fact"
                            : "other";
          const source = `directive:${incident.sessionFile}`;
          let vector: number[] | undefined;
          let vectorCandidates: Array<{ id: string; score: number }> | undefined;
          try {
            vector = await embeddings.embed(incident.extractedRule);
            if (cfg.store?.fuzzyDedupe ?? true) {
              const neighbors = await vectorDb.search(vector, VECTOR_CANDIDATE_LIMIT, VECTOR_CANDIDATE_MIN_SCORE);
              if (!getVectorSearchFailReason(vectorDb)) {
                vectorCandidates = neighbors
                  .map((candidate) => ({
                    id: candidate.entry.id,
                    score: candidate.score,
                  }))
                  .filter(
                    (candidate) =>
                      typeof candidate.id === "string" && candidate.id.length > 0 && Number.isFinite(candidate.score),
                  );
              }
            }
          } catch (err) {
            capturePluginError(err as Error, {
              subsystem: "cli",
              operation: "runExtractDirectivesForCli:vector-candidates",
            });
          }
          const usedLexicalOnlyFallback = shouldReportVectorDedupeFallback({
            source,
            fuzzyDedupe: cfg.store?.fuzzyDedupe ?? true,
            storeConfig: cfg.store,
            vectorCandidates,
          });
          const storeResult = factsDb.storeWithResult(
            {
              text: incident.extractedRule,
              category: category as MemoryCategory,
              importance: 0.8,
              entity: null,
              key: null,
              value: null,
              source,
              confidence: incident.confidence,
              extractionMethod: DIRECTIVE_EXTRACTION_METHOD,
              extractionConfidence: incident.confidence,
              tags: ["directive-extract", ...incident.categories.map((c) => `directive:${c}`)],
            },
            {
              vectorCandidates,
              warnContext: "extract-directives",
              suppressVectorFallbackWarning: true,
            },
          );
          const usedVectorCandidates = Boolean(vectorCandidates && vectorCandidates.length > 0);
          if (usedLexicalOnlyFallback) {
            storeDedupeVectorFallbackSuppressed++;
            lexicalOnlyDedupeStores++;
          } else if (usedVectorCandidates) {
            vectorDedupeStores++;
          } else {
            lexicalOnlyDedupeStores++;
          }
          if (storeResult.skipped || !storeResult.newlyStored) {
            continue;
          }
          // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
          await cleanupEvictedVector({
            vectorDb,
            evictedFactId: storeResult.evictedFactId,
            logger: logger,
            context: "extract-directives",
          });
          if (vector) {
            try {
              factsDb.setEmbeddingModel(storeResult.entry.id, embeddings.modelName);
              if (!(await vectorDb.hasDuplicate(vector))) {
                await vectorDb.store({
                  text: incident.extractedRule,
                  vector,
                  importance: 0.8,
                  category: category as MemoryCategory,
                  id: storeResult.entry.id,
                });
              }
            } catch (err) {
              logger.warn?.(`memory-hybrid: extract-directives vector store failed: ${err}`);
              capturePluginError(err as Error, {
                subsystem: "cli",
                operation: "runExtractDirectivesForCli:vector-store",
              });
            }
          }
          stored++;
        } catch (err) {
          const isRetryable = isRetryableStoreError(err);
          if (isRetryable) {
            retryableRejected++;
          }
          capturePluginError(err as Error, {
            subsystem: "cli",
            operation: "runExtractDirectivesForCli:store",
          });
        }
      }
    }

    if (storeDedupeVectorFallbackSuppressed > 0) {
      logger.warn?.(
        `memory-hybrid: extract-directives DEGRADED — store dedupe used lexical-only for ${storeDedupeVectorFallbackSuppressed} store(s) (embedding or vector search failed)`,
      );
    }
    const directiveRejected = {
      permanent: result.rejected ?? 0,
      retryable: retryableRejected,
      parserOrModelFailure: parserOrModelRejected,
      boundedPartialRetry: boundedPartialRetryRejected,
    };
    const blockedRejections =
      directiveRejected.retryable + directiveRejected.parserOrModelFailure + directiveRejected.boundedPartialRetry;
    const partial = blockedRejections > 0;
    const dedupeDegraded = storeDedupeVectorFallbackSuppressed > 0;
    const totalDedupeStores = vectorDedupeStores + lexicalOnlyDedupeStores;
    let directiveDedupeMode: "vector" | "lexical-only" | "mixed" | undefined;
    if (vectorDedupeStores === totalDedupeStores && totalDedupeStores > 0) {
      directiveDedupeMode = "vector";
    } else if (lexicalOnlyDedupeStores === totalDedupeStores && totalDedupeStores > 0) {
      directiveDedupeMode = "lexical-only";
    } else if (totalDedupeStores > 0) {
      directiveDedupeMode = "mixed";
    }
    let cursorAdvanced: boolean | undefined;
    let cursorBlockedReason: "retryable_rejections" | "parser_or_model_failure" | "bounded_partial_retry" | undefined;
    if (directiveRejected.parserOrModelFailure > 0) {
      cursorBlockedReason = "parser_or_model_failure";
    } else if (directiveRejected.boundedPartialRetry > 0) {
      cursorBlockedReason = "bounded_partial_retry";
    } else if (directiveRejected.retryable > 0) {
      cursorBlockedReason = "retryable_rejections";
    }
    const returnVal = {
      ...result,
      stored,
      partial,
      dedupeDegraded,
      directiveDedupeMode,
      directiveRejected,
      cursorAdvanced,
      cursorBlockedReason,
    };
    if (!opts.dryRun && !cursorBlockedReason) {
      const lastSessionTs = getMaxMtime(filePaths);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
      returnVal.cursorAdvanced = true;
    }
    if (!opts.dryRun && cursorBlockedReason) {
      returnVal.cursorAdvanced = false;
      logger.info?.(
        `memory-hybrid: extract-directives — cursor blocked (${cursorBlockedReason}); rejected={permanent:${directiveRejected.permanent},retryable:${directiveRejected.retryable},parserOrModelFailure:${directiveRejected.parserOrModelFailure},boundedPartialRetry:${directiveRejected.boundedPartialRetry}}`,
      );
    }
    return returnVal;
  } finally {
    if (!opts.full && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}
