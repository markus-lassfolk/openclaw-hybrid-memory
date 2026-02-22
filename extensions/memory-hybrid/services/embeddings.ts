/**
 * Embedding service: OpenAI implementation and shared helpers.
 * Uses an EmbeddingProvider interface so alternative providers can be added later.
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { capturePluginError } from "./error-reporter.js";

/** Interface for embedding providers (enables swapping OpenAI for other backends). */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/** Max cached embeddings (LRU eviction). Reduces redundant API calls for repeated text. */
const EMBEDDING_CACHE_MAX = 500;

/** Hash text for cache key (prevents large text strings as Map keys). */
function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** OpenAI-based embedding provider (uses gateway client when provided). Optional in-memory cache. Supports model preference list (try in order on failure). */
export class Embeddings implements EmbeddingProvider {
  private client: OpenAI;
  private cache = new Map<string, number[]>();
  /** Ordered list: try first model, on failure try next (all must produce same vector dimension). */
  private readonly models: string[];

  constructor(
    clientOrApiKey: OpenAI | string,
    modelOrModels: string | string[],
  ) {
    this.client = typeof clientOrApiKey === "string"
      ? new OpenAI({ apiKey: clientOrApiKey })
      : clientOrApiKey;
    this.models = Array.isArray(modelOrModels) ? modelOrModels : [modelOrModels];
    if (this.models.length === 0) throw new Error("Embeddings requires at least one model");
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
        const resp = await withLLMRetry(
          () => this.client.embeddings.create({
            model,
            input: text,
          }),
          { maxRetries: 2 },
        );
        const vector = resp.data[0].embedding;
        if (this.cache.size >= EMBEDDING_CACHE_MAX) {
          const firstKey = this.cache.keys().next().value;
          if (firstKey !== undefined) this.cache.delete(firstKey);
        }
        this.cache.set(cacheKey, vector);
        return vector;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        continue;
      }
    }
    if (lastErr) {
      capturePluginError(lastErr, {
        subsystem: "embeddings",
        operation: "embed",
        phase: "fallback-exhausted",
      });
      throw lastErr;
    }
    throw new Error("Embeddings: no model available");
  }
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
