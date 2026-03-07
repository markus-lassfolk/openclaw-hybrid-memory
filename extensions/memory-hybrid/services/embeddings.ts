/**
 * Embedding service: OpenAI and Ollama implementations, provider abstraction and factory.
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { capturePluginError } from "./error-reporter.js";
import { withLLMRetry } from "./chat.js";

/** Full embedding provider interface — implementations must expose these. */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelName: string;
  /** When set, indicates the effective provider in use (e.g. "openai" when FallbackEmbeddingProvider has switched from ollama). */
  readonly activeProvider?: string;
}

/** Config shape accepted by createEmbeddingProvider (matches HybridMemoryConfig.embedding). */
export interface EmbeddingConfig {
  provider: "openai" | "ollama" | "onnx" | "google";
  model: string;
  apiKey?: string;
  models?: string[];
  dimensions: number;
  endpoint?: string;
  batchSize: number;
  /** Ordered list to try (failover). When length > 1, a chain is built. */
  preferredProviders?: ("ollama" | "openai" | "google")[];
  /** Set by parser from distill.apiKey or llm.providers.google.apiKey when preferredProviders includes "google". */
  googleApiKey?: string;
}

/** Google Gemini OpenAI-compatible embeddings base URL (same as chat). */
const GOOGLE_EMBEDDING_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

/** Max cached embeddings (LRU eviction). Reduces redundant API calls for repeated text. */
const EMBEDDING_CACHE_MAX = 500;

/** Hash text for cache key (prevents large text strings as Map keys). */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function makeCacheKey(model: string, text: string): string {
  return `${model}:${hashText(text)}`;
}

/**
 * OpenAI-based embedding provider.
 * Uses a cache, supports model preference lists (try in order on failure).
 */
export class Embeddings implements EmbeddingProvider {
  private client: OpenAI;
  private cache = new Map<string, number[]>();
  /** Ordered list: try first model, on failure try next (all must produce same vector dimension). */
  private readonly models: string[];
  readonly dimensions: number;
  modelName: string;
  private readonly batchSize: number;

  constructor(
    clientOrApiKey: OpenAI | string,
    modelOrModels: string | string[],
    dimensions?: number,
    batchSize?: number,
  ) {
    this.client = typeof clientOrApiKey === "string"
      ? new OpenAI({ apiKey: clientOrApiKey })
      : clientOrApiKey;
    this.models = Array.isArray(modelOrModels) ? modelOrModels : [modelOrModels];
    if (this.models.length === 0) throw new Error("Embeddings requires at least one model");
    this.modelName = this.models[0];
    this.dimensions = dimensions ?? 1536; // default: text-embedding-3-small
    this.batchSize = batchSize || 2048;
    
    // Validate dimensions against known model limits and capabilities
    const modelMaxDimensions: Record<string, number> = {
      "text-embedding-3-small": 1536,
      "text-embedding-3-large": 3072,
    };
    const modelNativeDimensions: Record<string, number> = {
      "text-embedding-3-small": 1536,
      "text-embedding-3-large": 3072,
      "text-embedding-ada-002": 1536,
    };
    for (const model of this.models) {
      const maxDim = modelMaxDimensions[model];
      if (maxDim !== undefined && this.dimensions > maxDim) {
        throw new Error(`Dimensions ${this.dimensions} exceed maximum ${maxDim} for model ${model}`);
      }
      const nativeDim = modelNativeDimensions[model];
      const supportsDimensions = model.startsWith("text-embedding-3-");
      if (nativeDim !== undefined && this.dimensions !== nativeDim && !supportsDimensions) {
        throw new Error(`Model ${model} does not support custom dimensions (native: ${nativeDim}, requested: ${this.dimensions}). Use a text-embedding-3-* model for custom dimensions.`);
      }
    }
  }

  async embed(text: string): Promise<number[]> {
    // Check cache for any model before making API calls.
    // This prevents redundant API calls when the primary model consistently fails
    // and a fallback model's cached result would be immediately available.
    for (const model of this.models) {
      const cacheKey = makeCacheKey(model, text);
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        // LRU refresh: move to end
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        this.modelName = model;
        return cached;
      }
    }

    let lastErr: Error | undefined;
    for (const model of this.models) {
      const cacheKey = makeCacheKey(model, text);
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        this.modelName = model;
        return cached;
      }
      try {
        const supportsDimensions = model.startsWith("text-embedding-3-");
        const resp = await withLLMRetry(
          () => this.client.embeddings.create({
            model,
            input: text,
            ...(supportsDimensions ? { dimensions: this.dimensions } : {}),
          }),
          { maxRetries: 2 },
        );
        const vector = resp.data[0].embedding;
        if (this.cache.size >= EMBEDDING_CACHE_MAX) {
          const firstKey = this.cache.keys().next().value;
          if (firstKey !== undefined) this.cache.delete(firstKey);
        }
        const storeCacheKey = makeCacheKey(model, text);
        this.cache.set(storeCacheKey, vector);
        this.modelName = model;
        return vector;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        continue;
      }
    }
    // lastErr is always defined here: constructor enforces models.length >= 1, so
    // the loop always runs at least once; either it returns early (success) or
    // sets lastErr on every iteration before reaching this point.
    capturePluginError(lastErr!, {
      subsystem: "embeddings",
      operation: "embed",
      phase: "fallback-exhausted",
    });
    throw lastErr!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    
    const allResults: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      
      let lastErr: Error | undefined;
      let resp: Awaited<ReturnType<typeof this.client.embeddings.create>> | undefined;
      for (const model of this.models) {
        try {
          const supportsDimensions = model.startsWith("text-embedding-3-");
          resp = await withLLMRetry(
            () => this.client.embeddings.create({
              model,
              input: batch,
              ...(supportsDimensions ? { dimensions: this.dimensions } : {}),
            }),
            { maxRetries: 2 },
          );
          this.modelName = model;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          continue;
        }
      }
      if (resp !== undefined) {
        if (resp.data.length !== batch.length) {
          throw new Error(`OpenAI embed returned ${resp.data.length} embeddings for ${batch.length} inputs`);
        }
        allResults.push(
          ...resp.data
            .sort((a, b) => a.index - b.index)
            .map((item) => item.embedding),
        );
      }
      if (lastErr !== undefined && allResults.length === i) {
        capturePluginError(lastErr, {
          subsystem: "embeddings",
          operation: "embedBatch",
          phase: "fallback-exhausted",
        });
        throw lastErr;
      }
    }
    return allResults;
  }
}

/**
 * Ollama-based embedding provider.
 * Calls Ollama REST API (POST /api/embed) — no external API key required.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  private readonly endpoint: string;
  private readonly batchSize: number;

  constructor(opts: {
    model: string;
    dimensions: number;
    endpoint?: string;
    batchSize?: number;
  }) {
    this.modelName = opts.model;
    this.dimensions = opts.dimensions;
    this.endpoint = (opts.endpoint ?? "http://localhost:11434").replace(/\/$/, "");
    this.batchSize = opts.batchSize || 50;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    if (results.length === 0) {
      throw new Error(`Ollama embed returned empty results for single text`);
    }
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const allResults: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      let resp: Response;
      try {
        resp = await fetch(`${this.endpoint}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.modelName, input: batch }),
        });
      } catch (err) {
        throw new Error(`Ollama connection failed (${this.endpoint}): ${err}`);
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Ollama embed failed: HTTP ${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
      }
      const data = await resp.json() as { embeddings: number[][] };
      if (!Array.isArray(data.embeddings)) {
        throw new Error(`Ollama embed response missing 'embeddings' array`);
      }
      if (data.embeddings.length === 0) {
        throw new Error(`Ollama embed returned empty 'embeddings' array (expected ${batch.length})`);
      }
      if (data.embeddings.length !== batch.length) {
        throw new Error(`Ollama embed returned ${data.embeddings.length} embeddings for ${batch.length} inputs`);
      }
      allResults.push(...data.embeddings);
    }
    return allResults;
  }
}

/**
 * Wrapper that tries a primary provider and switches permanently to a fallback on first failure.
 * Useful for Ollama → OpenAI fallback when Ollama is temporarily unavailable.
 */
export class FallbackEmbeddingProvider implements EmbeddingProvider {
  private active: EmbeddingProvider;
  private readonly primary: EmbeddingProvider;
  private readonly fallback: EmbeddingProvider | null;
  private switched = false;
  private lastRetryAttempt = 0;
  private readonly retryIntervalMs = 60000;
  private readonly onSwitch?: (err: unknown) => void;
  private readonly primaryLabel: string;
  private readonly fallbackLabel: string;
  readonly dimensions: number;
  modelName: string;
  /** "ollama" when using primary, "openai" when using fallback (so logs reflect actual provider). */
  get activeProvider(): string {
    return this.switched ? this.fallbackLabel : this.primaryLabel;
  }

  constructor(
    primary: EmbeddingProvider,
    fallback: EmbeddingProvider | null,
    onSwitch?: (err: unknown) => void,
    primaryLabel = "ollama",
    fallbackLabel = "openai",
  ) {
    if (fallback && fallback.dimensions !== primary.dimensions) {
      throw new Error(
        `Primary (${primary.modelName}: ${primary.dimensions}d) and fallback ` +
        `(${fallback.modelName}: ${fallback.dimensions}d) must have matching dimensions`,
      );
    }
    this.active = primary;
    this.primary = primary;
    this.fallback = fallback;
    this.onSwitch = onSwitch;
    this.primaryLabel = primaryLabel;
    this.fallbackLabel = fallbackLabel;
    this.dimensions = primary.dimensions;
    this.modelName = primary.modelName;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.fallback) {
      return this.active.embed(text);
    }
    if (this.switched && Date.now() - this.lastRetryAttempt >= this.retryIntervalMs) {
      this.lastRetryAttempt = Date.now();
      try {
        const result = await this.primary.embed(text);
        this.active = this.primary;
        this.switched = false;
        this.modelName = this.active.modelName;
        return result;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "embeddings",
          operation: "fallback-retry-primary",
          phase: "embed",
        });
        // Primary still failing — continue using fallback
      }
    }
    if (this.switched) {
      return this.active.embed(text);
    }
    try {
      return await this.active.embed(text);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "embeddings",
        operation: "fallback-switch",
        phase: "embed",
      });
      this.onSwitch?.(err);
      this.active = this.fallback;
      this.switched = true;
      this.lastRetryAttempt = Date.now();
      this.modelName = this.active.modelName;
      return this.active.embed(text);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.fallback) {
      return this.active.embedBatch(texts);
    }
    if (this.switched && Date.now() - this.lastRetryAttempt >= this.retryIntervalMs) {
      this.lastRetryAttempt = Date.now();
      try {
        const result = await this.primary.embedBatch(texts);
        this.active = this.primary;
        this.switched = false;
        this.modelName = this.active.modelName;
        return result;
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "embeddings",
          operation: "fallback-retry-primary",
          phase: "embedBatch",
        });
        // Primary still failing — continue using fallback
      }
    }
    if (this.switched) {
      return this.active.embedBatch(texts);
    }
    try {
      return await this.active.embedBatch(texts);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "embeddings",
        operation: "fallback-switch",
        phase: "embedBatch",
      });
      this.onSwitch?.(err);
      this.active = this.fallback;
      this.switched = true;
      this.lastRetryAttempt = Date.now();
      this.modelName = this.active.modelName;
      return this.active.embedBatch(texts);
    }
  }
}

/**
 * Tries a list of embedding providers in order; first success wins (no retry of earlier providers).
 * Aligns with LLM failover: same idea as getLLMModelPreference / tier; Ollama can be first tier.
 */
export class ChainEmbeddingProvider implements EmbeddingProvider {
  private readonly providers: EmbeddingProvider[];
  private readonly labels: string[];
  private activeIndex = 0;
  readonly dimensions: number;
  modelName: string;
  get activeProvider(): string {
    return this.labels[this.activeIndex];
  }

  constructor(providers: EmbeddingProvider[], labels: string[]) {
    if (providers.length === 0 || providers.length !== labels.length) {
      throw new Error("ChainEmbeddingProvider requires non-empty providers and same-length labels");
    }
    const dim = providers[0].dimensions;
    if (providers.some((p) => p.dimensions !== dim)) {
      throw new Error("ChainEmbeddingProvider: all providers must have the same dimensions");
    }
    this.providers = providers;
    this.labels = labels;
    this.dimensions = dim;
    this.modelName = providers[0].modelName;
  }

  async embed(text: string): Promise<number[]> {
    while (this.activeIndex < this.providers.length) {
      try {
        return await this.providers[this.activeIndex].embed(text);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "embeddings",
          operation: "chain-failover",
          phase: "embed",
        });
        this.activeIndex++;
        if (this.activeIndex < this.providers.length) {
          this.modelName = this.providers[this.activeIndex].modelName;
        }
      }
    }
    throw new Error("All embedding providers in the chain failed.");
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    while (this.activeIndex < this.providers.length) {
      try {
        return await this.providers[this.activeIndex].embedBatch(texts);
      } catch (err) {
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "embeddings",
          operation: "chain-failover",
          phase: "embedBatch",
        });
        this.activeIndex++;
        if (this.activeIndex < this.providers.length) {
          this.modelName = this.providers[this.activeIndex].modelName;
        }
      }
    }
    throw new Error("All embedding providers in the chain failed.");
  }
}

/**
 * Factory: creates the right EmbeddingProvider from plugin config.
 * - When embedding.preferredProviders has length > 1: chain (try in order; aligns with LLM failover, Ollama-as-tier).
 * - provider='ollama' → OllamaEmbeddingProvider (with optional OpenAI fallback if apiKey set)
 * - provider='openai' → Embeddings (OpenAI)
 * - provider='onnx'   → not yet implemented; falls back to OpenAI when apiKey available
 */
export function createEmbeddingProvider(
  cfg: EmbeddingConfig,
  onFallback?: (err: unknown) => void,
): EmbeddingProvider {
  const { provider, model, apiKey, models, dimensions, endpoint, batchSize, preferredProviders } = cfg;

  if (preferredProviders && preferredProviders.length > 1) {
    const chain: EmbeddingProvider[] = [];
    const labels: string[] = [];
    const openaiModels = models?.length ? models : ["text-embedding-3-small"];
    // All providers in the chain must use the same dimensions (config.dimensions). For ollama+openai, use 1536 and an ollama model that supports it, or 768 with openai dimension override if supported.
    const ollamaModel = model && !["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"].includes(model)
      ? model
      : "nomic-embed-text";
    const googleModel = "text-embedding-004"; // Gemini API embedding model (OpenAI-compat endpoint)
    for (const name of preferredProviders) {
      if (name === "ollama") {
        try {
          chain.push(new OllamaEmbeddingProvider({ model: ollamaModel, dimensions, endpoint, batchSize }));
          labels.push("ollama");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "embeddings", operation: "chain-build-ollama" });
        }
      } else if (name === "openai" && apiKey) {
        try {
          const client = new OpenAI({ apiKey });
          chain.push(new Embeddings(client, model && ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"].includes(model) ? model : openaiModels[0], dimensions, batchSize));
          labels.push("openai");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "embeddings", operation: "chain-build-openai" });
        }
      } else if (name === "google" && cfg.googleApiKey && cfg.googleApiKey.length >= 10) {
        try {
          const client = new OpenAI({ apiKey: cfg.googleApiKey, baseURL: GOOGLE_EMBEDDING_BASE_URL });
          chain.push(new Embeddings(client, googleModel, dimensions, batchSize));
          labels.push("google");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), { subsystem: "embeddings", operation: "chain-build-google" });
        }
      }
    }
    if (chain.length === 0) {
      throw new Error("embedding.preferredProviders: no provider could be built (check apiKey for openai/google, Ollama for ollama, distill.apiKey or llm.providers.google for Google).");
    }
    if (chain.length === 1) {
      return chain[0];
    }
    return new ChainEmbeddingProvider(chain, labels);
  }

  if (provider === "ollama") {
    const primary = new OllamaEmbeddingProvider({ model, dimensions, endpoint, batchSize });
    // Optional fallback to OpenAI when a key is provided
    if (apiKey) {
      const openaiClient = new OpenAI({ apiKey });
      const openaiModels = models?.length ? models : ["text-embedding-3-small"];
      try {
        const fallback = new Embeddings(openaiClient, openaiModels, dimensions, batchSize);
        return new FallbackEmbeddingProvider(primary, fallback, onFallback);
      } catch (err) {
        // Fallback creation failed (e.g. Ollama dimensions exceed all OpenAI model limits).
        // Warn the user so they know their fallback isn't working.
        console.warn(`memory-hybrid: Failed to create OpenAI fallback for Ollama provider: ${err instanceof Error ? err.message : String(err)}. Continuing with Ollama-only (no fallback).`);
        return primary;
      }
    }
    return primary;
  }

  if (provider === "openai") {
    if (!apiKey) throw new Error("OpenAI embedding provider requires embedding.apiKey");
    const openaiClient = new OpenAI({ apiKey });
    const openaiModels = models?.length ? models : [model];
    return new Embeddings(openaiClient, openaiModels, dimensions, batchSize);
  }

  if (provider === "google") {
    if (!cfg.googleApiKey || cfg.googleApiKey.length < 10) {
      throw new Error("Google embedding provider requires distill.apiKey or llm.providers.google.apiKey.");
    }
    const client = new OpenAI({ apiKey: cfg.googleApiKey, baseURL: GOOGLE_EMBEDDING_BASE_URL });
    return new Embeddings(client, "text-embedding-004", dimensions, batchSize);
  }

  if (provider === "onnx") {
    // ONNX runtime is not yet implemented. Never silently fall back to a cloud provider —
    // users who configure provider='onnx' explicitly chose local-first, no-cloud operation.
    throw new Error(
      "ONNX embedding provider is not yet implemented. " +
      "Use provider='ollama' for local embeddings, or provider='openai' for cloud embeddings.",
    );
  }

  throw new Error(`Unknown embedding provider: '${provider as string}'. Valid options: openai, ollama, onnx, google.`);
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
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      operation: 'safe-embed',
      subsystem: 'embeddings',
    });
    if (logWarn) logWarn(`memory-hybrid: embedding failed: ${err}`);
    return null;
  }
}
