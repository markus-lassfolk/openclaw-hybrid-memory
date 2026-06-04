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
  is403QuotaOrRateLimitLike,
  is429OrWrapped,
  isContextLengthError,
  isMiniMaxThinkingEnabled,
  maintenanceMaxOutputTokens,
  resolveMaintenanceChatTimeoutMs,
  type ChatCompleteWithRetryDetails,
  type MiniMaxThinkingMode,
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
  /** OpenAI chat.completions response_format (chat wire API only). */
  responseFormat?: { type: "json_object" };
  /** Called immediately before a retry backoff sleep. */
  onRetry?: (info: { attempt: number; delayMs: number; error: Error; model: string }) => void;
  /** MiniMax-only: control deep thinking (`disabled` saves output budget for structured JSON). */
  thinkingMode?: MiniMaxThinkingMode;
};

function emptyState(): AdaptiveModelLimitsStateV1 {
  return { version: ADAPTIVE_MODEL_LIMITS_VERSION, models: {} };
}

export function classifyAdaptiveFailure(err: Error): AdaptiveFailureKind {
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
  if (fallbackModels.length === 0) return fallbackModels;
  const inputTokens = estimateTokens(content);
  const possiblyIncompatible = fallbackModels.filter((fb) => inputTokens > distillBatchTokenLimit(fb));
  if (possiblyIncompatible.length > 0) {
    logger.info?.(
      `${label}: fallbacks may hit context limits on retry (${inputTokens} input tokens): ${possiblyIncompatible.join(", ")}`,
    );
  }
  return fallbackModels;
}

type PreparedMaintenanceCall = {
  maxTokens: number;
  fallbackModels: string[];
  enabled: boolean;
  adaptiveStatePath: string | undefined;
  state: AdaptiveModelLimitsStateV1;
  effective: ReturnType<typeof getEffectiveModelLimits>;
  inputTokens: number;
};

function prepareMaintenanceCall(opts: AdaptiveMaintenanceLlmOptions): PreparedMaintenanceCall {
  const envAdaptiveOn = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL") ?? "").trim() !== "0";
  const enabled = opts.enabled !== undefined ? opts.enabled : envAdaptiveOn;
  const envAdaptiveState = (getEnv("OPENCLAW_HYBRID_MEM_ADAPTIVE_DISTILL_STATE") ?? "").trim();
  const adaptiveStatePath = envAdaptiveState || opts.adaptiveStatePath;
  const state = enabled && adaptiveStatePath ? loadAdaptiveModelLimits(adaptiveStatePath) : emptyState();
  const catalogBatchTokenLimit = distillBatchTokenLimit(opts.model);
  const catalogMaxOutputTokens = maintenanceMaxOutputTokens(opts.model);
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
  const maxTokens = Math.max(128, Math.min(opts.maxTokens, catalogMaxOutputTokens));
  const fallbackModels = compatibleFallbacks(opts.content, opts.fallbackModels ?? [], opts.logger, opts.label);
  return { maxTokens, fallbackModels, enabled, adaptiveStatePath, state, effective, inputTokens };
}

async function callMaintenanceDetailed(
  opts: AdaptiveMaintenanceLlmOptions,
  prepared: PreparedMaintenanceCall,
  thinkingMode: MiniMaxThinkingMode | undefined,
  fallbackModels: string[],
): Promise<ChatCompleteWithRetryDetails> {
  return chatCompleteWithRetryDetailed({
    model: opts.model,
    content: opts.content,
    temperature: opts.temperature,
    maxTokens: prepared.maxTokens,
    openai: opts.openai,
    fallbackModels,
    label: opts.label,
    feature: opts.feature,
    responseFormat: opts.responseFormat,
    onRetry: opts.onRetry,
    timeoutMs: resolveMaintenanceChatTimeoutMs(opts.model, thinkingMode),
    ...(thinkingMode != null ? { thinkingMode } : {}),
  });
}

function recordMaintenanceSuccess(
  opts: AdaptiveMaintenanceLlmOptions,
  prepared: PreparedMaintenanceCall,
  detail: ChatCompleteWithRetryDetails,
): void {
  if (!prepared.enabled) return;
  const usedModel = detail.modelUsed;
  const usedCatalogBatch = distillBatchTokenLimit(usedModel);
  const usedCatalogOutput = maintenanceMaxOutputTokens(usedModel);
  recordAdaptiveSuccess({
    state: prepared.state,
    model: usedModel,
    catalogBatchTokenLimit: usedCatalogBatch,
    catalogMaxOutputTokens: usedCatalogOutput,
    usedBatchTokenLimit: Math.min(prepared.effective.batchTokenLimit, usedCatalogBatch),
    usedMaxOutputTokens: Math.min(prepared.maxTokens, usedCatalogOutput),
  });
  if (prepared.adaptiveStatePath) {
    try {
      saveAdaptiveModelLimits(prepared.adaptiveStatePath, prepared.state);
    } catch (saveErr) {
      capturePluginError(saveErr instanceof Error ? saveErr : new Error(String(saveErr)), {
        subsystem: "cli",
        operation: "adaptive-maintenance-llm-save",
      });
    }
  }
}

function recordMaintenanceFailure(
  opts: AdaptiveMaintenanceLlmOptions,
  prepared: PreparedMaintenanceCall,
  error: Error,
): void {
  if (!prepared.enabled) return;
  const kind = classifyAdaptiveFailure(error);
  const failureModel =
    typeof (error as Error & { lastAttemptedModel?: string }).lastAttemptedModel === "string"
      ? (error as Error & { lastAttemptedModel: string }).lastAttemptedModel
      : opts.model;
  const failureCatalogBatch = distillBatchTokenLimit(failureModel);
  const failureCatalogMaxOut = maintenanceMaxOutputTokens(failureModel);
  const failureEffective = getEffectiveModelLimits({
    state: prepared.state,
    model: failureModel,
    catalogBatchTokenLimit: failureCatalogBatch,
    catalogMaxOutputTokens: failureCatalogMaxOut,
    minBatchTokenLimit: Math.max(1024, prepared.inputTokens + 128),
    minMaxOutputTokens: Math.min(128, opts.maxTokens),
  });
  recordAdaptiveFailure({
    state: prepared.state,
    model: failureModel,
    kind,
    catalogBatchTokenLimit: failureCatalogBatch,
    catalogMaxOutputTokens: failureCatalogMaxOut,
    usedBatchTokenLimit: failureEffective.batchTokenLimit,
    usedMaxOutputTokens: Math.min(prepared.maxTokens, failureCatalogMaxOut),
  });
  if (prepared.adaptiveStatePath) {
    try {
      saveAdaptiveModelLimits(prepared.adaptiveStatePath, prepared.state);
    } catch (saveErr) {
      capturePluginError(saveErr instanceof Error ? saveErr : new Error(String(saveErr)), {
        subsystem: "cli",
        operation: "adaptive-maintenance-llm-save",
      });
    }
  }
  opts.logger.info?.(`${opts.label}: recorded adaptive ${kind} failure for ${failureModel}`);
}

export async function chatCompleteWithAdaptiveMaintenanceRetry(
  opts: AdaptiveMaintenanceLlmOptions,
): Promise<ChatCompleteWithRetryDetails> {
  const prepared = prepareMaintenanceCall(opts);
  const thinkingOn = isMiniMaxThinkingEnabled(opts.thinkingMode);

  opts.logger.info?.(
    `${opts.label}: starting with model ${opts.model} (source=${opts.modelSource ?? "configured"}; adaptive=${prepared.enabled ? prepared.effective.source : "disabled"}; inputTokens≈${prepared.inputTokens}; maxTokens=${prepared.maxTokens}; thinking=${opts.thinkingMode ?? "default"}; timeoutMs=${resolveMaintenanceChatTimeoutMs(opts.model, opts.thinkingMode)})`,
  );
  opts.logger.info?.(
    `${opts.label}: fallback chain = [${prepared.fallbackModels.length > 0 ? prepared.fallbackModels.join(", ") : ""}]`,
  );

  try {
    if (thinkingOn) {
      try {
        const detail = await callMaintenanceDetailed(opts, prepared, opts.thinkingMode, []);
        recordMaintenanceSuccess(opts, prepared, detail);
        if (detail.modelUsed !== opts.model) {
          opts.logger.info?.(`${opts.label}: succeeded with fallback model ${detail.modelUsed}`);
        }
        return detail;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (classifyAdaptiveFailure(error) !== "timeout") {
          const detail = await callMaintenanceDetailed(opts, prepared, opts.thinkingMode, prepared.fallbackModels);
          recordMaintenanceSuccess(opts, prepared, detail);
          if (detail.modelUsed !== opts.model) {
            opts.logger.info?.(`${opts.label}: succeeded with fallback model ${detail.modelUsed}`);
          }
          return detail;
        }
        opts.logger.warn?.(
          `${opts.label}: thinking=${opts.thinkingMode} timed out on ${opts.model}, retrying with thinking=disabled`,
        );
        try {
          const detail = await callMaintenanceDetailed(opts, prepared, "disabled", []);
          recordMaintenanceSuccess(opts, prepared, detail);
          opts.logger.info?.(`${opts.label}: succeeded after thinking downgrade (disabled)`);
          return detail;
        } catch (disabledErr) {
          const detail = await callMaintenanceDetailed(opts, prepared, "disabled", prepared.fallbackModels);
          recordMaintenanceSuccess(opts, prepared, detail);
          if (detail.modelUsed !== opts.model) {
            opts.logger.info?.(`${opts.label}: succeeded with fallback model ${detail.modelUsed} after thinking downgrade`);
          }
          return detail;
        }
      }
    }

    const detail = await callMaintenanceDetailed(opts, prepared, opts.thinkingMode, prepared.fallbackModels);
    recordMaintenanceSuccess(opts, prepared, detail);
    if (detail.modelUsed !== opts.model) {
      opts.logger.info?.(`${opts.label}: succeeded with fallback model ${detail.modelUsed}`);
    }
    return detail;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    recordMaintenanceFailure(opts, prepared, error);
    throw error;
  }
}
