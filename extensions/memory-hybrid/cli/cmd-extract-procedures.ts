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
export async function runExtractProceduresForCli(
  ctx: HandlerContext,
  opts: {
    sessionDir?: string;
    days?: number;
    dryRun: boolean;
    verbose?: boolean;
    full?: boolean;
  },
): Promise<ExtractProceduresResult> {
  const { factsDb, vectorDb, cfg, logger } = ctx;
  const SCAN_TYPE = "extract-procedures";
  if (cfg.procedures?.enabled === false) {
    return {
      sessionsScanned: 0,
      proceduresStored: 0,
      positiveCount: 0,
      negativeCount: 0,
      dryRun: opts.dryRun,
    };
  }
  const sessionDir = opts.sessionDir ?? cfg.procedures.sessionsDir;
  const cursor = opts.dryRun ? null : factsDb.getScanCursor(SCAN_TYPE);

  // Startup guard + concurrency lock (skip when not full mode)
  if (!opts.full && !opts.dryRun) {
    const skip = acquireScanSlot(SCAN_TYPE, cursor?.lastRunAt, logger);
    if (skip)
      return {
        sessionsScanned: 0,
        proceduresStored: 0,
        positiveCount: 0,
        negativeCount: 0,
        dryRun: false,
        skipped: true,
      };
  }

  let filePaths: string[] | undefined;
  if (!opts.full && cursor) {
    // Incremental: only sessions modified after the last processed session timestamp
    filePaths = getSessionFilePathsSince(sessionDir, opts.days ?? 7, cursor.lastSessionTs);
    logger.info?.(`memory-hybrid: ${SCAN_TYPE} incremental — ${filePaths.length} new sessions since last run`);
  } else if (opts.days != null && opts.days > 0) {
    filePaths = getSessionFilePathsSince(sessionDir, opts.days);
  }

  try {
    const result = await extractProceduresFromSessions(
      factsDb,
      {
        sessionDir: filePaths ? undefined : sessionDir,
        filePaths,
        minSteps: cfg.procedures.minSteps,
        dryRun: opts.dryRun,
        verbose: opts.verbose,
      },
      {
        info: (s) => logger.info?.(s) ?? console.log(s),
        warn: (s) => logger.warn?.(s) ?? console.warn(s),
      },
    );
    if (!opts.dryRun) {
      let lastSessionTs: number | undefined;
      if (filePaths) {
        lastSessionTs = getMaxMtime(filePaths);
      } else {
        const allFiles = getSessionFilePathsSince(sessionDir, 0, 0);
        lastSessionTs = getMaxMtime(allFiles);
      }
      factsDb.updateScanCursor(SCAN_TYPE, lastSessionTs ?? 0, result.sessionsScanned);
    }
    return result;
  } catch (err) {
    capturePluginError(err as Error, {
      subsystem: "cli",
      operation: "runExtractProceduresForCli",
    });
    throw err;
  } finally {
    if (!opts.full && !opts.dryRun) clearScanLock(SCAN_TYPE);
  }
}

/**
 * Generate auto-skills from procedures
 */
export async function runGenerateAutoSkillsForCli(
  ctx: HandlerContext,
  opts: {
    dryRun: boolean;
    apply?: boolean;
    verbose?: boolean;
    max?: number;
    policy?: string;
    json?: boolean;
    bypassDuplicateSkillCache?: boolean;
  },
): Promise<GenerateAutoSkillsResult> {
  const { factsDb, cfg, logger } = ctx;
  const info = opts.verbose ? (s: string) => logger.info?.(s) ?? console.log(s) : () => {};
  const warn = (s: string) => logger.warn?.(s) ?? console.warn(s);
  try {
    return generateAutoSkills(
      factsDb,
      {
        skillsAutoPath: cfg.procedures.skillsAutoPath,
        validationThreshold: cfg.procedures.validationThreshold,
        skillTTLDays: cfg.procedures.skillTTLDays,
        dryRun: opts.dryRun,
        apply: opts.apply,
        maxPerRun: opts.max,
        policy: opts.policy,
        bypassDuplicateSkillCache: opts.bypassDuplicateSkillCache,
      },
      { info, warn },
    );
  } catch (err) {
    capturePluginError(err as Error, {
      subsystem: "cli",
      operation: "runGenerateAutoSkillsForCli",
    });
    throw err;
  }
}

/**
 * Extract directives from sessions
 */
