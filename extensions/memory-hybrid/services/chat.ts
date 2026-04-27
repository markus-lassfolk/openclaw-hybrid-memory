/**
 * Unified chat completion for distill and other LLM features.
 * Uses a multi-provider OpenAI-compatible proxy; provider-agnostic model fallback (issue #87).
 */

import type { OpenAI } from "openai";
import { DEFAULT_CHAT_TIMEOUT_MS } from "../utils/constants.js";
import { pluginLogger } from "../utils/logger.js";
import { withCostFeature } from "./cost-context.js";
import { capturePluginError } from "./error-reporter.js";
import { is403QuotaOrRateLimitLike, parseGoDurationToMs, parseRetryAfterMs } from "./llm-rate-limit-headers.js";
import {
  type WireApi,
  getDistillBatchTokenLimit as getDistillBatchTokenLimitFromCatalog,
  getDistillMaxOutputTokens as getDistillMaxOutputTokensFromCatalog,
  requiresMaxCompletionTokens,
  shouldOmitSamplingParams,
  resolveWireApi,
} from "./model-capabilities.js";
import { callResponsesApi } from "./responses-adapter.js";

export { is403QuotaOrRateLimitLike, parseGoDurationToMs, parseRetryAfterMs } from "./llm-rate-limit-headers.js";

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

/**
 * Unified 404 detection helper.
 * Checks the HTTP status code property first (reliable), then falls back to
 * targeted message pattern matching. Only matches "model not found" scenarios,
 * NOT generic "file not found" or "module not found" errors.
 *
 * Exported so embeddings.ts can suppress capturePluginError for 404 errors.
 */
export function is404Like(err: unknown): boolean {
  if (err && typeof err === "object") {
    // OpenAI SDK sets .status directly (number); also tolerate string "404" for robustness
    const status = (err as { status?: unknown }).status;
    if (status === 404 || status === "404") return true;
  }
  if (err instanceof Error) {
    // Match HTTP 404 patterns specifically — avoid false positives from
    // "file not found" or "module not found" strings in non-HTTP errors.
    return (
      /\bHTTP\s+404\b|\b404\b.*not\s+found|model.*not\s+found|not\s+found.*model/i.test(err.message) ||
      // Also match bare numeric 404 in error messages (e.g. "404 Not Found" from HTTP responses)
      /^\b404\b/.test(err.message.trim()) ||
      // OpenAI SDK formats: "404 Model not found" or "Error code: 404"
      /\bError\s+code:\s*404\b|\b404\s+[A-Za-z]/.test(err.message) ||
      // Google Generative Language API: "models/<name> is not found for API version <v>"
      // Occurs when a model is unavailable through a specific API version endpoint (e.g. v1beta/openai/).
      /is not found for api version/i.test(err.message)
    );
  }
  return false;
}

/**
 * 403 Forbidden / access-denied detection helper (geo, IP block, etc.).
 * Excludes {@link is403QuotaOrRateLimitLike} quota-style 403s.
 */
export function is403Like(err: unknown): boolean {
  if (err instanceof LLMRetryError) return is403Like(err.cause);
  // Quota / rate-limit style 403 (retry-after, remaining-tokens) is not geo "forbidden".
  if (is403QuotaOrRateLimitLike(err)) return false;
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (status === 403 || status === "403") return true;
  }
  if (err instanceof Error) {
    // Match HTTP 403 patterns: "403 Forbidden", "403 Country, region, or territory not supported", etc.
    if (
      /^\b403\b/.test(err.message.trim()) ||
      /\bHTTP\s+403\b|\bError\s+code:\s*403\b|\b403\s+[A-Za-z]/i.test(err.message)
    ) {
      return true;
    }
    // Match provider-specific geo-restriction / permission-denied phrases that arrive WITHOUT
    // a numeric "403" prefix when errors pass through a proxy or gateway.
    // #490: Google returns "Country, region, or territory not supported" (exact phrase) as
    // the message body when the API key / project is not permitted in the request's region.
    if (/\bcountry,\s*region,\s*or\s*territory\s+not\s+supported\b/i.test(err.message)) return true;
    // gRPC PERMISSION_DENIED status mapped to HTTP 403 — some gateway implementations
    // embed the gRPC status name instead of (or in addition to) the HTTP code.
    if (/\bPERMISSION_DENIED\b/.test(err.message)) return true;
    // Generic "access denied" / "access forbidden" phrases without a numeric status prefix
    // that certain proxy implementations emit when forwarding a 403 response.
    if (/\baccess\s+(denied|forbidden)\b/i.test(err.message) && !/\b(file|directory|path|disk)\b/i.test(err.message))
      return true;
  }
  return false;
}

/**
 * 401 Unauthorized / invalid api key detection helper.
 * A 401 is a permanent operator config issue (wrong API key) that will never be resolved by retrying.
 * Exported so other modules can treat 401 as a config error and suppress capturePluginError.
 */
function is401Like(err: unknown): boolean {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (status === 401 || status === "401") return true;
  }
  if (err instanceof Error) {
    if (/\b401\b|unauthorized/i.test(err.message)) return true;
    // Also match specific auth failure phrases for robustness — catches errors from providers
    // that don't include "401" or "unauthorized" in the message and don't set a .status property.
    if (/incorrect api key|invalid api key|authentication failed/i.test(err.message)) return true;
  }
  return false;
}

/** Returns true when the error is a 401 (auth failure) — either directly or wrapped in LLMRetryError. */
export function is401OrWrapped(err: Error): boolean {
  if (is401Like(err)) return true;
  if (err instanceof LLMRetryError && is401Like(err.cause)) return true;
  return false;
}

/**
 * 429 Too Many Requests / rate-limit detection helper.
 * Checks the HTTP status code property first (reliable), then falls back to
 * message pattern matching. Rate limits are transient — suppress GlitchTip reporting.
 * Exported so embeddings.ts can suppress capturePluginError for 429 errors.
 */
function is429Like(err: unknown): boolean {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (status === 429 || status === "429") return true;
  }
  if (err instanceof Error) {
    return (
      /^\b429\b/.test(err.message.trim()) ||
      /\bHTTP\s+429\b|\bError\s+code:\s*429\b|\b429\s+[A-Za-z]/i.test(err.message) ||
      /\btoo\s+many\s+requests\b/i.test(err.message)
    );
  }
  return false;
}

/**
 * Returns true when the error is a 429 (rate limit) — either directly or wrapped in LLMRetryError.
 * Used in chatCompleteWithRetry to detect 429 errors that were retried and wrapped by withLLMRetry.
 * Exported so embeddings.ts can suppress capturePluginError for 429 errors.
 */
export function is429OrWrapped(err: Error): boolean {
  if (is429Like(err)) return true;
  if (err instanceof LLMRetryError && is429Like(err.cause)) return true;
  return false;
}

/**
 * Unified 5xx / internal server error detection helper.
 * Checks HTTP status code property first, then uses conservative message patterns.
 * Avoids false positives from non-HTTP "internal error" messages (e.g. JavaScript errors).
 *
 * Exported so other modules (lifecycle/hooks, auto-classifier) can suppress
 * capturePluginError for transient server errors.
 */
export function is500Like(err: unknown): boolean {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && status >= 500 && status < 600) return true;
  }
  if (err instanceof Error) {
    const m = err.message;
    // Only match HTTP 5xx patterns — not generic "internal error" from JS
    if (
      /\bHTTP\s+5\d{2}\b|\b5\d{2}\s+(internal\s+)?(error|status)|status\s+5\d{2}|internal\s+server\s+error/i.test(m)
    ) {
      return true;
    }
    // Gateway/proxy phrasing seen in production (#1010, #1013): "502 error code: 502"
    // Single pattern: any "error code: 5xx" also covers "5xx error code: 5xx".
    if (/\berror\s+code:\s*5\d{2}\b/i.test(m)) return true;
  }
  return false;
}

/** Returns true when the error is a 5xx server error — either directly or wrapped in LLMRetryError. */
export function is500OrWrapped(err: Error): boolean {
  if (is500Like(err)) return true;
  if (err instanceof LLMRetryError && is500Like(err.cause)) return true;
  return false;
}

/**
 * Detect transient SDK/network connection failures.
 *
 * OpenAI-compatible SDKs may surface connectivity problems as a bare
 * "Connection error." message (e.g. APIConnectionError) without exposing the
 * underlying socket code on the top-level Error object. These are transient
 * transport failures, not plugin logic bugs, so callers should treat them like
 * timeouts/ECONNREFUSED for retry, fallback, and GlitchTip suppression.
 */
export function isConnectionErrorLike(err: unknown): boolean {
  if (err instanceof LLMRetryError) return isConnectionErrorLike(err.cause);

  const candidates: unknown[] = [err];
  if (err && typeof err === "object" && "cause" in err) {
    candidates.push((err as { cause?: unknown }).cause);
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;

    const code = (candidate as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT/i.test(code)
    ) {
      return true;
    }

    const name = (candidate as { name?: unknown }).name;
    if (typeof name === "string" && /APIConnectionError/i.test(name)) {
      return true;
    }
  }

  if (!(err instanceof Error)) return false;

  return (
    /\bconnection error\b/i.test(err.message) ||
    /\bnetwork error\b/i.test(err.message) ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|connect\s+ETIMEDOUT|socket hang up|fetch failed/i.test(
      err.message,
    )
  );
}

/**
 * Detect 400 errors caused by exceeding the model's context length.
 * These are unrecoverable without truncating the input — retrying is wasteful (#442).
 * Pattern matches OpenAI's error: "400 Invalid 'input': maximum context length is 8192 tokens."
 * Also matches Ollama's error: "Input length 768 exceeds maximum allowed token size 512" (#488).
 */
export function isContextLengthError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number" && status === 400) {
      const msg = ((err as { message?: string }).message ?? "").toLowerCase();
      if (
        msg.includes("context length") ||
        msg.includes("maximum context") ||
        /max.*token.*(length|limit)|token limit|context.length/i.test(msg) ||
        // #488: Ollama "Input length 768 exceeds maximum allowed token size 512"
        /input\s+length\s+\d+\s+exceeds/i.test(msg)
      ) {
        return true;
      }
    }
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      ((msg.includes("400") || msg.includes("bad request")) &&
        (msg.includes("context length") ||
          msg.includes("maximum context") ||
          /max.*token.*(length|limit)|token limit|context.length/i.test(err.message))) ||
      /\b400\b.*maximum context length/i.test(err.message) ||
      // #488: Ollama message-only — no "400" prefix or .status property.
      // This pattern intentionally appears three times: some SDKs set .status=400 (first block),
      // others embed "400" in the message (second block), others emit message-only (this block).
      /input\s+length\s+\d+\s+exceeds/i.test(err.message)
    );
  }
  return false;
}

/**
 * Mutates and returns `err` so GlitchTip/async stacks show which model/phase failed (#1010–#1011).
 */
function enrichLlmErrorMessage(err: Error, ctx?: { model?: string; operation?: string }): Error {
  if (!ctx?.model && !ctx?.operation) return err;
  if (/\[llm\s+/i.test(err.message)) return err;
  const parts: string[] = [];
  if (ctx.model) parts.push(`model=${ctx.model}`);
  if (ctx.operation) parts.push(`op=${ctx.operation}`);
  err.message = `${err.message} [llm ${parts.join(", ")}]`;
  return err;
}

/**
 * HTTP 400 that is not a context-length violation — retrying will not help (#1011, #1016).
 */
function isNonRetryableClient400(err: unknown): boolean {
  if (isContextLengthError(err)) return false;
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    if (status === 400 || status === "400") return true;
  }
  if (err instanceof Error) {
    const m = err.message;
    if (/\b400\b.*\b(?:no body|status code)\b/i.test(m)) return true;
  }
  return false;
}

/** Gateway/proxy may return HTTP 400 with an empty body — transient, not a plugin bug (#1157). */
function is400EmptyBodyGatewayError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /\b400\b.*\bno body\b/i.test(err.message);
}

/** Some Azure/Foundry deployments return 400 when chat params are not supported for the model (#1165). */
function is400UnsupportedOperationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /\b400\b.*\bunsupported\b/i.test(err.message);
}

/**
 * Detect malformed Responses API reasoning-output sequencing errors, e.g.:
 * "Item 'rs_...' of type 'reasoning' was provided without its required following item."
 *
 * This is an intermittent provider-side 400 seen with some reasoning deployments (notably some
 * Azure Foundry o3-pro paths). Treat as transient/retryable (limited) instead of permanent bad-request.
 *
 * Unwraps {@link LLMRetryError} and checks `cause` so detection still works when the message is wrapped.
 */
export function isResponsesReasoningSequenceError(err: unknown): boolean {
  const msg = collectErrorMessageChain(err);
  return /\btype\s+['"]?reasoning['"]?\s+was\s+provided\s+without\s+(?:its\s+)?required\s+following\s+item\b/i.test(
    msg,
  );
}

function collectErrorMessageChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  for (let i = 0; i < 8 && cur != null && !seen.has(cur); i++) {
    seen.add(cur);
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
      continue;
    }
    if (
      typeof cur === "object" &&
      cur !== null &&
      "message" in cur &&
      typeof (cur as { message: unknown }).message === "string"
    ) {
      parts.push((cur as { message: string }).message);
      break;
    }
    break;
  }
  return parts.join(" ");
}

/**
 * Detect Ollama out-of-memory (OOM) errors from the model server.
 * Ollama returns HTTP 500 with a body like:
 *   "model requires more system memory (18.2 GiB) than is available (8.0 GiB)"
 * These are expected failures when the configured model is too large for the host —
 * not bugs — so callers should skip capturePluginError and warn the user instead.
 *
 * Exported so other modules (lifecycle/hooks, auto-classifier, embeddings) can
 * detect OOM specifically for user-visible warnings and circuit-breaker decisions.
 */
export function isOllamaOOM(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("model requires more system memory") ||
    msg.includes("not enough memory to load") ||
    // "requires X GiB" pattern covers variant phrasings from different Ollama versions
    /\bmodel\s+requires\s+[\d.]+\s*gib/i.test(err.message) ||
    // Bare OOM signal in error body (e.g. "oom: model 'qwen3:8b' ...")
    /\boom:/i.test(err.message)
  );
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
  /** Force a specific wire API surface ("chat" or "responses"). When unset, resolved from the model's provider prefix. */
  wireApi?: WireApi;
}): Promise<string> {
  const {
    model,
    content,
    temperature = 0.2,
    maxTokens,
    timeoutMs = DEFAULT_CHAT_TIMEOUT_MS,
    signal,
    feature,
    wireApi: wireApiOverride,
  } = opts;
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
    const wireApi = resolveWireApi(model, wireApiOverride);

    if (wireApi === "responses") {
      const doCreate = () =>
        callResponsesApi(
          opts.openai,
          { model, content, temperature, maxTokens: effectiveMaxTokens },
          { signal: controller.signal },
        );
      const { text } = await (feature ? withCostFeature(feature, doCreate) : doCreate());
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onAbort);
      return text;
    }

    // Standard chat.completions.create path
    const useMaxCompletionTokens = requiresMaxCompletionTokens(model);
    const body: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: [{ role: "user", content }],
      ...(useMaxCompletionTokens ? { max_completion_tokens: effectiveMaxTokens } : { max_tokens: effectiveMaxTokens }),
    };
    if (!shouldOmitSamplingParams(model)) {
      body.temperature = temperature;
    }
    const doCreate = () =>
      opts.openai.chat.completions.create(body as unknown as Parameters<OpenAI["chat"]["completions"]["create"]>[0], {
        signal: controller.signal,
      });
    // If feature is provided, wrap in withCostFeature so the proxy attributes the call correctly.
    // Cost recording itself is done by the OpenAI proxy in setup/init-databases.ts.
    const resp = (await (feature ? withCostFeature(feature, doCreate) : doCreate())) as OpenAI.Chat.ChatCompletion;
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
    const msg = resp.choices?.[0]?.message;
    const msgContent = msg?.content?.trim();
    if (msgContent) return msgContent;
    // Qwen3 thinking mode (Ollama OpenAI-compat endpoint) puts the response in
    // message.reasoning_content (current standard, May 2025+) or message.reasoning (legacy).
    // Fall back to these fields when enable_thinking=true so agents don't see an empty reply (#314).
    const msgRecord = msg as unknown as Record<string, unknown> | undefined;
    const reasoningContent = msgRecord?.reasoning_content;
    if (typeof reasoningContent === "string" && reasoningContent.trim()) return reasoningContent.trim();
    const reasoning = msgRecord?.reasoning;
    if (typeof reasoning === "string" && reasoning.trim()) return reasoning.trim();
    return msgContent ?? "";
  } catch (err) {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
    const isAbort = err instanceof Error && err.name === "AbortError";
    const error = isAbort
      ? new Error(`LLM request timeout after ${timeoutMs}ms (model: ${model})`)
      : err instanceof Error
        ? enrichLlmErrorMessage(err, { model, operation: "chatComplete" })
        : new Error(String(err));
    // Skip reporting known transient gateway/LLM errors (aborted, timeout, 5xx, OOM, 429) and config errors (missing provider keys) to avoid GlitchTip noise
    const msg = error.message.toLowerCase();
    const isTransient =
      msg.includes("request was aborted") ||
      msg.includes("operation was aborted") ||
      msg.includes("request timed out") ||
      msg.includes("timed out") ||
      msg.includes("llm request timeout") || // #339: our own timeout message uses "timeout" not "timed out"
      msg.includes("econnrefused") ||
      isConnectionErrorLike(err) || // #703: OpenAI SDK APIConnectionError / "Connection error." is transient
      is429Like(err) || // #397: rate limit is transient
      is403QuotaOrRateLimitLike(err) || // Azure/APIM quota as 403 + headers
      /^\d+\s*internal\s*error$/i.test(msg.trim()) ||
      /^5\d{2}\s/.test(msg.trim()) ||
      is500Like(err) || // #302: OpenAI SDK InternalServerError has no numeric prefix
      isOllamaOOM(err) || // #387: Ollama OOM — model too large for available RAM, not a bug
      isResponsesReasoningSequenceError(err) || // #1034: malformed reasoning item sequence — retryable
      is400EmptyBodyGatewayError(error) ||
      is400EmptyBodyGatewayError(err) || // #1157: 400 (no body) from gateway — do not GlitchTip
      is400UnsupportedOperationError(error) ||
      is400UnsupportedOperationError(err); // #1165: model/endpoint mismatch
    const isConfigError =
      err instanceof UnconfiguredProviderError ||
      is404Like(err) || // #303: model not found = wrong model name in config, not a bug
      is403Like(err) || // #394: country/region restriction = operator config issue, not a bug
      is401Like(err) || // #475: invalid API key = operator config issue, not a bug
      isContextLengthError(err); // #488: input too long for model context window = wrong model choice, not a bug
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

/** Max input tokens for one distill batch request. From model-capabilities catalog (docs/MODEL-REFERENCE.md). */
export function distillBatchTokenLimit(model: string): number {
  return getDistillBatchTokenLimitFromCatalog(model);
}

/** Max output tokens for distill/ingest LLM calls. From model-capabilities catalog (docs/MODEL-REFERENCE.md). */
export function distillMaxOutputTokens(model: string): number {
  return getDistillMaxOutputTokensFromCatalog(model);
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
 * True when an LLM call failed for abort, gateway loss, or transport — not plugin logic.
 * Used by session narrative and similar paths to avoid noisy warns when the gateway stops.
 */
export function isAbortOrTransientLlmError(err: unknown): boolean {
  if (err instanceof LLMRetryError) {
    return isAbortOrTransientLlmError(err.cause);
  }
  if (err && typeof err === "object" && "cause" in err) {
    const c = (err as { cause?: unknown }).cause;
    if (c !== undefined && c !== null && isAbortOrTransientLlmError(c)) return true;
  }
  if (!(err instanceof Error)) {
    return isConnectionErrorLike(err);
  }
  if (err.name === "AbortError") return true;
  const msg = err.message;
  if (/request was aborted|Request was aborted|The operation was aborted|operation was aborted/i.test(msg)) return true;
  if (/gateway client stopped|gateway not reachable|not reachable\.|is it running/i.test(msg)) return true;
  return isConnectionErrorLike(err);
}

/**
 * Retry wrapper for LLM calls with exponential backoff.
 * Retries on failure with increasing delays: 1s, 3s, 9s.
 * On final failure, throws LLMRetryError with attempt number.
 * When signal is provided and aborted, does not retry (fails immediately).
 */
export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    maxRetries?: number;
    signal?: AbortSignal;
    /** Tags errors for triage when they surface at async boundaries (#1010, #1011). */
    llmContext?: { model?: string; operation?: string };
  },
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
      if (is401Like(lastError)) {
        throw lastError;
      }
      // Don't retry 403 — access forbidden (country/region restriction, IP block, billing) won't be fixed by retrying (#394)
      if (is403Like(lastError)) {
        throw lastError;
      }
      // Don't retry 404 — model doesn't exist, let chatCompleteWithRetry try next model
      if (is404Like(lastError)) {
        const modelHint = lastError.message.match(/model[:\s]+(\S+)/i)?.[1];
        pluginLogger.warn(
          `memory-hybrid: Model not found (404)${modelHint ? ` for ${modelHint}` : ""} — check model name or provider availability`,
        );
        throw lastError;
      }
      // Don't retry 400 context-length errors — input was too long; retrying won't fix it (#442)
      if (isContextLengthError(lastError)) {
        pluginLogger.warn(
          "memory-hybrid: Input exceeds model context length — retrying will not help; truncate input before calling",
        );
        throw enrichLlmErrorMessage(lastError, opts?.llmContext);
      }
      const isReasoningSequenceError = isResponsesReasoningSequenceError(lastError);
      // Azure/OpenAI Responses API intermittent malformed reasoning item sequence:
      // allow one retry, then fail fast so fallback model can run.
      if (isReasoningSequenceError && attempt >= 1) {
        throw enrichLlmErrorMessage(lastError, opts?.llmContext);
      }
      // Other 400s (e.g. empty body from gateway) — not fixed by retry (#1011, #1016)
      if (!isReasoningSequenceError && isNonRetryableClient400(lastError)) {
        throw enrichLlmErrorMessage(lastError, opts?.llmContext);
      }
      const is429 = is429Like(lastError);
      const isQuota403 = is403QuotaOrRateLimitLike(lastError);
      // Timeouts: only retry once (attempt 0 → attempt 1), then throw so chatCompleteWithRetry can try next model.
      // (attempt is 0-based: attempt >= 1 means we've already retried once.)
      const isTimeout = /timed out|llm request timeout|request was aborted|Request was aborted/i.test(
        lastError.message,
      ); // #339: include our own "LLM request timeout" pattern
      const isConnectionError = isConnectionErrorLike(lastError);
      if ((isTimeout || isConnectionError) && attempt >= 1) {
        throw lastError;
      }
      // Ollama OOM: never retry — model requires more memory than available, won't be fixed by retrying.
      // chatCompleteWithRetry will try the next fallback model (e.g. Gemini, OpenAI).
      if (isOllamaOOM(lastError)) {
        pluginLogger.warn(
          "memory-hybrid: Ollama model OOM — model requires more memory than is available. Skipping retries; will try next fallback model.",
        );
        throw lastError;
      }
      // 5xx / internal server error: only retry once
      const isServerError = is500Like(lastError);
      if (isServerError && attempt >= 1) {
        throw lastError;
      }
      if (attempt === maxRetries || opts?.signal?.aborted) {
        // Capture causeMsg before enrichment to preserve end-anchored regex matching
        const causeMsg = lastError.message.toLowerCase();
        enrichLlmErrorMessage(lastError, opts?.llmContext);
        const retryError = new LLMRetryError(
          `Failed after ${attempt + 1} attempts: ${lastError.message}`,
          lastError,
          attempt + 1,
        );
        // Skip reporting when the underlying cause is a transient gateway error (aborted, timeout, 5xx, 429).
        // Note: 404 and 403 errors should never reach this branch (they exit early above),
        // but we include them as defensive safety nets in case they slip past due to future refactors.
        const fullMsg = retryError.message.toLowerCase();
        const isTransient =
          is429 ||
          is403QuotaOrRateLimitLike(lastError) ||
          isServerError || // #302: 5xx server errors are transient
          is404Like(lastError) || // #329: defensive safety net — 404 = model not found, config issue, not a bug
          is403Like(lastError) || // #394: defensive safety net — 403 = country/region restriction, config issue, not a bug
          is401Like(lastError) || // #475: defensive safety net — 401 = invalid API key, config issue, not a bug
          causeMsg.includes("request was aborted") ||
          fullMsg.includes("request was aborted") ||
          causeMsg.includes("request timed out") ||
          fullMsg.includes("request timed out") ||
          causeMsg.includes("timed out") ||
          fullMsg.includes("timed out") ||
          causeMsg.includes("llm request timeout") || // #339: our own timeout message uses "timeout" not "timed out"
          fullMsg.includes("llm request timeout") ||
          isConnectionErrorLike(lastError) ||
          /^\d+\s*internal\s*error$/i.test(causeMsg.trim()) ||
          /^5\d{2}\s/.test(causeMsg.trim()) ||
          /\b405\s+method\s+not\s+allowed/i.test(causeMsg) ||
          /\b405\s+method\s+not\s+allowed/i.test(fullMsg) ||
          isResponsesReasoningSequenceError(lastError) || // #1034
          is400EmptyBodyGatewayError(lastError) || // #1157
          is400UnsupportedOperationError(lastError); // #1165
        if (!isTransient) {
          capturePluginError(retryError, {
            subsystem: "chat",
            operation: "withLLMRetry",
            retryAttempt: attempt + 1,
            ...(opts?.llmContext?.model ? { configShape: { model: opts.llmContext.model } } : {}),
          });
        }
        throw retryError;
      }

      // 429 / quota-style 403: respect Retry-After header if present; otherwise use exponential backoff (2s → 4s → 8s)
      let delay: number;
      if (is429 || isQuota403) {
        const retryAfterMs = parseRetryAfterMs(err);
        delay = retryAfterMs ?? 2 ** (attempt + 1) * 1000;
        pluginLogger.warn(
          `memory-hybrid: ${isQuota403 ? "Quota/rate limit (403)" : "Rate limited by provider"} — backing off ${delay}ms`,
        );
      } else {
        delay = 3 ** attempt * 1000; // 1s, 3s, 9s
      }
      // Abort-aware backoff sleep: if the signal fires while we are waiting, reject immediately
      // instead of sleeping through the full delay. The listener is removed on normal resolve to
      // prevent leaks; the { once: true } option is not relied on alone for cleanup.
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timeout);
          const reason = opts?.signal?.reason;
          const msg = reason instanceof Error ? reason.message : reason != null ? String(reason) : "Aborted";
          const abortError = new Error(msg);
          abortError.name = "AbortError";
          reject(abortError);
        };
        const timeout = setTimeout(() => {
          opts?.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        if (opts?.signal) {
          if (opts.signal.aborted) {
            onAbort();
          } else {
            opts.signal.addEventListener("abort", onAbort, { once: true });
          }
        }
      });
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
  const {
    fallbackModels = [],
    label: rawLabel,
    maxTokens,
    timeoutMs,
    signal,
    pendingWarnings,
    feature,
    ...chatOpts
  } = opts;
  const label = rawLabel ?? "LLM call";
  const modelsToTry = [opts.model, ...fallbackModels];

  let lastError: Error | undefined;
  let unconfiguredCount = 0;

  for (let i = 0; i < modelsToTry.length; i++) {
    if (signal?.aborted) {
      const reason = (signal as AbortSignal).reason;
      const msg = reason instanceof Error ? reason.message : reason != null ? String(reason) : "Aborted";
      const abortError = new Error(msg);
      abortError.name = "AbortError";
      throw abortError;
    }
    const currentModel = modelsToTry[i];
    const _isFallback = i > 0;
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
        {
          maxRetries: 3,
          signal,
          llmContext: { model: currentModel, operation: label },
        },
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Check both direct UnconfiguredProviderError and wrapped in LLMRetryError
      const isUnconfigured =
        lastError instanceof UnconfiguredProviderError ||
        (lastError instanceof LLMRetryError && lastError.cause instanceof UnconfiguredProviderError);
      const is429 = is429OrWrapped(lastError);
      const isTimeout = /timed out|llm request timeout|request was aborted|Request was aborted/i.test(
        lastError.message,
      ); // #339: include our own "LLM request timeout" pattern
      const isConnectionError = isConnectionErrorLike(lastError);
      const is404 = is404Like(lastError);
      const is403 = is403Like(lastError);
      const isQuota403 = is403QuotaOrRateLimitLike(lastError);
      const is401 = is401Like(lastError);
      const is500 = is500Like(lastError); // #302
      const isContextLength = isContextLengthError(lastError); // #488
      const isReasoningSequence = isResponsesReasoningSequenceError(lastError); // #1034
      if (isUnconfigured) unconfiguredCount++;
      if (i < modelsToTry.length - 1 && !signal?.aborted) {
        if (!isUnconfigured) {
          const reason = is429
            ? "rate limited (429)"
            : isTimeout
              ? "timed out"
              : isConnectionError
                ? "connection failed"
                : is404
                  ? "model not found (404)"
                  : isQuota403
                    ? "quota / rate limit (403)"
                    : is403
                      ? "access denied (403)"
                      : is401
                        ? "unauthorized (401)"
                        : is500
                          ? "server error (500)" // #302
                          : isContextLength
                            ? "input too long" // #488
                            : isReasoningSequence
                              ? "responses reasoning sequence error (400)"
                              : "failed after retries";
          pluginLogger.warn(
            `${label}: model ${currentModel} ${reason}, trying fallback model ${modelsToTry[i + 1]}...`,
          );
        }
      }
    }
  }

  const finalError = lastError ?? new Error("All models failed");
  const finalIs500 = is500Like(finalError);
  const finalIs404 = is404Like(finalError);
  const finalIs403 = is403Like(finalError); // #394: country/region restriction = operator config issue
  const finalIsQuota403 = is403QuotaOrRateLimitLike(finalError);
  const finalIs401 = is401OrWrapped(finalError); // #475: invalid API key = operator config issue
  const finalIsOOM = isOllamaOOM(finalError); // #387: OOM is expected when model too large for RAM
  const finalIs429 = is429OrWrapped(finalError); // #397
  const finalIsContextLength = isContextLengthError(finalError); // #488: input too long for model context window
  const finalIsReasoningSequence = isResponsesReasoningSequenceError(finalError); // #1034
  /** Unwraps LLMRetryError so "Request was aborted" in the cause is detected (#935, #936). */
  const finalIsTransientLlm = isAbortOrTransientLlmError(finalError);

  // When every model failed because provider keys are missing, queue a user-visible chat warning
  // and skip Sentry (this is a config issue, not a bug).
  if (unconfiguredCount > 0 && unconfiguredCount === modelsToTry.length) {
    const unconfiguredProviders = [...new Set(modelsToTry.map((m) => (m.includes("/") ? m.split("/")[0] : "openai")))];
    pendingWarnings?.add(
      `⚠️ Memory plugin: No LLM provider keys are configured for ${unconfiguredProviders.join(", ")}. Memory features (HyDE search, classification, distillation) are degraded. Add API keys via: llm.providers.<provider>.apiKey in plugin config, then run: openclaw hybrid-mem verify --test-llm`,
    );
  } else if (unconfiguredCount > 0) {
    // Some models were unconfigured — warn user even if final error was 500/404
    pendingWarnings?.add(
      "⚠️ Memory plugin: Some LLM provider keys are missing. " +
        "Add API keys via: llm.providers.<provider>.apiKey in plugin config, then run: openclaw hybrid-mem verify --test-llm",
    );
    // Don't report UnconfiguredProviderError to GlitchTip — it's a config issue, not a code bug.
    // This can happen when the final model in the fallback chain is also unconfigured but an
    // earlier model failed for a different reason (e.g. rate limit), so unconfiguredCount < total.
    const finalIsUnconfigured =
      finalError instanceof UnconfiguredProviderError ||
      (finalError instanceof LLMRetryError && finalError.cause instanceof UnconfiguredProviderError);
    if (
      !finalIs500 &&
      !finalIsOOM &&
      !finalIsContextLength && // #488: context window exceeded = config issue, not a bug
      !finalIsUnconfigured &&
      !finalIsTransientLlm &&
      !finalIs403 &&
      !finalIsQuota403 &&
      !finalIs401 &&
      !finalIs429 &&
      !finalIsReasoningSequence
    ) {
      capturePluginError(finalError, {
        subsystem: "chat",
        operation: "chatCompleteWithRetry",
        phase: "fallback-exhausted",
      });
    }
  } else if (finalIsOOM) {
    // #387: OOM is a persistent condition (model too large for RAM), not transient — warn user to use smaller model
    pendingWarnings?.add(
      "⚠️ Memory plugin: LLM model requires more memory than available (OOM). " +
        "Consider using a smaller model or configuring a cloud fallback. " +
        "Run: openclaw hybrid-mem verify --test-llm",
    );
  } else if (finalIsContextLength) {
    // #488: input too long for model's context window — config issue (model too small), not a code bug
    pendingWarnings?.add(
      "⚠️ Memory plugin: LLM input exceeds model context window. " +
        "Consider using a model with a larger context window or reducing input size. " +
        "Run: openclaw hybrid-mem verify --test-llm",
    );
  } else if (finalIs500) {
    // #302: 500 server errors are transient — don't report to GlitchTip; request will be retried naturally
  } else if (finalIs404) {
    // #303: model not found across all fallbacks = misconfigured model name — surface to user, skip Sentry
    pendingWarnings?.add(
      "⚠️ Memory plugin: LLM model not found (404) for all configured models. " +
        "Check model names in llm.default / llm.heavy / llm.nano config. " +
        "Run: openclaw hybrid-mem verify --test-llm",
    );
  } else if (finalIs403) {
    // #394: country/region restriction / IP block = operator config issue, not a bug — skip GlitchTip
    pendingWarnings?.add(
      "⚠️ Memory plugin: LLM access denied (403) — your API key may be restricted by country/region, " +
        "IP block, or billing. Check provider settings. " +
        "Run: openclaw hybrid-mem verify --test-llm",
    );
  } else if (finalIs401) {
    // #475: invalid API key = operator config issue, not a bug — skip GlitchTip
    pendingWarnings?.add(
      "⚠️ Memory plugin: LLM unauthorized (401) — your API key is invalid or expired. Check provider settings. " +
        "Run: openclaw hybrid-mem verify --test-llm",
    );
  } else if (finalIsTransientLlm) {
    // #339, #703, #935, #936: abort/timeout/connection (including LLMRetryError-wrapped causes) — don't report
  } else if (finalIsQuota403) {
    pendingWarnings?.add(
      "⚠️ Memory plugin: Provider quota or rate limit (403 with Retry-After / remaining-tokens). " +
        "Try again after the indicated window or raise quota.",
    );
  } else if (finalIs429) {
    // #397: rate limit / usage limit — transient provider error, don't report to GlitchTip
    pendingWarnings?.add(
      "⚠️ Memory plugin: LLM provider rate limited (429 Too Many Requests). " +
        "Memory features may be degraded. Try again later or upgrade your provider plan.",
    );
  } else if (finalIsReasoningSequence) {
    // #1034: intermittent Responses API reasoning output sequencing failure — usually transient/provider-side
    pendingWarnings?.add(
      "⚠️ Memory plugin: LLM provider returned malformed reasoning output (400). " +
        "This can be transient on reasoning models; a retry or fallback model is recommended.",
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
