/**
 * Embedding service: OpenAI implementation and shared helpers.
 * Uses an EmbeddingProvider interface so alternative providers can be added later.
 */

import OpenAI from "openai";

/** Interface for embedding providers (enables swapping OpenAI for other backends). */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/** Max cached embeddings (LRU eviction). Reduces redundant API calls for repeated text. */
const EMBEDDING_CACHE_MAX = 500;

/** OpenAI-based embedding provider. Optional in-memory cache to avoid redundant API calls. */
export class Embeddings implements EmbeddingProvider {
  private client: OpenAI;
  private cache = new Map<string, number[]>();

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached !== undefined) return cached;

    const resp = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    const vector = resp.data[0].embedding;

    if (this.cache.size >= EMBEDDING_CACHE_MAX) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(text, vector);
    return vector;
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
    if (logWarn) logWarn(`memory-hybrid: embedding failed: ${err}`);
    return null;
  }
}
