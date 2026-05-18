// @ts-nocheck
import { getEnv } from "../utils/env-manager.js";
/**
 * Build HybridMemCliContext from handler context and services.
 * Moves CLI wiring out of index.ts so the plugin entry stays small.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Command } from "commander";
import type { ClawdbotPluginApi } from "openclaw/plugin-sdk/core";
import type { ActiveTaskContext } from "../cli/active-tasks.js";
import { runBackup as runBackupFn, runBackupVerify as runBackupVerifyFn } from "../cli/backup.js";
import type { HandlerContext } from "../cli/handlers.js";
import * as handlers from "../cli/handlers.js";
import { attachHybridMemCliFatalExit, ensureVerboseFlagOnHybridMemTree } from "../cli/hybrid-mem-commander-utils.js";
import { applyApprovedProposal } from "../cli/proposals.js";
import { type HybridMemCliContext, registerHybridMemCli } from "../cli/register.js";
import type { FindDuplicatesResult } from "../cli/types.js";
import {
  getCronModelConfig,
  getDefaultCronModel,
  getMemoryCategories,
  hybridConfigSchema,
  resolveReflectionModelAndFallbacks,
} from "../config.js";
import { runClassifyForCli } from "../services/auto-classifier.js";
import { runConsolidate } from "../services/consolidation.js";
import { type VerificationCycleResult, runVerificationCycle } from "../services/continuous-verifier.js";
import { readGuardTimestampMs } from "../services/cron-guard.js";
import { type DreamCycleResult, runDreamCycle } from "../services/dream-cycle.js";
import { runEntityEnrichmentForCli } from "../services/entity-enrichment-cli.js";
import { capturePluginError } from "../services/error-reporter.js";
import { runExport } from "../services/export-memory.js";
import { runFindDuplicates } from "../services/find-duplicates.js";
import { runBuildLanguageKeywords } from "../services/language-keywords-build.js";
import { mergeResults } from "../services/merge-results.js";
import { runPersonaProposalTriage, validatePersonaPolicy } from "../services/persona-proposal-triage.js";
import { runPreConsolidationFlush } from "../services/pre-consolidation-flush.js";
import { runReflection, runReflectionMeta, runReflectionRules } from "../services/reflection.js";
import { insertRulesUnderSection } from "../services/tools-md-section.js";
import { parseSourceDate } from "../utils/dates.js";
import { parseDuration } from "../utils/duration.js";
import { resolveTierPreferenceWithSources } from "../utils/llm-selection.js";
import { pluginLogger, resetPluginLogger, restoreDefaultLogger } from "../utils/logger.js";
import { versionInfo } from "../versionInfo.js";
import { HYBRID_MEM_CLI_ROOT_DESCRIPTOR } from "./help-text.js";

/**
 * `loadOpenClawPluginCliRegistry` calls `register()` with `registrationMode: "cli-metadata"` only to
 * collect CLI metadata without activating the full plugin (issue #1111).
 */
export function registerHybridMemCliMetadataOnly(api: ClawdbotPluginApi): void {
  api.registerCli(
    () => {
      // Full Commander wiring runs on full registration or when a lazy placeholder loads this plugin.
    },
    { descriptors: [HYBRID_MEM_CLI_ROOT_DESCRIPTOR] },
  );
}
