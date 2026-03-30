/**
 * Shared constants, utilities, and error helpers used across embedding providers.
 */

import { createHash } from "node:crypto";
import { LLMRetryError, is401OrWrapped, is403Like, is404Like, is429OrWrapped, is500OrWrapped } from "../chat.js";
import { capturePluginError } from "../error-reporter.js";
import type { EmbeddingProvider } from "./types.js";
import { AllEmbeddingProvidersFailed } from "./types.js";

/** Google Gemini OpenAI-compatible embeddings base URL (same as chat). */
export const GOOGLE_EMBEDDING_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

/**
 * Known Google Gemini embedding models at the OpenAI-compatible endpoint
 * (generativelanguage.googleapis.com/v1beta/openai/). Retired model names are
 * not listed here — unknown names fall back to GOOGLE_EMBED_DEFAULT_MODEL (#886).
 */
export const KNOWN_GOOGLE_EMBED_MODELS = new Set(["gemini-embedding-001", "gemini-embedding-2-preview"]);

/** Default Google embedding model at the OpenAI-compatible endpoint. */
export const GOOGLE_EMBED_DEFAULT_MODEL = "gemini-embedding-001";

/** Default output dimensions when mapping OpenAI-only model names to Google embeddings (768). */
export const GOOGLE_EMBED_DEFAULT_DIMENSIONS = 768;

/** OpenAI-only embedding model names; for provider=google we substitute GOOGLE_EMBED_DEFAULT_MODEL and these dims. */
export const OPENAI_ONLY_EMBED_MODELS = new Set([
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
]);

/**
 * True when the base URL targets an Azure OpenAI resource (excluding APIM gateways).
 * Azure OpenAI resources use api-key header authentication.
 */
export function isAzureOpenAiResourceEndpoint(endpoint: string | undefined): boolean {
  if (typeof endpoint !== "string" || !endpoint.trim()) return false;
  return /\.openai\.azure\.com(?:\/|$)|\.cognitiveservices\.azure\.com(?:\/|$)|\.services\.ai\.azure\.com(?:\/|$)/i.test(
    endpoint.trim(),
  );
}

/**
 * True when the embedding base URL targets Azure (resource, APIM gateway, Cognitive Services, Foundry),
 * not public api.openai.com.
 */
export function isAzureOpenAiCompatibleEndpoint(endpoint: string | undefined): boolean {
  if (typeof endpoint !== "string" || !endpoint.trim()) return false;
  // Use specific Azure AI/OpenAI domains only — `\.azure\.com` alone is too broad and would
  // match unrelated Azure services (portal.azure.com, devops.azure.com, etc.).
  return /\.openai\.azure\.com(?:\/|$)|\.cognitiveservices\.azure\.com(?:\/|$)|\.services\.ai\.azure\.com(?:\/|$)|\.azure-api\.net(?:\/|$)/i.test(
    endpoint.trim(),
  );
}

/** Display label for logs/CLI: distinguishes Azure-hosted OpenAI-compatible APIs from direct OpenAI. */
export function formatOpenAiEmbeddingDisplayLabel(model: string, endpoint: string | undefined): string {
  return isAzureOpenAiCompatibleEndpoint(endpoint) ? `(Azure)OpenAI/${model}` : `OpenAI/${model}`;
}

/** Max cached embeddings (LRU eviction). Reduces redundant API calls for repeated text. */
export const EMBEDDING_CACHE_MAX = 500;

/**
 * Async semaphore (counting mutex). Issue #840: pair every `acquire()` with `try/finally { release() }`
 * so early returns cannot leak slots and block all subsequent callers.
 */
export class AsyncSemaphore {
  private available: number;
  private readonly capacity: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity = 1) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`AsyncSemaphore: capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.available = capacity;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.();
    } else {
      this.available = Math.min(this.capacity, this.available + 1);
    }
  }
}

/**
 * OpenAI embedding models have a hard limit of 8192 tokens per input.
 * Using ~4 chars/token heuristic (consistent with estimateTokens in utils/text.ts),
 * we clamp inputs to this character ceiling before hitting the API.
 * Overshooting the estimate slightly is harmless; undershooting wastes a round trip.
 */
const OPENAI_EMBEDDING_MAX_TOKENS = 8192;
const OPENAI_EMBEDDING_MAX_CHARS = OPENAI_EMBEDDING_MAX_TOKENS * 4; // ~32 768 chars

/**
 * Truncate text to fit within the OpenAI embedding token limit.
 * Uses the same ~4 chars/token heuristic as estimateTokens() so behaviour is
 * consistent across the codebase without adding a tokenizer dependency here.
 */
export function truncateForEmbedding(text: string): string {
  if (text.length <= OPENAI_EMBEDDING_MAX_CHARS) return text;
  return text.slice(0, OPENAI_EMBEDDING_MAX_CHARS).trimEnd();
}

/** Hash text for cache key (prevents large text strings as Map keys). */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export function makeCacheKey(model: string, text: string): string {
  return `${model}:${hashText(text)}`;
}

/** Returns true when the error is a 404 (model not found) — either directly or wrapped in LLMRetryError. */
function is404OrWrapped(err: Error): boolean {
  if (is404Like(err)) return true;
  if (err instanceof LLMRetryError && is404Like(err.cause)) return true;
  return false;
}

/** Returns true when the error is a 403 (access forbidden — country/region restriction, IP block) —
 * either directly or wrapped in an LLMRetryError.
 * Note: withLLMRetry short-circuits on 403 and rethrows directly, so 403s rarely arrive wrapped,
 * but we handle both forms for robustness.
 */
function is403OrWrapped(err: Error): boolean {
  if (is403Like(err)) return true;
  if (err instanceof LLMRetryError && is403Like(err.cause)) return true;
  return false;
}

/** Returns true when err is a configuration error (404 model-not-found, 403 country/region restriction, or 401 auth failure).
 * Used to suppress capturePluginError for errors that are always operator config issues (#329, #394, #385). */
export function isConfigError(err: Error): boolean {
  return is404OrWrapped(err) || is403OrWrapped(err) || is401OrWrapped(err);
}

/** Returns true when the error is an Ollama circuit breaker open — provider is temporarily disabled,
 * not a real embedding failure. Should be treated as a transient "provider unavailable" condition.
 */
export function isOllamaCircuitBreakerOpen(err: Error): boolean {
  return err.message.startsWith("Ollama circuit breaker open");
}

/** Returns true when the error is a local Ollama connectivity failure.
 * Ollama is an optional local dependency, so connection-refused / fetch-failed errors from the
 * provider should degrade gracefully to a fallback without reporting GlitchTip noise.
 */
function isOllamaConnectionFailure(err: Error): boolean {
  return err.message.startsWith("Ollama connection failed (");
}

/**
 * Returns true when an embedding error should be suppressed from error monitoring.
 * Covers config errors (401/403/404), rate limits (429), circuit-breaker-open, and
 * AllEmbeddingProvidersFailed when every cause is one of those expected conditions.
 * Use this in any catch block that calls embeddings.embed() / embedBatch() to avoid
 * reporting noise when all providers are legitimately unavailable (#486).
 */
export function shouldSuppressEmbeddingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (
    isConfigError(err) ||
    is429OrWrapped(err) ||
    is500OrWrapped(err) ||
    isOllamaCircuitBreakerOpen(err) ||
    isOllamaConnectionFailure(err)
  ) {
    return true;
  }
  if (err instanceof AllEmbeddingProvidersFailed) {
    if (err.causes.length === 0) return false; // unknown state — report
    return err.causes.every(
      (c) =>
        isConfigError(c) ||
        is429OrWrapped(c) ||
        is500OrWrapped(c) ||
        isOllamaCircuitBreakerOpen(c) ||
        isOllamaConnectionFailure(c),
    );
  }
  return false;
}

/** Centralized embedding with error handling. Returns null on failure and optionally logs. */
export async function safeEmbed(
  provider: EmbeddingProvider,
  text: string,
  logWarn?: (msg: string) => void,
): Promise<number[] | null> {
  try {
    return await provider.embed(text);
  } catch (err) {
    const asErr = err instanceof Error ? err : new Error(String(err));
    // Suppress config errors, 429, circuit-breaker-open, and AllEmbeddingProvidersFailed whose every
    // cause is one of those expected conditions (#394, #329, #385, #397, #458, #486)
    if (!shouldSuppressEmbeddingError(err)) {
      capturePluginError(asErr, {
        operation: "safe-embed",
        subsystem: "embeddings",
      });
    }
    if (logWarn) logWarn(`memory-hybrid: embedding failed: ${err}`);
    return null;
  }
}
