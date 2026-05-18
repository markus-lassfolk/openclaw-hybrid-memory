import { getEnv } from "../../../utils/env-manager.js";
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

import { findPluginRoot } from "../../../utils/plugin-root.js";

import type { CredentialType } from "../../../config.js";
import {
  getCronModelConfig,
  getLLMModelPreference,
  getLLMModelPreferenceUnfiltered,
  getProvidersWithKeys,
  isCompactVerbosity,
  resolveReflectionModelAndFallbacks,
} from "../../../config.js";
import { resolveSecretRef } from "../../../config/parsers/core.js";
import { getEffectiveModelLimits, loadAdaptiveModelLimits } from "../../../services/adaptive-model-limits.js";
import { chatComplete, distillBatchTokenLimit, distillMaxOutputTokens } from "../../../services/chat.js";
import { CostFeature } from "../../../services/cost-feature-labels.js";
import { readGuardTimestampMs } from "../../../services/cron-guard.js";
import { HYBRID_MEM_CRON_ENV_SANITIZER_MARKER } from "../../../services/cron-job-bash-harness.js";
import { reconcileAllCronRunLedgers } from "../../../services/cron-maintenance-reconciler.js";
import {
  collectRecentHmExitLedgerPaths,
  findDeprecatedHybridMemCronTokens,
  findDeprecatedTokensInHmExitContent,
} from "../../../services/deprecated-cron-commands.js";
import {
  type EmbeddingConfig,
  GOOGLE_EMBED_DEFAULT_DIMENSIONS,
  GOOGLE_EMBED_DEFAULT_MODEL,
  OPENAI_ONLY_EMBED_MODELS,
  createEmbeddingProvider,
} from "../../../services/embeddings.js";
import { formatOpenAiEmbeddingDisplayLabel } from "../../../services/embeddings/shared.js";
import { capturePluginError } from "../../../services/error-reporter.js";
import {
  analyzeCronJobsAgainstHeartbeatPatterns,
  extractCronJobMessageEntries,
  getHeartbeatMatchersForVerify,
} from "../../../services/goal-stewardship-verify-cron.js";
import { HYBRID_MEM_CRON_DEFAULT_JOB_STEPS } from "../../../services/hybrid-mem-cron-default-job-steps.js";
import { resolveWireApi } from "../../../services/model-capabilities.js";
import { callResponsesApi } from "../../../services/responses-adapter.js";
import { appendVectorLifecycleAuditEvent } from "../../../services/vector-lifecycle-audit.js";
import { hasOAuthProfiles } from "../../../utils/auth.js";
import { PLUGIN_ID, getRestartPendingPath } from "../../../utils/constants.js";
import { inferModelProviderPrefix } from "../../../utils/model-provider-family.js";
import { isHeavyModel } from "../../../utils/model-tier.js";
import {
  buildUnsupportedPerAgentCompactionWarning,
  buildCompactionWatchdogAlert,
  DEFAULT_COMPACTION_MODEL,
  isCompactionModelTooStrong,
  resolveCompactionModelSelection,
} from "../../../utils/compaction-model-watchdog.js";
import {
  extractCronStoreJobModel,
  readEffectiveAgentChatPrimaryFromOpenclawJsonRoot,
} from "../../../utils/openclaw-agent-defaults.js";
import {
  detectRecommendedEmbeddingSetup,
  ensureGoalStewardshipHeartbeatCronJob,
  ensureMaintenanceCronJobs,
  getDashboardUrl,
  getPluginConfigFromFile,
  resolveOpenclawJsonPathForWorkspace,
} from "../../cmd-install.js";
import { approxIntervalMs, relativeTime } from "../../shared.js";
import { applyAzureFoundryVerifyDirectClientAuth } from "../../verify-llm-azure-auth.js";

import type { VerifyRunState } from "../verify-run-state.js";
import {
  credentialSource,
  ensureRawPluginConfigOnState,
  rawClaudeApiKey,
  rawDistillApiKey,
  rawEmbeddingApiKey,
  rawLlmProviderApiKey,
} from "../plugin-config-credentials.js";

export async function runVerifyLlmModelsSection(state: VerifyRunState): Promise<void> {
  ensureRawPluginConfigOnState(state);
  const { ctx, opts, cfg, factsDb, vectorDb, embeddings, credentialsDb, resolvedSqlitePath, resolvedLancePath, openai, log, tableLog, OK, FAIL, PAUSE, WARN_LINE, noEmoji, issues, fixes, warnings, loadBlocking, extDir, defaultConfigPath, openclawDir, openclawConfigRead, recommendedEmbedding, dashboardUrl } = state;

  // ───── LLM / models table: one row per model from llm.nano / llm.maintenance / llm.default / llm.heavy; auth + source ─────
  tableLog("\n───── LLM / Models (from llm.nano, llm.maintenance, llm.default, llm.heavy) ─────");
  const cronCfg = getCronModelConfig(cfg);
  const providersWithKeys = getProvidersWithKeys(cronCfg);
  const authOrder = (cfg as Record<string, unknown>).auth as { order?: Record<string, string[]> } | undefined;
  const gatewayPort = getEnv("OPENCLAW_GATEWAY_PORT");
  const gatewayToken = getEnv("OPENCLAW_GATEWAY_TOKEN");
  const gatewayAvailable = Boolean(
    gatewayPort && Number(gatewayPort) >= 1 && Number(gatewayPort) <= 65535 && gatewayToken,
  );
  const tierNano = getLLMModelPreferenceUnfiltered(cronCfg, "nano");
  const tierMaintenance = getLLMModelPreferenceUnfiltered(cronCfg, "maintenance");
  const tierDefault = getLLMModelPreferenceUnfiltered(cronCfg, "default");
  const tierHeavy = getLLMModelPreferenceUnfiltered(cronCfg, "heavy");
  const nanoExplicitConfigured =
    Array.isArray(cronCfg.llm?.nano) && cronCfg.llm.nano.some((m) => typeof m === "string" && m.trim().length > 0);
  const maintenanceExplicitConfigured =
    Array.isArray(cronCfg.llm?.maintenance) &&
    cronCfg.llm.maintenance.some((m) => typeof m === "string" && m.trim().length > 0);
  const allModelsUnfiltered: string[] = [...tierNano, ...tierMaintenance, ...tierDefault, ...tierHeavy];
  function tiersForModel(model: string): string {
    const tags: string[] = [];
    if (tierNano.includes(model)) tags.push("nano");
    if (tierMaintenance.includes(model)) tags.push("maintenance");
    if (tierDefault.includes(model)) tags.push("default");
    if (tierHeavy.includes(model)) tags.push("heavy");
    if (tags.length === 0) return "—";
    return tags.join(", ");
  }
  const fmtTierList = (arr: string[]) => (arr.length > 0 ? arr.join(", ") : "(none)");
  tableLog("  Effective tier lists (first model in each tier wins when that tier is selected):");
  tableLog(
    `    nano:    ${fmtTierList(tierNano)}${nanoExplicitConfigured ? "" : "  — llm.nano unset; nano tier reuses the default list"}`,
  );
  tableLog(
    `    maintenance: ${fmtTierList(tierMaintenance)}${maintenanceExplicitConfigured ? "" : "  — llm.maintenance unset; maintenance tier reuses the default list"}`,
  );
  tableLog(`    default: ${fmtTierList(tierDefault)}`);
  tableLog(`    heavy:   ${fmtTierList(tierHeavy)}`);
  tableLog(
    `    First choice per tier: nano=${tierNano[0] ?? "—"} | maintenance=${tierMaintenance[0] ?? "—"} | default=${tierDefault[0] ?? "—"} | heavy=${tierHeavy[0] ?? "—"}`,
  );
  const distillMainTier = cfg.distill?.modelTier ?? "maintenance";
  const distillMainTierRaw = (cfg.distill as { modelTier?: string } | undefined)?.modelTier ?? "maintenance";
  const distillMainRequestedHeavy = distillMainTierRaw === "heavy";
  // Show the actual effective tier after clamping (cmd-distill.ts clamps "heavy" to "maintenance")
  const effectiveDistillMainTier = distillMainRequestedHeavy ? "maintenance" : distillMainTier;
  const distillMainEffective = getLLMModelPreference(cronCfg, effectiveDistillMainTier)[0] ?? "—";
  tableLog(
    `    Distill main pass: distill.modelTier=${distillMainTierRaw}${distillMainRequestedHeavy ? " (clamped to maintenance)" : ""} -> ${distillMainEffective}; --model overrides one run.`,
  );
  const dreamOverride =
    typeof cfg.nightlyCycle?.model === "string" && cfg.nightlyCycle.model.trim().length > 0
      ? cfg.nightlyCycle.model.trim()
      : null;
  const dreamEffective = dreamOverride ?? getLLMModelPreference(cronCfg, "maintenance")[0] ?? "—";
  const extractionTier = cfg.distill?.extractionModelTier ?? "nano";
  let compactionSelection = resolveCompactionModelSelection(undefined, { fallbackPolicy: "inherit-defaults-primary" });
  const compactionSelectionUnknownReason = openclawConfigRead.root
    ? null
    : openclawConfigRead.error !== undefined
      ? `active OpenClaw config (${defaultConfigPath}) is unreadable/invalid (${openclawConfigRead.error})`
      : `active OpenClaw config (${defaultConfigPath}) is missing`;
  if (openclawConfigRead.root) {
    // Use defaults-primary inheritance fallback to mirror current OpenClaw core behavior
    // when agents.defaults.compaction.model is unset.
    compactionSelection = resolveCompactionModelSelection(openclawConfigRead.root, {
      fallbackPolicy: "inherit-defaults-primary",
    });
  }
  const compactionRoutingUnknownReason =
    compactionSelectionUnknownReason ??
    (compactionSelection.routingUnknownFromConfig
      ? "neither agents.defaults.compaction.model nor agents.defaults.model.primary is set; compaction may follow the active session chat model"
      : null);
  tableLog(
    dreamOverride
      ? `    Dream cycle + MEMORY_INDEX.md: nightlyCycle.model="${dreamOverride}" (overrides default tier for that pipeline).`
      : `    Dream cycle + MEMORY_INDEX.md: uses maintenance tier first choice (${tierMaintenance[0] ?? "—"}) unless nightlyCycle.model is set.`,
  );
  tableLog(
    "    Embeddings / re-index: embedding.model + embedding.* (not llm tiers). Chat LLM spend is separate from embedding API spend.",
  );
  tableLog(
    `    Compaction (agents.*.compaction): provider=${compactionSelection.provider}, model=${compactionSelection.model || "—"}, reason=${compactionSelection.reason}${
      compactionRoutingUnknownReason ? `; status=unknown (${compactionRoutingUnknownReason})` : ""
    }`,
  );

  const adaptiveEnabled = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
  const adaptiveStatePath =
    typeof ctx.resolvedSqlitePath === "string" && ctx.resolvedSqlitePath.length > 0
      ? join(dirname(ctx.resolvedSqlitePath), ".adaptive-llm-limits.json")
      : "";
  tableLog(
    `    Adaptive maintenance LLM sizing: ${adaptiveEnabled ? "enabled" : "disabled"} (state=${adaptiveStatePath}; applies to distill, reflect, extract-reinforcement, self-correction-run)`,
  );
  if (adaptiveEnabled && adaptiveStatePath && existsSync(adaptiveStatePath)) {
    try {
      const adaptiveState = loadAdaptiveModelLimits(adaptiveStatePath);
      const sampleModels = [
        distillMainEffective,
        dreamEffective,
        getLLMModelPreference(cronCfg, extractionTier)[0] ?? "—",
        tierHeavy[0] ?? "—",
      ].filter((m, i, arr) => m !== "—" && arr.indexOf(m) === i);
      for (const sampleModel of sampleModels) {
        const effective = getEffectiveModelLimits({
          state: adaptiveState,
          model: sampleModel,
          catalogBatchTokenLimit: distillBatchTokenLimit(sampleModel),
          catalogMaxOutputTokens: distillMaxOutputTokens(sampleModel),
        });
        tableLog(
          `      ${sampleModel}: batchTokenLimit=${effective.batchTokenLimit}, maxOutputTokens=${effective.maxOutputTokens}, source=${effective.source}`,
        );
      }
    } catch (err) {
      state.warnings.push(
        `adaptive maintenance LLM state could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Maintenance routing warnings: flag when maintenance-adjacent tasks are routed to heavy/expensive models unintentionally.
  // NOTE: cmd-distill.ts now clamps distill.modelTier=heavy to maintenance, so this check uses effectiveDistillMainTier.
  if (distillMainEffective !== "—" && isHeavyModel(distillMainEffective)) {
    state.warnings.push(
      `distill.modelTier=${distillMainTier} routes the main distill pass to a heavy/expensive first-choice model (${distillMainEffective}); configure llm.maintenance with a cheap-first list or set distill.modelTier=nano`,
    );
  }
  if (distillMainRequestedHeavy) {
    state.warnings.push(
      "distill.modelTier=heavy is not supported for the main distill pass (clamped to maintenance in cmd-distill.ts). Use --model to override for a single run if needed.",
    );
  }
  const extractionFirst =
    getLLMModelPreference(cronCfg, extractionTier)[0] ?? getLLMModelPreference(cronCfg, "nano")[0] ?? "—";
  if (extractionTier !== "heavy" && extractionFirst !== "—" && isHeavyModel(extractionFirst)) {
    state.warnings.push(
      `distill.extractionModelTier=${extractionTier} routes session extraction to a heavy/expensive first-choice model (${extractionFirst}); set distill.extractionModelTier=nano or configure llm.maintenance and use distill.extractionModelTier=maintenance`,
    );
  }
  if (dreamEffective !== "—" && isHeavyModel(dreamEffective)) {
    state.warnings.push(
      `dream-cycle/MEMORY_INDEX routes to a heavy/expensive model (${dreamEffective}); set nightlyCycle.model to a cheaper model or configure llm.maintenance with a cheap-first list`,
    );
  }
  if (compactionRoutingUnknownReason) {
    state.warnings.push(
      `verify watchdog: compaction routing check is unknown because ${compactionRoutingUnknownReason}; set/repair config and rerun verify.`,
    );
  } else {
    const unsupportedWarning = buildUnsupportedPerAgentCompactionWarning(compactionSelection, { context: "verify" });
    if (unsupportedWarning) state.warnings.push(unsupportedWarning);
  }
  if (!compactionRoutingUnknownReason && isCompactionModelTooStrong(compactionSelection.model)) {
    const alert =
      buildCompactionWatchdogAlert({
        stage: "verify",
        model: compactionSelection.model,
        provider: compactionSelection.provider,
        source: compactionSelection.reason,
      }) ??
      `compaction routing uses a stronger-than-mini model (provider=${compactionSelection.provider}, model=${compactionSelection.model}, reason=${compactionSelection.reason}). Set agents.defaults.compaction.model to a mini/nano model such as ${DEFAULT_COMPACTION_MODEL}.`;
    state.warnings.push(alert);
  }
  const _allModelsFiltered: string[] = [
    ...getLLMModelPreference(cronCfg, "nano"),
    ...getLLMModelPreference(cronCfg, "maintenance"),
    ...getLLMModelPreference(cronCfg, "default"),
    ...getLLMModelPreference(cronCfg, "heavy"),
  ];
  // Reference models always shown in verify so users see Opus, GPT-5.4, Codex, o3, etc. with auth/source
  const VERIFY_REFERENCE_MODELS: string[] = [
    "anthropic/claude-opus-4-6",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-5-20251001",
    "openai/gpt-5.4",
    "openai/gpt-4.1-mini",
    "openai/gpt-4.1-nano",
    "openai/o3",
    "openai/o1",
    "openai/gpt-5-codex",
    "google/gemini-3.1-pro-preview",
    "google/gemini-2.5-flash",
    "google/gemini-2.5-flash-lite",
    "minimax/MiniMax-M2.5",
  ];
  const providerFromModel = (m: string) => {
    if (m.includes("/")) {
      return m.split("/")[0].toLowerCase();
    }
    const bare = m.trim().toLowerCase();
    if (bare.startsWith("gemini-")) return "google";
    if (bare.startsWith("claude-")) return "anthropic";
    if (bare.startsWith("gpt-") || bare.match(/^o[0-9]/)) return "openai";
    return "openai";
  };
  const disabledSet = new Set((cfg.llm?.disabledProviders ?? []).map((p) => String(p).trim().toLowerCase()));
  const _defaultTestModel: Record<string, string> = {
    openai: "openai/gpt-4.1-nano",
    google: "google/gemini-2.5-flash-lite",
    anthropic: "anthropic/claude-haiku-4-5-20251001",
    ollama: "ollama/llama3.2",
    minimax: "minimax/minimax-01",
  };
  function llmCredentialSource(provider: string): string {
    if (gatewayAvailable && hasOAuthProfiles(authOrder?.order?.[provider], provider)) return "gateway";
    if (provider === "openai")
      return credentialSource(rawEmbeddingApiKey(state)) || credentialSource(rawLlmProviderApiKey(state, "openai"));
    if (provider === "google")
      return credentialSource(rawDistillApiKey(state)) || credentialSource(rawLlmProviderApiKey(state, "google"));
    if (provider === "anthropic")
      return credentialSource(rawClaudeApiKey(state)) || credentialSource(rawLlmProviderApiKey(state, "anthropic"));
    return credentialSource(rawLlmProviderApiKey(state, provider)) || "plugin";
  }
  const gatewayBaseUrl =
    gatewayPort && Number(gatewayPort) >= 1 && Number(gatewayPort) <= 65535
      ? `http://127.0.0.1:${Number(gatewayPort)}/v1`
      : undefined;
  const VERIFY_LLM_BASE_URLS: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    google: "https://generativelanguage.googleapis.com/v1beta/openai/",
    anthropic: "https://api.anthropic.com/v1",
    ollama: "http://127.0.0.1:11434/v1",
    minimax: "https://api.minimax.chat/v1",
  };
  function resolveKey(raw: unknown): string | undefined {
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    const trimmed = raw.trim();
    const resolved = trimmed.startsWith("env:") || trimmed.startsWith("file:") ? resolveSecretRef(trimmed) : trimmed;
    return typeof resolved === "string" && resolved.length >= 10 ? resolved : undefined;
  }
  function getDirectApiKey(provider: string): string | undefined {
    const prov = cronCfg.llm?.providers as Record<string, { apiKey?: string }> | undefined;
    if (provider === "openai") {
      // Prefer OPENAI_API_KEY so Azure (embedding) and OpenAI (chat) can use different keys.
      const fromProv = resolveKey(prov?.openai?.apiKey);
      if (fromProv) return fromProv;
      const fromEnv = getEnv("OPENAI_API_KEY")?.trim();
      if (fromEnv && fromEnv.length >= 10) return fromEnv;
      return resolveKey(cronCfg.embedding?.apiKey);
    }
    if (provider === "google") {
      const fromProv = resolveKey(prov?.google?.apiKey ?? cronCfg.distill?.apiKey);
      if (fromProv) return fromProv;
      const fromEnv = getEnv("GOOGLE_API_KEY")?.trim();
      if (fromEnv && fromEnv.length >= 10) return fromEnv;
      return undefined;
    }
    if (provider === "anthropic") {
      const fromProv = resolveKey(
        prov?.anthropic?.apiKey ?? (cronCfg.claude as { apiKey?: string } | undefined)?.apiKey,
      );
      if (fromProv) return fromProv;
      const fromEnv = getEnv("ANTHROPIC_API_KEY")?.trim();
      if (fromEnv && fromEnv.length >= 10) return fromEnv;
      return undefined;
    }
    if (provider === "ollama") return "ollama";
    // Azure Foundry: use AZURE_OPENAI_API_KEY when llm.providers key is not set.
    if (
      (provider === "azure-foundry" || provider === "azure-foundry-responses" || provider === "azure-foundry-direct") &&
      !resolveKey(prov?.[provider]?.apiKey)
    ) {
      const fromEnv = getEnv("AZURE_OPENAI_API_KEY")?.trim();
      if (fromEnv && fromEnv.length >= 10) return fromEnv;
    }
    return resolveKey(prov?.[provider]?.apiKey);
  }
  function buildDirectClient(provider: string): OpenAI | undefined {
    const apiKey = getDirectApiKey(provider);
    if (!apiKey) return undefined;
    const provEntry = (cronCfg.llm?.providers as Record<string, { baseURL?: string; baseUrl?: string }> | undefined)?.[
      provider
    ];
    let baseURL =
      (typeof provEntry?.baseURL === "string" && provEntry.baseURL.trim() ? provEntry.baseURL.trim() : undefined) ??
      (typeof provEntry?.baseUrl === "string" && provEntry.baseUrl.trim() ? provEntry.baseUrl.trim() : undefined) ??
      VERIFY_LLM_BASE_URLS[provider];
    if (!baseURL) return undefined;
    // Anthropic's OpenAI-compatible chat endpoint requires /v1 suffix; normalize host-only baseURL (issue #950).
    if (provider === "anthropic") {
      baseURL = baseURL.replace(/\/+$/, "");
      if (!baseURL.endsWith("/v1")) {
        baseURL = `${baseURL}/v1`;
      }
    }
    const opts: {
      apiKey: string;
      baseURL: string;
      defaultHeaders?: Record<string, string>;
      defaultQuery?: Record<string, string>;
      fetch?: typeof globalThis.fetch;
    } = {
      apiKey,
      baseURL,
    };
    if (provider === "anthropic") opts.defaultHeaders = { "anthropic-version": "2023-06-01" };
    applyAzureFoundryVerifyDirectClientAuth(opts, provider, apiKey);
    return new OpenAI(opts);
  }
  // One row per model: configured models + reference models (Opus, GPT-5.4, Codex, o3, etc.)
  const configModelSet = new Set(allModelsUnfiltered);
  const uniqueModels = [...new Set([...allModelsUnfiltered, ...VERIFY_REFERENCE_MODELS])];
  uniqueModels.sort((a, b) => providerFromModel(a).localeCompare(providerFromModel(b)) || a.localeCompare(b));
  const llmRows: {
    model: string;
    provider: string;
    hasOAuth: boolean;
    hasApi: boolean;
    enabled: boolean;
    source: string;
    inConfig: boolean;
    tiersLabel: string;
    oauthResult?: boolean;
    apiResult?: boolean;
    oauthError?: string;
    apiError?: string;
    /** When set, direct API test was skipped (e.g. Responses API); show this in API column, do not treat as failed. */
    apiSkippedReason?: string;
  }[] = [];
  function shortError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.slice(0, 100).replace(/\s+/g, " ").trim();
  }
  /** Azure Responses rejects max_output_tokens below 16; chat probes still work with a small cap. */
  const VERIFY_LLM_PROBE_MAX_TOKENS = 64;
  /** Cache direct client per provider so we use the same client for each model of that provider. */
  const directClientCache = new Map<string, OpenAI | null>();
  function getDirectClient(provider: string): OpenAI | null {
    if (!directClientCache.has(provider)) {
      directClientCache.set(provider, buildDirectClient(provider) ?? null);
    }
    return directClientCache.get(provider)!;
  }
  for (const model of uniqueModels) {
    const provider = providerFromModel(model);
    const hasApi = providersWithKeys.includes(provider);
    const hasOAuth = gatewayAvailable && Boolean(hasOAuthProfiles(authOrder?.order?.[provider], provider));
    const enabled = !disabledSet.has(provider);
    let source = llmCredentialSource(provider);
    if (!source && gatewayAvailable && (hasOAuth || hasApi)) source = "gateway";
    if (!source) source = "—";
    const inConfig = configModelSet.has(model);
    const tiersLabel = tiersForModel(model);
    let oauthResult: boolean | undefined = undefined;
    let apiResult: boolean | undefined = undefined;
    let oauthError: string | undefined = undefined;
    let apiError: string | undefined = undefined;
    let apiSkippedReason: string | undefined = undefined;
    // Test each model that has credentials (OAuth or API), so we report which work even if not yet in llm.nano/maintenance/default/heavy.
    if (opts.testLlm && enabled && (hasOAuth || hasApi)) {
      const bareModel = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
      const wireApi = resolveWireApi(model);
      // Some Azure SKUs only expose Responses; others reject non-default temperature on chat — probe must match.
      const isResponsesOnlyModel =
        wireApi === "responses" ||
        (provider === "azure-foundry" && bareModel === "gpt-5.4-pro") ||
        (provider === "azure-foundry" && /^o3-pro$/i.test(bareModel)) ||
        (provider === "openai" && (bareModel === "gpt-5-codex" || bareModel === "codex"));

      if (hasOAuth && gatewayBaseUrl && gatewayToken) {
        try {
          const oauthClient = new OpenAI({ apiKey: gatewayToken, baseURL: gatewayBaseUrl });
          await chatComplete({
            model,
            content: "Reply with exactly: OK",
            maxTokens: VERIFY_LLM_PROBE_MAX_TOKENS,
            temperature: 1,
            openai: oauthClient,
            feature: CostFeature.verifyCliLlm,
            ...(isResponsesOnlyModel ? { wireApi: "responses" as const } : {}),
          });
          oauthResult = true;
        } catch (e) {
          oauthError = shortError(e);
          capturePluginError(e as Error, {
            subsystem: "cli",
            operation: "runVerifyForCli:llm-test-oauth",
            phase: provider,
          });
          oauthResult = false;
        }
      }
      if (hasApi) {
        if (isResponsesOnlyModel) {
          const directClient = getDirectClient(provider);
          if (!directClient) {
            apiResult = false;
            apiError = "No direct client (missing apiKey or baseURL)";
          } else {
            try {
              await callResponsesApi(directClient, {
                model: bareModel,
                content: "Reply with exactly: OK",
                maxTokens: VERIFY_LLM_PROBE_MAX_TOKENS,
                temperature: 1,
              });
              apiResult = true;
              apiSkippedReason = undefined;
            } catch (e) {
              const errMsg = shortError(e);
              if (errMsg.includes("does not expose responses.create") || /\b(404|405)\b/.test(errMsg)) {
                apiResult = undefined;
                apiError = undefined;
                apiSkippedReason = "N/A (Responses API not available on endpoint)";
              } else {
                apiError = errMsg;
                if (
                  /\b400\b/i.test(errMsg) &&
                  (provider === "azure-foundry" ||
                    provider === "azure-foundry-responses" ||
                    provider === "azure-foundry-direct") &&
                  errMsg.length < 160
                ) {
                  apiError = `${errMsg} — HTTP 400 with a minimal body often means the gateway rejected the route or request shape (wrong APIM product path vs resource URL, or policy). See docs/TROUBLESHOOTING.md (#949).`;
                }
                capturePluginError(e as Error, {
                  subsystem: "cli",
                  operation: "runVerifyForCli:llm-test-responses-api",
                  phase: provider,
                });
                apiResult = false;
              }
            }
          }
        } else {
          const directClient = getDirectClient(provider);
          if (!directClient) {
            apiResult = false;
            apiError = "No direct client (missing apiKey or baseURL)";
          } else {
            try {
              await chatComplete({
                model: bareModel,
                content: "Reply with exactly: OK",
                maxTokens: VERIFY_LLM_PROBE_MAX_TOKENS,
                temperature: 1,
                openai: directClient,
                feature: CostFeature.verifyCliLlm,
              });
              apiResult = true;
            } catch (e) {
              apiError = shortError(e);
              if (
                apiError &&
                /\b400\b/i.test(apiError) &&
                (provider === "azure-foundry" ||
                  provider === "azure-foundry-responses" ||
                  provider === "azure-foundry-direct") &&
                apiError.length < 160
              ) {
                apiError = `${apiError} — HTTP 400 with a minimal body often means the gateway rejected the route or request shape (wrong APIM product path vs resource URL, or policy). See docs/TROUBLESHOOTING.md (#949).`;
              }
              capturePluginError(e as Error, {
                subsystem: "cli",
                operation: "runVerifyForCli:llm-test-api",
                phase: provider,
              });
              apiResult = false;
            }
          }
        }
      }
    }
    llmRows.push({
      model,
      provider,
      hasOAuth,
      hasApi,
      enabled,
      source,
      inConfig,
      tiersLabel,
      oauthResult,
      apiResult,
      oauthError,
      apiError,
      apiSkippedReason,
    });
  }
  if (llmRows.length === 0) {
    tableLog(
      "  No LLM models configured (add llm.nano / llm.maintenance / llm.default / llm.heavy or API keys / OAuth).",
    );
    tableLog("  LLMs: add model tiers or API keys in config. See docs/LLM-AND-PROVIDERS.md.");
    tableLog("");
    tableLog("  Summary: Configure LLM tiers or API keys to use memory and cron jobs.");
  } else {
    const llmCols = [
      "Model",
      "Provider",
      "Auth (OAuth / API key)",
      "Source",
      "Tier(s)",
      "Enabled",
      ...(opts.testLlm ? ["OAuth Result", "API Result"] : []),
    ];
    const llmW1 = Math.max(8, ...llmRows.map((r) => r.model.length), 28);
    const llmW2 = Math.max(6, ...llmRows.map((r) => r.provider.length), 10);
    const llmW3 = Math.max(22, 24);
    const llmW4 = 8;
    const llmW5 = Math.max(9, ...llmRows.map((r) => r.tiersLabel.length), 22);
    const llmW6 = 8;
    const llmW7 = opts.testLlm ? 14 : 0;
    const llmW8 = opts.testLlm ? 12 : 0;
    tableLog(
      `  ${llmCols[0].padEnd(llmW1)}  ${llmCols[1].padEnd(llmW2)}  ${llmCols[2].padEnd(llmW3)}  ${llmCols[3].padEnd(llmW4)}  ${llmCols[4].padEnd(llmW5)}  ${llmCols[5].padEnd(llmW6)}${opts.testLlm ? `  ${llmCols[6].padEnd(llmW7)}  ${llmCols[7]}` : ""}`,
    );
    const llmSepLen = llmW1 + llmW2 + llmW3 + llmW4 + llmW5 + llmW6 + 12 + (opts.testLlm ? llmW7 + llmW8 + 4 : 0);
    tableLog(`  ${"-".repeat(llmSepLen)}`);
    for (const row of llmRows) {
      const credStr = `OAuth:${row.hasOAuth ? "True" : "False"} / API:${row.hasApi ? "True" : "False"}`;
      const tiersStr = row.tiersLabel;
      const enabledStr = row.enabled ? (noEmoji ? "Enabled" : "✅ Enabled") : noEmoji ? "Disabled" : "❌ Disabled";
      // When --test-llm: show Success/Failed if we ran the test; "Skipped" if enabled+inConfig but no creds to test; "—" if not in config
      const oauthStr =
        row.oauthResult === true
          ? noEmoji
            ? "Success"
            : "✅ Success"
          : row.oauthResult === false
            ? noEmoji
              ? "Failed"
              : "❌ Failed"
            : opts.testLlm && row.enabled && row.inConfig && !row.hasOAuth
              ? noEmoji
                ? "Skipped (no OAuth)"
                : "⏭️ Skipped"
              : "—";
      const apiStr = row.apiSkippedReason
        ? row.apiSkippedReason
        : row.apiResult === true
          ? noEmoji
            ? "Success"
            : "✅ Success"
          : row.apiResult === false
            ? noEmoji
              ? "Failed"
              : "❌ Failed"
            : opts.testLlm && row.enabled && row.inConfig && !row.hasApi
              ? noEmoji
                ? "Skipped (no key)"
                : "⏭️ Skipped"
              : "—";
      tableLog(
        `  ${row.model.padEnd(llmW1)}  ${row.provider.padEnd(llmW2)}  ${credStr.padEnd(llmW3)}  ${row.source.padEnd(llmW4)}  ${tiersStr.padEnd(llmW5)}  ${enabledStr.padEnd(llmW6)}${opts.testLlm ? `  ${oauthStr.padEnd(llmW7)}  ${apiStr}` : ""}`,
      );
    }
    const failedRows = opts.testLlm ? llmRows.filter((r) => r.oauthError || r.apiError) : [];
    if (failedRows.length > 0) {
      tableLog("  Failed test details:");
      let has401Openai = false;
      for (const row of failedRows) {
        if (row.oauthError) tableLog(`    ${row.model} (OAuth): ${row.oauthError}`);
        if (row.apiError) {
          tableLog(`    ${row.model} (API): ${row.apiError}`);
          if (row.provider === "openai" && /401|incorrect api key/i.test(row.apiError)) has401Openai = true;
        }
      }
      if (has401Openai) {
        tableLog(
          "  Note: OpenAI: llm.providers.openai.apiKey or OPENAI_API_KEY. Google: llm.providers.google.apiKey or distill.apiKey or GOOGLE_API_KEY. Azure: llm.providers['azure-foundry'].apiKey or AZURE_OPENAI_API_KEY. See docs/LLM-AND-PROVIDERS.md.",
        );
      }
      tableLog("");
    }
    tableLog(
      '  (Tier(s) = which tier lists include this model; "—" = reference row only, not in your llm.nano/maintenance/default/heavy. Source = key origin. Enabled = provider not in llm.disabledProviders. Skipped = not tested.)',
    );
    const llmProvidersWithCreds = new Set(llmRows.filter((r) => r.hasApi || r.hasOAuth).map((r) => r.provider)).size;
    const llmOk = llmProvidersWithCreds >= 1;
    if (llmOk) {
      tableLog(
        `  LLMs: OK — credentials available for ${llmProvidersWithCreds} provider(s). Source "—" or "gateway" = key from OpenClaw/env (fine).`,
      );
    } else {
      tableLog(
        "  LLMs: no credentials for any provider — set llm.providers.<provider>.apiKey in config or use gateway OAuth. See docs/LLM-AND-PROVIDERS.md.",
      );
    }
    tableLog("");
    if (state.anyEmbOk && llmOk) {
      tableLog(
        "  Summary: Ready. Embeddings and LLM are configured. Use memory and cron jobs as needed. Run 'openclaw hybrid-mem config' to toggle features.",
      );
    } else {
      tableLog("  Summary: Fix the issue(s) above (or in --- Fixes --- below) before using memory features.");
    }
  }
}
