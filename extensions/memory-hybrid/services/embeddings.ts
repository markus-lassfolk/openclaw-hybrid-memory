/**
 * Embedding service: OpenAI and Ollama implementations, provider abstraction and factory.
 *
 * This file is a thin re-export barrel. Implementation has been split into:
 *   services/embeddings/types.ts          — shared interfaces and error classes
 *   services/embeddings/shared.ts         — constants, cache helpers, error classifiers, safeEmbed
 *   services/embeddings/openai-provider.ts — Embeddings (OpenAI-compatible)
 *   services/embeddings/ollama-provider.ts — OllamaEmbeddingProvider + circuit breaker
 *   services/embeddings/onnx-provider.ts   — OnnxEmbeddingProvider + tokenizer
 *   services/embeddings/fallback-provider.ts — FallbackEmbeddingProvider
 *   services/embeddings/chain-provider.ts  — ChainEmbeddingProvider
 *   services/embeddings/factory.ts         — createEmbeddingProvider
 */

export * from "./embeddings/index.js";
