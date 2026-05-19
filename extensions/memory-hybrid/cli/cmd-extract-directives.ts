/**
 * Extract CLI — split from cmd-extract.ts.
 */
import { getEnv } from "../utils/env-manager.js";
/**
 * Extract CLI Handler Functions
 *
 * Contains scan state, session helpers, and the following handlers:
 *   runExtractProceduresForCli, runGenerateAutoSkillsForCli,
 *   runExtractDirectivesForCli, runExtractReinforcementForCli,
 *   runGenerateProposalsForCli, runExtractDailyForCli.
 * Extracted from handlers.ts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ReinforcementContext } from "../backends/facts-db.js";
import type { MemoryCategory } from "../config.js";
import {
  getCronModelConfig,
  getDefaultCronModel,
  getLLMModelPreference,
  resolveReflectionModelAndFallbacks,
} from "../config.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "../services/adaptive-maintenance-llm.js";
import { VAULT_POINTER_PREFIX, isCredentialLike, tryParseCredentialForVault } from "../services/auto-capture.js";
import { chatCompleteWithRetryDetailed, distillMaxOutputTokens } from "../services/chat.js";
import { validateScopedClassificationTarget } from "../services/classification-scope.js";
import { type MemoryClassification, classifyMemoryOperationsBatch } from "../services/classification.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { shouldReportVectorDedupeFallback } from "../services/dedupe-policy.js";
import { type DirectiveExtractResult, runDirectiveExtract } from "../services/directive-extract.js";
import { capturePluginError } from "../services/error-reporter.js";
import { extractStructuredFields } from "../services/fact-extraction.js";
import { runIdentityReflection } from "../services/identity-reflection.js";
import {
  buildPersonaStateInsightsBlock,
  promotePersonaStateFromReflections,
} from "../services/persona-state-promotion.js";
import { extractProceduresFromSessions } from "../services/procedure-extractor.js";
import { generateAutoSkills } from "../services/procedure-skill-generator.js";
import { type ReinforcementExtractResult, runReinforcementExtract } from "../services/reinforcement-extract.js";
import { preFilterSessions } from "../services/session-pre-filter.js";
import { insertRulesUnderSection } from "../services/tools-md-section.js";
import { cleanupEvictedVector, deleteVectorForFactId } from "../services/vector-maintenance.js";
import { findSimilarByEmbedding } from "../services/vector-search.js";
import type { MemoryEntry } from "../types/memory.js";
import { BATCH_STORE_IMPORTANCE, CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import { getFileSnapshot } from "../utils/file-snapshot.js";
import { getDirectiveSignalRegex, getReinforcementSignalRegex } from "../utils/language-keywords.js";
import { resolveTierPreferenceWithSources } from "../utils/llm-selection.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { extractTags } from "../utils/tags.js";
import { buildPreFilterConfig } from "./cmd-install.js";
import { inferTargetFile } from "./cmd-store.js";
import type { HandlerContext } from "./handlers.js";
import { capProposalConfidence } from "./proposals.js";
import { acquireScanSlot, clearScanLock } from "./shared.js";
import type {
  ExtractDailyResult,
  ExtractDailySink,
  ExtractProceduresResult,
  GenerateAutoSkillsResult,
} from "./types.js";


import { getSessionFilePathsSince, getMaxMtime } from "./cmd-extract-sessions.js";
export async function runExtractDirectivesForCli(
  ctx: HandlerContext,
  opts: { days?: number; verbose?: boolean; dryRun?: boolean; full?: boolean },
): Promise<DirectiveExtractResult & { stored?: number }> {
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
        stored: 0,
        skipped: true,
      } as DirectiveExtractResult & {
        stored?: number;
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
            },
            {
              warnContext: "extract-directives",
              suppressVectorFallbackWarning: true,
            },
          );
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
      logger.info?.(
        `memory-hybrid: extract-directives — store dedupe used lexical-only for ${storeDedupeVectorFallbackSuppressed} store(s) (vectorCandidates not wired for this CLI path yet)`,
      );
    }
    const returnVal = { ...result, stored };
    if (!opts.dryRun) {
      const lastSessionTs = getMaxMtime(filePaths);
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }
    return returnVal;
  } finally {
    if (!opts.full && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}

/**
 * Extract reinforcement signals from sessions
 */
