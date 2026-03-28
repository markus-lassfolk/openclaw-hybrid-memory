/**
 * OpenAI-compatible embedding provider (also used for Google Gemini via OpenAI-compatible endpoint).
 */

import OpenAI from "openai";
import { withLLMRetry } from "../chat.js";
import { capturePluginError } from "../error-reporter.js";
import { EMBEDDING_CACHE_MAX, makeCacheKey, shouldSuppressEmbeddingError, truncateForEmbedding } from "./shared.js";
import type { EmbeddingProvider } from "./types.js";

/**
 * OpenAI-based embedding provider.
 * Uses a cache, supports model preference lists (try in order on failure).
 */
export class Embeddings implements EmbeddingProvider {
  private client: OpenAI;
  private cache = new Map<string, number[]>();
  /** Ordered list: try first model, on failure try next (all must produce same vector dimension). */
  private readonly models: string[];
  /**
   * When the API uses an Azure deployment id (not a public OpenAI model id), use this for
   * dimension limits and the `dimensions` request field (e.g. `text-embedding-3-large`).
   */
  private readonly logicalModelForEmbedding?: string;
  readonly dimensions: number;
  modelName: string;
  private readonly batchSize: number;

  constructor(
    clientOrApiKey: OpenAI | string,
    modelOrModels: string | string[],
    dimensions?: number,
    batchSize?: number,
    logicalModelForEmbedding?: string,
  ) {
    this.client = typeof clientOrApiKey === "string" ? new OpenAI({ apiKey: clientOrApiKey }) : clientOrApiKey;
    this.models = Array.isArray(modelOrModels) ? modelOrModels : [modelOrModels];
    if (this.models.length === 0) throw new Error("Embeddings requires at least one model");
    this.logicalModelForEmbedding = logicalModelForEmbedding;
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
      const effective = this.logicalModelForEmbedding ?? model;
      const maxDim = modelMaxDimensions[effective];
      if (maxDim !== undefined && this.dimensions > maxDim) {
        throw new Error(`Dimensions ${this.dimensions} exceed maximum ${maxDim} for model ${effective}`);
      }
      const nativeDim = modelNativeDimensions[effective];
      const supportsDimensions = effective.startsWith("text-embedding-3-");
      if (nativeDim !== undefined && this.dimensions !== nativeDim && !supportsDimensions) {
        throw new Error(
          `Model ${effective} does not support custom dimensions (native: ${nativeDim}, requested: ${this.dimensions}). Use a text-embedding-3-* model for custom dimensions.`,
        );
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
        const effective = this.logicalModelForEmbedding ?? model;
        const supportsDimensions = effective.startsWith("text-embedding-3-");
        // Truncate to stay within the 8192-token OpenAI embedding limit (#442)
        const input = truncateForEmbedding(text);
        const resp = await withLLMRetry(
          () =>
            this.client.embeddings.create({
              model,
              input,
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
      }
    }
    // lastErr is always defined here: constructor enforces models.length >= 1, so
    // the loop always runs at least once; either it returns early (success) or
    // sets lastErr on every iteration before reaching this point.
    // Skip reporting config errors (404 model-not-found, 403 country/region restriction, 401 auth failure), 429 (rate limit), and 500 errors — operator config issues or transient errors, not bugs (#329, #394, #397, #385, #739).
    if (!shouldSuppressEmbeddingError(lastErr!)) {
      capturePluginError(lastErr!, {
        subsystem: "embeddings",
        operation: "embed",
        phase: "fallback-exhausted",
      });
    }
    throw lastErr!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Phase 1: Prefill results from cache (same model-order logic as embed()).
    // Check each model in preference order so a cached fallback result is reused
    // even if the primary model's cache slot is empty (#589).
    const results: (number[] | undefined)[] = new Array(texts.length).fill(undefined);
    const uncachedIndices: number[] = [];
    let cacheHitModel: string | undefined;
    for (let i = 0; i < texts.length; i++) {
      let found = false;
      for (const model of this.models) {
        const cacheKey = makeCacheKey(model, texts[i]);
        const cached = this.cache.get(cacheKey);
        if (cached !== undefined) {
          // LRU refresh: move to end
          this.cache.delete(cacheKey);
          this.cache.set(cacheKey, cached);
          results[i] = cached;
          found = true;
          if (cacheHitModel === undefined) cacheHitModel = model;
          break;
        }
      }
      if (!found) uncachedIndices.push(i);
    }

    if (uncachedIndices.length === 0) {
      if (cacheHitModel !== undefined) this.modelName = cacheHitModel;
      return results as number[][];
    }

    // Phase 2: Batch-embed only the uncached texts, chunked by batchSize.
    const uncachedTexts = uncachedIndices.map((i) => texts[i]);
    const freshVectors: number[][] = [];
    for (let i = 0; i < uncachedTexts.length; i += this.batchSize) {
      const batch = uncachedTexts.slice(i, i + this.batchSize);

      let lastErr: Error | undefined;
      let resp: Awaited<ReturnType<typeof this.client.embeddings.create>> | undefined;
      let succeededModel: string | undefined;
      for (const model of this.models) {
        try {
          const effective = this.logicalModelForEmbedding ?? model;
          const supportsDimensions = effective.startsWith("text-embedding-3-");
          // Truncate each item to stay within the 8192-token OpenAI embedding limit (#442)
          const truncatedBatch = batch.map(truncateForEmbedding);
          resp = await withLLMRetry(
            () =>
              this.client.embeddings.create({
                model,
                input: truncatedBatch,
                ...(supportsDimensions ? { dimensions: this.dimensions } : {}),
              }),
            { maxRetries: 2 },
          );
          succeededModel = model;
          this.modelName = model;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
        }
      }
      if (resp !== undefined && succeededModel !== undefined) {
        if (resp.data.length !== batch.length) {
          throw new Error(`OpenAI embed returned ${resp.data.length} embeddings for ${batch.length} inputs`);
        }
        const sorted = resp.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
        // Write fresh vectors into the cache keyed by the model that succeeded (#589)
        for (let j = 0; j < batch.length; j++) {
          if (this.cache.size >= EMBEDDING_CACHE_MAX) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) this.cache.delete(firstKey);
          }
          this.cache.set(makeCacheKey(succeededModel, uncachedTexts[i + j]), sorted[j]);
        }
        freshVectors.push(...sorted);
      }
      if (lastErr !== undefined && freshVectors.length === i) {
        // Skip reporting config errors (404 model-not-found, 403 country/region restriction, 401 auth failure), 429 (rate limit), and 500 errors — operator config issues or transient errors, not bugs (#329, #394, #397, #385, #739).
        if (!shouldSuppressEmbeddingError(lastErr)) {
          capturePluginError(lastErr, {
            subsystem: "embeddings",
            operation: "embedBatch",
            phase: "fallback-exhausted",
          });
        }
        throw lastErr;
      }
    }

    // Phase 3: Reconstruct the full result array in original input order.
    for (let i = 0; i < uncachedIndices.length; i++) {
      results[uncachedIndices[i]] = freshVectors[i];
    }
    return results as number[][];
  }
}
