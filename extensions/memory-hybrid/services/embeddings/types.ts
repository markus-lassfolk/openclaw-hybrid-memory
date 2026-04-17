/**
 * Shared types and interfaces for the embedding providers.
 */

/**
 * Thrown by ChainEmbeddingProvider when every provider in the chain has failed.
 * Callers should catch this and degrade gracefully (e.g. store without a vector)
 * rather than reporting to error monitoring, since this is expected when all
 * configured embedding backends are temporarily unavailable.
 *
 * `causes` contains the per-provider errors; callers can inspect them to decide
 * whether to suppress error monitoring (e.g. all are config errors → no report).
 */
export class AllEmbeddingProvidersFailed extends Error {
	readonly causes: Error[];
	constructor(causes: Error[] = []) {
		super("All embedding providers in the chain failed.");
		this.name = "AllEmbeddingProvidersFailed";
		this.causes = causes;
	}
}

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
	/** Azure OpenAI / Foundry: deployment name for the embeddings API (must match Portal). When set, overrides `model` in API calls only; `model` still selects vector dimensions. */
	deployment?: string;
	endpoint?: string;
	batchSize: number;
	/** Ordered list to try (failover). When length > 1, a chain is built. */
	preferredProviders?: ("ollama" | "openai" | "google")[];
	/** Set by parser from distill.apiKey or llm.providers.google.apiKey when preferredProviders includes "google". */
	googleApiKey?: string;
	/**
	 * How long (ms) FallbackEmbeddingProvider waits before probing the primary again after a fallback switch.
	 * Must be a finite number > 0. Defaults to 60 000 (1 minute) when not set.
	 */
	retryIntervalMs?: number;
}
