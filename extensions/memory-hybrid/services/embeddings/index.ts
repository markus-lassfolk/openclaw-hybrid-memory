/**
 * Embedding providers — public re-exports.
 *
 * Split from the original monolithic embeddings.ts into per-concern modules:
 *   types.ts          — shared interfaces and error classes
 *   shared.ts         — constants, cache helpers, error classifiers, safeEmbed
 *   openai-provider.ts — Embeddings (OpenAI-compatible)
 *   ollama-provider.ts — OllamaEmbeddingProvider + circuit breaker
 *   onnx-provider.ts   — OnnxEmbeddingProvider + tokenizer
 *   fallback-provider.ts — FallbackEmbeddingProvider
 *   chain-provider.ts  — ChainEmbeddingProvider
 *   factory.ts         — createEmbeddingProvider
 */

export { AllEmbeddingProvidersFailed } from "./types.js";
export type { EmbeddingProvider, EmbeddingConfig } from "./types.js";

export {
  GOOGLE_EMBED_DEFAULT_DIMENSIONS,
  GOOGLE_EMBED_DEFAULT_MODEL,
  OPENAI_ONLY_EMBED_MODELS,
  isOllamaCircuitBreakerOpen,
  shouldSuppressEmbeddingError,
  safeEmbed,
} from "./shared.js";

export { Embeddings } from "./openai-provider.js";

export { OllamaEmbeddingProvider, _resetOllamaCircuitBreakerForTesting } from "./ollama-provider.js";

export { OnnxEmbeddingProvider, isOnnxRuntimeMissingError, __setOnnxRuntimeLoaderForTests } from "./onnx-provider.js";

export { FallbackEmbeddingProvider } from "./fallback-provider.js";

export { ChainEmbeddingProvider } from "./chain-provider.js";

export { createEmbeddingProvider } from "./factory.js";
