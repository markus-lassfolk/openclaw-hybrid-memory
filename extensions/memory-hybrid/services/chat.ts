/**
 * Unified chat completion for distill and other LLM features.
 * Uses a multi-provider OpenAI-compatible proxy; provider-agnostic model fallback (issue #87).
 */

import OpenAI from "openai";
import { capturePluginError } from "./error-reporter.js";
import { withCostFeature } from "./cost-context.js";


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

/**
 * Unified 404 detection helper.
 * Checks the HTTP status code property first (reliable), then falls back to
 * targeted message pattern matching. Only matches "model not found" scenarios,
 * NOT generic "file not found" or "module not found" errors.
 */
function is404Like(err: unknown): boolean {
  if (err && typeof err === "object") {
    // OpenAI SDK sets .status directly
    const status = (err as { status?: unknown }).status;
    if (status === 404) return true;
  }
  if (err instanceof Error) {
    // Match HTTP 404 patterns specifically — avoid false positives from
    // "file not found" or "module not found" strings in non-HTTP errors.
    return /\bHTTP\s+404\b|\b404\b.*not\s+found|model.*not\s+found|not\s+found.*model/i.test(err.message)
      // Also match bare numeric 404 in error messages (e.g. "404 Not Found" from HTTP responses)
      || /^\b404\b/.test(err.message.trim())
      // OpenAI SDK formats: "404 Model not found" or "Error code: 404"
      || /\bError\s+code:\s*404\b|\b404\s+[A-Za-z]/.test(err.message);
  }
  return false;
}

/**
 * Unified 5xx / internal server error detection helper.
 * Checks HTTP status code property first, then uses conservative message patterns.
 * Avoids false positives from non-HTTP "internal error" messages (e.g. JavaScript errors).
 */
function is500Like(err: unknown): boolean {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && status >= 500 && status < 600) return true;
  }
  if (err instanceof Error) {
    // Only match HTTP 5xx patterns — not generic "internal error" from JS
    return /\bHTTP\s+5\d{2}\b|\b5\d{2}\s+(error|status)|status\s+5\d{2}|internal\s+server\s+error/i.test(err.message);
  }
  return false;
}

/**
 * Try to parse a Retry-After delay (in ms) from an API error.
 * Returns undefined when the header is absent or unparseable.
 */
function parseRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  // OpenAI SDK exposes headers on the error response
  const headers = (err as { response?: { headers?: Record<string, string> }; headers?: Record<string, string> })
    .response?.headers ?? (err as { headers?: Record<string, string> }).headers;
  if (!headers) return undefined;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return undefined;
  // Retry-After can be either a delay-seconds integer or an HTTP-date
  const secs = parseInt(raw, 10);
  if (!isNaN(secs) && secs > 0) return secs * 1000;
  const date = Date.parse(raw);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

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
  /** Feature label for cost tracking. When set, the call is wrapped in withCostFeature() so the proxy records the correct label. */
  feature?: string;
}): Promise<string> {
  const { model, content, temperature = 0.2, maxTokens, timeoutMs = DEFAULT_CHAT_TIMEOUT_MS, signal, feature } = opts;
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
    const doCreate = () => opts.openai.chat.completions.create(
      {
        model,
        messages: [{ role: "user", content }],
        temperature,
        max_tokens: effectiveMaxTokens,
      },
      { signal: controller.signal },
    );
    // If feature is provided, wrap in withCostFeature so the proxy attributes the call correctly.
    // Cost recording itself is done by the OpenAI proxy in setup/init-databases.ts.
    const resp = await (feature ? withCostFeature(feature, doCreate) : doCreate());
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
    const msg = resp.choices[0]?.message;
    const msgContent = msg?.content?.trim();
    if (msgContent) return msgContent;
    // Qwen3 thinking mode (Ollama OpenAI-compat endpoint) puts the response in
    // message.reasoning when enable_thinking=true (the default). Fall back to it
    // so agents don't see an empty reply and time out (#314).
    const reasoning = (msg as unknown as Record<string, unknown> | undefined)?.reasoning;
    if (typeof reasoning === "string" && reasoning.trim()) return reasoning.trim();
    return msgContent ?? "";
  } catch (err) {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
    const isAbort = err instanceof Error && err.name === "AbortError";
    const error = isAbort
      ? new Error(`LLM request timeout after ${timeoutMs}ms (model: ${model})`)
      : (err instanceof Error ? err : new Error(String(err)));
    // Skip reporting known transient gateway/LLM errors (aborted, timeout, 5xx) and config errors (missing provider keys) to avoid GlitchTip noise
    const msg = error.message.toLowerCase();
    const isTransient =
      msg.includes("request was aborted") ||
      msg.includes("request timed out") ||
      msg.includes("timed out") ||
      msg.includes("econnrefused") ||
      /^\d+\s*internal\s*error$/i.test(msg.trim()) ||
      /^5\d{2}\s/.test(msg.trim()) ||
      is500Like(err);  // #302: OpenAI SDK InternalServerError has no numeric prefix
    const isConfigError = err instanceof UnconfiguredProviderError ||
      is404Like(err);  // #303: model not found = wrong model name in config, not a bug
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
  opts?: { maxRetries?: number; signal?: AbortSignal },
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
      // Don't retry 401 — wrong key won't be fixed by retrying
      if (/\b401\b|unauthorized/i.test(lastError.message)) {
        throw lastError;
      }
      // Don't retry 404 — model doesn't exist, let chatCompleteWithRetry try next model
      if (is404Like(lastError)) {
        const modelHint = lastError.message.match(/model[:\s]+(\S+)/i)?.[1];
        console.warn(`memory-hybrid: Model not found (404)${modelHint ? ` for ${modelHint}` : ""} — check model name or provider availability`);
        throw lastError;
      }
      const is429 = /\b429\b|too many requests/i.test(lastError.message);
      // Timeouts: only retry once (attempt 0 → attempt 1), then throw so chatCompleteWithRetry can try next model.
      // (attempt is 0-based: attempt >= 1 means we've already retried once.)
      const isTimeout = /timed out|request was aborted|Request was aborted|ETIMEDOUT|ECONNREFUSED/i.test(lastError.message);
      if (isTimeout && attempt >= 1) {
        throw lastError;
      }
      // 5xx / internal server error: only retry once
      const isServerError = is500Like(lastError);
      if (isServerError && attempt >= 1) {
        throw lastError;
      }
      if (attempt === maxRetries || opts?.signal?.aborted) {
        const retryError = new LLMRetryError(
          `Failed after ${attempt + 1} attempts: ${lastError.message}`,
          lastError,
          attempt + 1,
        );
        // Skip reporting when the underlying cause is a transient gateway error (aborted, timeout, 5xx, 429)
        const causeMsg = lastError.message.toLowerCase();
        const fullMsg = retryError.message.toLowerCase();
        const isTransient =
          is429 ||
          isServerError ||  // #302: 5xx server errors are transient
          causeMsg.includes("request was aborted") ||
          fullMsg.includes("request was aborted") ||
          causeMsg.includes("request timed out") ||
          fullMsg.includes("request timed out") ||
          causeMsg.includes("timed out") ||
          fullMsg.includes("timed out") ||
          /^\d+\s*internal\s*error$/i.test(causeMsg.trim()) ||
          /^5\d{2}\s/.test(causeMsg.trim()) ||
          /\b405\s+method\s+not\s+allowed/i.test(causeMsg) ||
          /\b405\s+method\s+not\s+allowed/i.test(fullMsg) ||
          causeMsg.includes("econnrefused") ||
          fullMsg.includes("econnrefused");
        if (!isTransient) {
          capturePluginError(retryError, {
            subsystem: "chat",
            operation: "withLLMRetry",
            retryAttempt: attempt + 1,
          });
        }
        throw retryError;
      }
      // 429: respect Retry-After header if present; otherwise use exponential backoff (2s → 4s → 8s)
      let delay: number;
      if (is429) {
        const retryAfterMs = parseRetryAfterMs(err);
        delay = retryAfterMs ?? Math.pow(2, attempt + 1) * 1000;
        console.warn(`memory-hybrid: Rate limited by provider — backing off ${delay}ms`);
      } else {
        delay = Math.pow(3, attempt) * 1000; // 1s, 3s, 9s
      }
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
  /** Feature label for cost tracking. Passed to chatComplete which wraps the call in withCostFeature(). */
  feature?: string;
}): Promise<string> {
  const { fallbackModels = [], label: rawLabel, maxTokens, timeoutMs, signal, pendingWarnings, feature, ...chatOpts } = opts;
  const label = rawLabel ?? "LLM call";
  const modelsToTry = [opts.model, ...fallbackModels];

  let lastError: Error | undefined;
  let unconfiguredCount = 0;

  for (let i = 0; i < modelsToTry.length; i++) {
    if (signal?.aborted) {
      const reason = (signal as AbortSignal).reason;
      const abortError =
        reason instanceof Error
          ? reason
          : new Error(reason != null ? String(reason) : "Aborted");
      abortError.name = "AbortError";
      throw abortError;
    }
    const currentModel = modelsToTry[i];
    const isFallback = i > 0;
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
            ...(feature != null && { feature }),
          }),
        { maxRetries: 3, signal },
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Check both direct UnconfiguredProviderError and wrapped in LLMRetryError
      const isUnconfigured = lastError instanceof UnconfiguredProviderError ||
        (lastError instanceof LLMRetryError && lastError.cause instanceof UnconfiguredProviderError);
      const is429 = /\b429\b|too many requests/i.test(lastError.message);
      const isTimeout = /timed out|request was aborted|Request was aborted|ETIMEDOUT|ECONNREFUSED/i.test(lastError.message);
      const is404 = is404Like(lastError);
      const is500 = is500Like(lastError);  // #302
      if (isUnconfigured) unconfiguredCount++;
      if (i < modelsToTry.length - 1 && !signal?.aborted) {
        if (!isUnconfigured) {
          const reason = is429 ? "rate limited (429)"
            : isTimeout ? "timed out"
            : is404 ? "model not found (404)"
            : is500 ? "server error (500)"  // #302
            : "failed after retries";
          console.warn(
            `${label}: model ${currentModel} ${reason}, trying fallback model ${modelsToTry[i + 1]}...`,
          );
        }
      }
    }
  }

  const finalError = lastError ?? new Error("All models failed");
  const finalIs500 = is500Like(finalError);
  const finalIs404 = is404Like(finalError);

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
  } else if (unconfiguredCount > 0) {
    // Some models were unconfigured — warn user even if final error was 500/404
    pendingWarnings?.add(
      `⚠️ Memory plugin: Some LLM provider keys are missing. ` +
      `Add API keys via: llm.providers.<provider>.apiKey in plugin config, then run: openclaw hybrid-mem verify --test-llm`
    );
    if (!finalIs500) {
      capturePluginError(finalError, {
        subsystem: "chat",
        operation: "chatCompleteWithRetry",
        phase: "fallback-exhausted",
      });
    }
  } else if (finalIs500) {
    // #302: 500 server errors are transient — don't report to GlitchTip; request will be retried naturally
  } else if (finalIs404) {
    // #303: model not found across all fallbacks = misconfigured model name — surface to user, skip Sentry
    pendingWarnings?.add(
      `⚠️ Memory plugin: LLM model not found (404) for all configured models. ` +
      `Check model names in llm.default / llm.heavy / llm.nano config. ` +
      `Run: openclaw hybrid-mem verify --test-llm`
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
