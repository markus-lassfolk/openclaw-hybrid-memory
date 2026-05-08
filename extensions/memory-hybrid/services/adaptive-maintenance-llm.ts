import type OpenAI from "openai";
import { getEnv } from "../utils/env-manager.js";
import { estimateTokens } from "../utils/text.js";
import {
  type AdaptiveFailureKind,
  type AdaptiveModelLimitsStateV1,
  ADAPTIVE_MODEL_LIMITS_VERSION,
  getEffectiveModelLimits,
  loadAdaptiveModelLimits,
  recordAdaptiveFailure,
  recordAdaptiveSuccess,
  saveAdaptiveModelLimits,
} from "./adaptive-model-limits.js";
import {
  chatCompleteWithRetryDetailed,
  distillBatchTokenLimit,
  distillMaxOutputTokens,
  is403QuotaOrRateLimitLike,
  is429OrWrapped,
  isContextLengthError,
  type ChatCompleteWithRetryDetails,
} from "./chat.js";
import type { CostFeatureId } from "./cost-feature-labels.js";
import { capturePluginError } from "./error-reporter.js";

export type MaintenanceLlmLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type AdaptiveMaintenanceLlmOptions = {
  model: string;
  modelSource?: string;
  fallbackModels?: string[];
  content: string;
  temperature: number;
  maxTokens: number;
  openai: OpenAI;
  label: string;
  feature: CostFeatureId;
  logger: MaintenanceLlmLogger;
  adaptiveStatePath?: string;
  enabled?: boolean;
};

function emptyState(): AdaptiveModelLimitsStateV1 {
  return { version: ADAPTIVE_MODEL_LIMITS_VERSION, models: {} };
}

function classifyAdaptiveFailure(err: Error): AdaptiveFailureKind {
  if (isContextLengthError(err)) return "context_length";
  if (is429OrWrapped(err)) return "rate_limit";
  if (is403QuotaOrRateLimitLike(err)) return "quota";
  if (/timed out|llm request timeout|request was aborted|Request was aborted/i.test(err.message)) return "timeout";
  return "other";
}

function compatibleFallbacks(
  content: string,
  fallbackModels: string[],
  logger: MaintenanceLlmLogger,
  label: string,
): string[] {
  const inputTokens = estimateTokens(content);
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const fb of fallbackModels) {
    if (inputTokens <= distillBatchTokenLimit(fb)) kept.push(fb);
    else skipped.push(fb);
  }
  if (skipped.length > 0) {
    logger.info?.(`${label}: skipping context-incompatible fallbacks: ${skipped.join(", ")}`);
  }
  return kept;
}

export async function chatCompleteWithAdaptiveMaintenanceRetry(
  opts: AdaptiveMaintenanceLlmOptions,
): Promise<ChatCompleteWithRetryDetails> {
  const envAdaptiveOn = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
  const enabled = opts.enabled !== undefined ? opts.enabled : envAdaptiveOn;
  const envAdaptiveState = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL_STATE") ?? "").trim();
  const adaptiveStatePath = envAdaptiveState || opts.adaptiveStatePath;
  const state = enabled && adaptiveStatePath ? loadAdaptiveModelLimits(adaptiveStatePath) : emptyState();
  const catalogBatchTokenLimit = distillBatchTokenLimit(opts.model);
  const catalogMaxOutputTokens = distillMaxOutputTokens(opts.model);
  const inputTokens = estimateTokens(opts.content);
  const effective = enabled
    ? getEffectiveModelLimits({
        state,
        model: opts.model,
        catalogBatchTokenLimit,
        catalogMaxOutputTokens,
        minBatchTokenLimit: Math.max(1024, inputTokens + 128),
        minMaxOutputTokens: Math.min(128, opts.maxTokens),
      })
    : {
        batchTokenLimit: catalogBatchTokenLimit,
        maxOutputTokens: catalogMaxOutputTokens,
        source: "catalog" as const,
      };
  const maxTokens = Math.max(128, Math.min(opts.maxTokens, effective.maxOutputTokens));
  const fallbackModels = compatibleFallbacks(opts.content, opts.fallbackModels ?? [], opts.logger, opts.label);

  opts.logger.info?.(
    `${opts.label}: starting with model ${opts.model} (source=${opts.modelSource ?? "configured"}; adaptive=${enabled ? effective.source : "disabled"}; inputTokens≈${inputTokens}; maxTokens=${maxTokens})`,
  );
  opts.logger.info?.(`${opts.label}: fallback chain = [${fallbackModels.length > 0 ? fallbackModels.join(", ") : ""}]`);

  try {
    const detail = await chatCompleteWithRetryDetailed({
      model: opts.model,
      content: opts.content,
      temperature: opts.temperature,
      maxTokens,
      openai: opts.openai,
      fallbackModels,
      label: opts.label,
      feature: opts.feature,
    });
    if (enabled) {
      const usedModel = detail.modelUsed;
      const usedCatalogBatch = distillBatchTokenLimit(usedModel);
      const usedCatalogOutput = distillMaxOutputTokens(usedModel);
      recordAdaptiveSuccess({
        state,
        model: usedModel,
        catalogBatchTokenLimit: usedCatalogBatch,
        catalogMaxOutputTokens: usedCatalogOutput,
        usedBatchTokenLimit: Math.min(effective.batchTokenLimit, usedCatalogBatch),
        usedMaxOutputTokens: Math.min(maxTokens, usedCatalogOutput),
      });
      if (adaptiveStatePath) saveAdaptiveModelLimits(adaptiveStatePath, state);
    }
    if (detail.modelUsed !== opts.model) {
      opts.logger.info?.(`${opts.label}: succeeded with fallback model ${detail.modelUsed}`);
    }
    return detail;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (enabled) {
      const kind = classifyAdaptiveFailure(error);
      recordAdaptiveFailure({
        state,
        model: opts.model,
        kind,
        catalogBatchTokenLimit,
        catalogMaxOutputTokens,
        usedBatchTokenLimit: effective.batchTokenLimit,
        usedMaxOutputTokens: maxTokens,
      });
      if (adaptiveStatePath) {
        try {
          saveAdaptiveModelLimits(adaptiveStatePath, state);
        } catch (saveErr) {
          capturePluginError(saveErr instanceof Error ? saveErr : new Error(String(saveErr)), {
            subsystem: "cli",
            operation: "adaptive-maintenance-llm-save",
          });
        }
      }
      opts.logger.info?.(`${opts.label}: recorded adaptive ${kind} failure for ${opts.model}`);
    }
    throw error;
  }
}
