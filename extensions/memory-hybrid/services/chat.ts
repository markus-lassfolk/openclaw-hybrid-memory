/**
 * Unified chat completion for distill and other LLM features.
 * Uses a multi-provider OpenAI-compatible proxy; provider-agnostic model fallback (issue #87).
 */

import OpenAI from "openai";
import { capturePluginError } from "./error-reporter.js";

/**
 * Thrown when a model's provider has no API key or base URL configured in llm.providers.
 * chatCompleteWithRetry catches this and skips immediately to the next fallback model.
 */
export class UnconfiguredProviderError extends Error {
  readonly provider: string;
  readonly model: string;
  constructor(provider: string, model: string, detail?: string) {
    const base = `Provider '${provider}' is not configured for model ${model}.`;
    const hint = detail ?? `Set llm.providers.${provider}.apiKey in plugin config.`;
    super(`${base} ${hint}`);
    this.name = "UnconfiguredProviderError";
    this.provider = provider;
    this.model = model;
  }
}

/**
 * Pending user-visible LLM config warnings to inject into the next chat session.
 * Scoped per plugin instance to avoid cross-agent leakage.
 */
export type PendingLLMWarnings = {
  add: (message: string) => void;
  drain: () => string[];
};

/** Create a per-instance pending LLM warning queue. */
export function createPendingLLMWarnings(): PendingLLMWarnings {
  const pending = new Set<string>();
  return {
    add(message: string) {
      pending.add(message);
    },
    drain() {
      if (pending.size === 0) return [];
      const msgs = [...pending];
      pending.clear();
      return msgs;
    },
  };
}

/** True when model name suggests long-context (e.g. Gemini). Used only for token limits. Only "gemini" is matched; "thinking" is not, to avoid false positives with gateway aliases. */
function isLongContextModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("gemini");
}

/** Default timeout for chat completion (prevents indefinite hang if gateway/LLM never responds). */
const DEFAULT_CHAT_TIMEOUT_MS = 45_000;

export async function chatComplete(opts: {
  model: string;
  content: string;
  temperature?: number;
  maxTokens?: number;
  openai: OpenAI;
  /** Timeout in ms; after this the promise rejects. Prevents silent hang when gateway/LLM never responds. Default 45s. */
  timeoutMs?: number;
  /** When aborted (e.g. parent timeout), the request is cancelled and no retry is needed. */
  signal?: AbortSignal;
}): Promise<string> {
  const { model, content, temperature = 0.2, maxTokens, timeoutMs = DEFAULT_CHAT_TIMEOUT_MS, signal } = opts;
  const effectiveMaxTokens = maxTokens ?? distillMaxOutputTokens(model);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      throw new Error("Request was aborted");
    }
    signal.addEventListener("abort", onAbort);
  }

  try {
    const resp = await opts.openai.chat.completions.create(
      {
        model,
        messages: [{ role: "user", content }],
        temperature,
        max_tokens: effectiveMaxTokens,
      },
      { signal: controller.signal },
    );
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
    return resp.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
    const isAbort = err instanceof Error && err.name === "AbortError";
    const error = isAbort
      ? new Error(`Gateway/LLM timeout after ${timeoutMs}ms (model: ${model})`)
      : (err instanceof Error ? err : new Error(String(err)));
    // Skip reporting known transient gateway/LLM errors (aborted, timeout, 5xx) and config errors (missing provider keys) to avoid GlitchTip noise
    const msg = error.message.toLowerCase();
    const isTransient =
      msg.includes("request was aborted") ||
      msg.includes("request timed out") ||
      msg.includes("timed out") ||
      /^\d+\s*internal\s*error$/i.test(msg.trim()) ||
      /^5\d{2}\s/.test(msg.trim());
    const isConfigError = err instanceof UnconfiguredProviderError;
    if (!isTransient && !isConfigError) {
      capturePluginError(error, {
        subsystem: "chat",
        operation: "chatComplete",
        phase: "gateway",
      });
    }
    throw error;
  }
}

export function distillBatchTokenLimit(model: string): number {
  // Use conservative limits that work across all common fallback models
  // o3 has 450k TPM limit, so we use 400k to be safe
  return isLongContextModel(model) ? 400_000 : 80_000;
}

/** Max output tokens for distill/ingest LLM calls. Long-context models (e.g. gateway-routed Gemini) support 65k+; else 8k. */
export function distillMaxOutputTokens(model: string): number {
  return isLongContextModel(model) ? 65_536 : 8000;
}

/**
 * Custom error class that includes retry attempt information.
 */
export class LLMRetryError extends Error {
  constructor(
    message: string,
    public readonly cause: Error,
    public readonly attemptNumber: number,
  ) {
    super(message);
    this.name = "LLMRetryError";
  }
}

/**
 * Retry wrapper for LLM calls with exponential backoff.
 * Retries on failure with increasing delays: 1s, 3s, 9s.
 * On final failure, throws LLMRetryError with attempt number.
 * When signal is provided and aborted, does not retry (fails immediately).
 */
export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; label?: string; signal?: AbortSignal },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Don't retry UnconfiguredProviderError — missing API keys won't be fixed by retrying
      if (lastError instanceof UnconfiguredProviderError) {
        throw lastError;
      }
      if (attempt === maxRetries || opts?.signal?.aborted) {
        const retryError = new LLMRetryError(
          `Failed after ${attempt + 1} attempts: ${lastError.message}`,
          lastError,
          attempt + 1,
        );
        // Skip reporting when the underlying cause is a transient gateway error (aborted, timeout, 5xx)
        const causeMsg = lastError.message.toLowerCase();
        const fullMsg = retryError.message.toLowerCase();
        const isTransient =
          causeMsg.includes("request was aborted") ||
          fullMsg.includes("request was aborted") ||
          causeMsg.includes("request timed out") ||
          fullMsg.includes("request timed out") ||
          causeMsg.includes("timed out") ||
          fullMsg.includes("timed out") ||
          /^\d+\s*internal\s*error$/i.test(causeMsg.trim()) ||
          /^5\d{2}\s/.test(causeMsg.trim()) ||
          /\b405\s+method\s+not\s+allowed/i.test(causeMsg) ||
          /\b405\s+method\s+not\s+allowed/i.test(fullMsg);
        if (!isTransient) {
          capturePluginError(retryError, {
            subsystem: "chat",
            operation: "withLLMRetry",
            retryAttempt: attempt + 1,
          });
        }
        throw retryError;
      }
      const delay = Math.pow(3, attempt) * 1000; // 1s, 3s, 9s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

/**
 * Wrapper for chatComplete with retry and fallback model support.
 * Tries primary model with retries, then falls back to each fallback model in order.
 * All calls go through the gateway (openai client).
 */
export async function chatCompleteWithRetry(opts: {
  model: string;
  content: string;
  temperature?: number;
  maxTokens?: number;
  openai: OpenAI;
  fallbackModels?: string[];
  label?: string;
  /** Timeout per model attempt (passed to chatComplete). Default 45s. */
  timeoutMs?: number;
  /** When aborted (e.g. parent step timeout), the request is cancelled and no fallback models are tried. */
  signal?: AbortSignal;
  /** Optional per-instance warning queue for missing provider keys. */
  pendingWarnings?: PendingLLMWarnings;
}): Promise<string> {
  const { fallbackModels = [], label: rawLabel, maxTokens, timeoutMs, signal, pendingWarnings, ...chatOpts } = opts;
  const label = rawLabel ?? "LLM call";
  const modelsToTry = [opts.model, ...fallbackModels];

  let lastError: Error | undefined;
  let unconfiguredCount = 0;

  for (let i = 0; i < modelsToTry.length; i++) {
    if (signal?.aborted) break;
    const currentModel = modelsToTry[i];
    const isFallback = i > 0;
    const attemptLabel = isFallback ? `${label} (fallback: ${currentModel})` : label;
    // Use per-model max_tokens so fallbacks (e.g. gpt-4o) don't receive primary model's limit (e.g. 65k for Gemini)
    const effectiveMaxTokens = maxTokens ?? distillMaxOutputTokens(currentModel);

    try {
      return await withLLMRetry(
        () =>
          chatComplete({
            ...chatOpts,
            model: currentModel,
            maxTokens: effectiveMaxTokens,
            ...(timeoutMs != null && { timeoutMs }),
            signal,
          }),
        { maxRetries: 3, label: attemptLabel, signal },
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Check both direct UnconfiguredProviderError and wrapped in LLMRetryError
      const isUnconfigured = lastError instanceof UnconfiguredProviderError ||
        (lastError instanceof LLMRetryError && lastError.cause instanceof UnconfiguredProviderError);
      if (isUnconfigured) unconfiguredCount++;
      if (i < modelsToTry.length - 1 && !signal?.aborted && !isUnconfigured) {
        console.warn(
          `${label}: model ${currentModel} failed after retries, trying fallback model ${modelsToTry[i + 1]}...`,
        );
      }
    }
  }

  const finalError = lastError ?? new Error("All models failed");

  // When every model failed because provider keys are missing, queue a user-visible chat warning
  // and skip Sentry (this is a config issue, not a bug).
  if (unconfiguredCount > 0 && unconfiguredCount === modelsToTry.length) {
    const unconfiguredProviders = [...new Set(
      modelsToTry.map(m => m.includes("/") ? m.split("/")[0] : "openai")
    )];
    pendingWarnings?.add(
      `⚠️ Memory plugin: No LLM provider keys are configured for ${unconfiguredProviders.join(", ")}. ` +
      `Memory features (HyDE search, classification, distillation) are degraded. ` +
      `Add API keys via: llm.providers.<provider>.apiKey in plugin config, then run: openclaw hybrid-mem verify --test-llm`
    );
  } else {
    // Only report unexpected failures to Sentry — not pure config/key issues
    capturePluginError(finalError, {
      subsystem: "chat",
      operation: "chatCompleteWithRetry",
      phase: "fallback-exhausted",
    });
  }

  throw finalError;
}
