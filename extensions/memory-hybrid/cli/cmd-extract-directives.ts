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
export async function runExtractDirectivesForCli(
  ctx: HandlerContext,
  opts: { days?: number; verbose?: boolean; dryRun?: boolean; full?: boolean },
): Promise<DirectiveExtractResult & { stored?: number; partial?: boolean; dedupeDegraded?: boolean }> {
  const { factsDb, vectorDb, cfg, logger } = ctx;
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
          const shouldCountVectorFallback = shouldReportVectorDedupeFallback({
            source,
            fuzzyDedupe: cfg.store?.fuzzyDedupe ?? true,
            storeConfig: cfg.store,
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
              warnContext: "extract-directives",
              suppressVectorFallbackWarning: true,
            },
          );
          if (storeResult.skipped) {
            continue;
          }
          // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
          await cleanupEvictedVector({
            vectorDb,
            evictedFactId: storeResult.evictedFactId,
            logger: logger,
            context: "extract-directives",
          });
          if (shouldCountVectorFallback) storeDedupeVectorFallbackSuppressed++;
          stored++;
        } catch (err) {
          capturePluginError(err as Error, {
            subsystem: "cli",
            operation: "runExtractDirectivesForCli:store",
          });
        }
      }
    }

    if (storeDedupeVectorFallbackSuppressed > 0) {
      logger.warn?.(
        `memory-hybrid: extract-directives DEGRADED — store dedupe used lexical-only for ${storeDedupeVectorFallbackSuppressed} store(s) (vectorCandidates not wired for this CLI path yet)`,
      );
    }
    const partial = (result.rejected ?? 0) > 0;
    const dedupeDegraded = storeDedupeVectorFallbackSuppressed > 0;
    const returnVal = { ...result, stored, partial, dedupeDegraded };
    if (!opts.dryRun && !partial) {
      const lastSessionTs = getMaxMtime(filePaths);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }
    if (!opts.dryRun && partial) {
      logger.info?.(
        `memory-hybrid: extract-directives — ${result.rejected ?? 0} directive candidate(s) rejected, cursor not advanced`,
      );
    }
    return returnVal;
  } finally {
    if (!opts.full && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}
