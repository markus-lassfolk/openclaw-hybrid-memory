/**
 * Embedding service: OpenAI and Ollama implementations, provider abstraction and factory.
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { capturePluginError } from "./error-reporter.js";

/** Full embedding provider interface — implementations must expose these. */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelName: string;
}

/** Config shape accepted by createEmbeddingProvider (matches HybridMemoryConfig.embedding). */
export interface EmbeddingConfig {
  provider: "openai" | "ollama" | "onnx";
  model: string;
  apiKey?: string;
  models?: string[];
  dimensions: number;
  endpoint?: string;
  batchSize: number;
}

/** Max cached embeddings (LRU eviction). Reduces redundant API calls for repeated text. */
const EMBEDDING_CACHE_MAX = 500;

/** Hash text for cache key (prevents large text strings as Map keys). */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
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
    this.batchSize = batchSize ?? 2048;
    
    // Validate dimensions against known model limits
    const modelMaxDimensions: Record<string, number> = {
      "text-embedding-3-small": 1536,
      "text-embedding-3-large": 3072,
    };
    for (const model of this.models) {
      const maxDim = modelMaxDimensions[model];
      if (maxDim !== undefined && this.dimensions > maxDim) {
        throw new Error(`Dimensions ${this.dimensions} exceed maximum ${maxDim} for model ${model}`);
      }
    }
  }

  async embed(text: string): Promise<number[]> {
    const cacheKey = hashText(text);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached;
    }

    const { withLLMRetry } = await import("./chat.js");
    let lastErr: Error | undefined;
    for (const model of this.models) {
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
        this.cache.set(cacheKey, vector);
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
      
      const { withLLMRetry } = await import("./chat.js");
      let lastErr: Error | undefined;
      for (const model of this.models) {
        try {
          const supportsDimensions = model.startsWith("text-embedding-3-");
          const resp = await withLLMRetry(
            () => this.client.embeddings.create({
              model,
              input: batch,
              ...(supportsDimensions ? { dimensions: this.dimensions } : {}),
            }),
            { maxRetries: 2 },
          );
          this.modelName = model;
          allResults.push(...resp.data.map((item) => item.embedding));
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          continue;
        }
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
    this.batchSize = opts.batchSize ?? 50;
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
  private readonly fallback: EmbeddingProvider | null;
  private switched = false;
  private readonly onSwitch?: (err: unknown) => void;
  readonly dimensions: number;
  readonly modelName: string;

  constructor(
    primary: EmbeddingProvider,
    fallback: EmbeddingProvider | null,
    onSwitch?: (err: unknown) => void,
  ) {
    this.active = primary;
    this.fallback = fallback;
    this.onSwitch = onSwitch;
    this.dimensions = primary.dimensions;
    this.modelName = primary.modelName;
  }

  async embed(text: string): Promise<number[]> {
    if (this.switched || !this.fallback) {
      return this.active.embed(text);
    }
    try {
      return await this.active.embed(text);
    } catch (err) {
      this.onSwitch?.(err);
      this.active = this.fallback;
      this.switched = true;
      return this.active.embed(text);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.switched || !this.fallback) {
      return this.active.embedBatch(texts);
    }
    try {
      return await this.active.embedBatch(texts);
    } catch (err) {
      this.onSwitch?.(err);
      this.active = this.fallback;
      this.switched = true;
      return this.active.embedBatch(texts);
    }
  }
}

/**
 * Factory: creates the right EmbeddingProvider from plugin config.
 * - provider='ollama' → OllamaEmbeddingProvider (with optional OpenAI fallback if apiKey set)
 * - provider='openai' → Embeddings (OpenAI)
 * - provider='onnx'   → not yet implemented; falls back to OpenAI when apiKey available
 */
export function createEmbeddingProvider(
  cfg: EmbeddingConfig,
  onFallback?: (err: unknown) => void,
): EmbeddingProvider {
  const { provider, model, apiKey, models, dimensions, endpoint, batchSize } = cfg;

  if (provider === "ollama") {
    const primary = new OllamaEmbeddingProvider({ model, dimensions, endpoint, batchSize });
    // Optional fallback to OpenAI when a key is provided
    if (apiKey) {
      const openaiClient = new OpenAI({ apiKey });
      const openaiModels = models?.length ? models : ["text-embedding-3-small"];
      const fallback = new Embeddings(openaiClient, openaiModels, dimensions, batchSize);
      return new FallbackEmbeddingProvider(primary, fallback, onFallback);
    }
    return primary;
  }

  if (provider === "openai") {
    if (!apiKey) throw new Error("OpenAI embedding provider requires embedding.apiKey");
    const openaiClient = new OpenAI({ apiKey });
    const openaiModels = models?.length ? models : [model];
    return new Embeddings(openaiClient, openaiModels, dimensions, batchSize);
  }

  if (provider === "onnx") {
    // ONNX runtime not yet implemented — fall back to OpenAI if key available
    if (apiKey) {
      const openaiClient = new OpenAI({ apiKey });
      const openaiModels = models?.length ? models : ["text-embedding-3-small"];
      return new Embeddings(openaiClient, openaiModels, dimensions, batchSize);
    }
    throw new Error("ONNX embedding provider is not yet implemented. Set embedding.apiKey to fall back to OpenAI, or use provider='ollama'.");
  }

  throw new Error(`Unknown embedding provider: '${provider as string}'. Valid options: openai, ollama, onnx.`);
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
