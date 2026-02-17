/**
 * Embedding service: OpenAI implementation and shared helpers.
 * Uses an EmbeddingProvider interface so alternative providers can be added later.
 */

import OpenAI from "openai";

/** Interface for embedding providers (enables swapping OpenAI for other backends). */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/** OpenAI-based embedding provider. */
export class Embeddings implements EmbeddingProvider {
  private client: OpenAI;

  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const resp = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return resp.data[0].embedding;
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
