import { getEnv } from "../utils/env-manager.js";
/**
 * CLI Verify Command Handler
 *
 * Contains runVerifyForCli and its private helper functions.
 * Checks infrastructure (SQLite, LanceDB, embeddings, LLM credentials,
 * cron jobs) and optionally applies fixes.
 *
 * Extracted from cli/handlers.ts to keep that file manageable.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import OpenAI from "openai";

import { findPluginRoot } from "../utils/plugin-root.js";

import type { CredentialType } from "../config.js";
import {
  getCronModelConfig,
  getLLMModelPreference,
  getLLMModelPreferenceUnfiltered,
  getProvidersWithKeys,
  isCompactVerbosity,
  resolveReflectionModelAndFallbacks,
} from "../config.js";
import { resolveSecretRef } from "../config/parsers/core.js";
import { getEffectiveModelLimits, loadAdaptiveModelLimits } from "../services/adaptive-model-limits.js";
import { chatComplete, distillBatchTokenLimit, distillMaxOutputTokens } from "../services/chat.js";
import { CostFeature } from "../services/cost-feature-labels.js";
import { readGuardTimestampMs } from "../services/cron-guard.js";
import { HYBRID_MEM_CRON_ENV_SANITIZER_MARKER } from "../services/cron-job-bash-harness.js";
import { reconcileAllCronRunLedgers } from "../services/cron-maintenance-reconciler.js";
import {
  collectRecentHmExitLedgerPaths,
  findDeprecatedHybridMemCronTokens,
  findDeprecatedTokensInHmExitContent,
} from "../services/deprecated-cron-commands.js";
import {
  type EmbeddingConfig,
  GOOGLE_EMBED_DEFAULT_DIMENSIONS,
  GOOGLE_EMBED_DEFAULT_MODEL,
  OPENAI_ONLY_EMBED_MODELS,
  createEmbeddingProvider,
} from "../services/embeddings.js";
import { formatOpenAiEmbeddingDisplayLabel } from "../services/embeddings/shared.js";
import { capturePluginError } from "../services/error-reporter.js";
import {
  analyzeCronJobsAgainstHeartbeatPatterns,
  extractCronJobMessageEntries,
  getHeartbeatMatchersForVerify,
} from "../services/goal-stewardship-verify-cron.js";
import { HYBRID_MEM_CRON_DEFAULT_JOB_STEPS } from "../services/hybrid-mem-cron-default-job-steps.js";
import { resolveWireApi } from "../services/model-capabilities.js";
import { callResponsesApi } from "../services/responses-adapter.js";
import { appendVectorLifecycleAuditEvent } from "../services/vector-lifecycle-audit.js";
import { hasOAuthProfiles } from "../utils/auth.js";
import { PLUGIN_ID, getRestartPendingPath } from "../utils/constants.js";
import { inferModelProviderPrefix } from "../utils/model-provider-family.js";
import { isHeavyModel } from "../utils/model-tier.js";
import {
  buildUnsupportedPerAgentCompactionWarning,
  buildCompactionWatchdogAlert,
  DEFAULT_COMPACTION_MODEL,
  isCompactionModelTooStrong,
  resolveCompactionModelSelection,
} from "../utils/compaction-model-watchdog.js";
import {
  extractCronStoreJobModel,
  readEffectiveAgentChatPrimaryFromOpenclawJsonRoot,
} from "../utils/openclaw-agent-defaults.js";
import {
  detectRecommendedEmbeddingSetup,
  ensureGoalStewardshipHeartbeatCronJob,
  ensureMaintenanceCronJobs,
  getDashboardUrl,
  getPluginConfigFromFile,
  resolveOpenclawJsonPathForWorkspace,
} from "./cmd-install.js";
import { approxIntervalMs, relativeTime } from "./shared.js";
import { applyAzureFoundryVerifyDirectClientAuth } from "./verify-llm-azure-auth.js";

import type { HandlerContext } from "./handlers.js";
import type { VerifyCliSink } from "./types.js";
import {
  getCachedFactCount,
  readApproxFactsRowCount,
  resetVerifyFactCountCacheForTests,
} from "./verify/fact-count.js";
import { computeVectorSqliteOrphans } from "./verify/orphans.js";
import { readOpenclawConfigRoot } from "./verify/openclaw-config.js";

export {
  computeVectorSqliteOrphans,
  getCachedFactCount,
  readApproxFactsRowCount,
  resetVerifyFactCountCacheForTests,
};
import { createVerifyRunState, type VerifyRunOpts } from "./verify/verify-run-state.js";
import { runVerifyInfrastructureSection } from "./verify/sections/infrastructure.js";
import { runVerifyEmbeddingsSection } from "./verify/sections/embeddings.js";
import { runVerifyLlmModelsSection } from "./verify/sections/llm-models.js";
import { runVerifyConfigCronSection } from "./verify/sections/config-cron.js";
import { runVerifyReconcileSection } from "./verify/sections/reconcile.js";

export async function runVerifyForCli(
  ctx: import("./handlers.js").HandlerContext,
  opts: VerifyRunOpts,
  sink: import("./types.js").VerifyCliSink,
): Promise<void> {
  const state = createVerifyRunState(ctx, opts, sink);
  await runVerifyInfrastructureSection(state);
  await runVerifyEmbeddingsSection(state);
  await runVerifyLlmModelsSection(state);
  await runVerifyConfigCronSection(state);
  await runVerifyReconcileSection(state);
}
