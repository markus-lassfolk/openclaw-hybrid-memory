/**
 * Factory function: creates the right EmbeddingProvider from plugin config.
 */

import OpenAI from "openai";
import { capturePluginError } from "../error-reporter.js";
import type { EmbeddingProvider, EmbeddingConfig } from "./types.js";
import { GOOGLE_EMBEDDING_BASE_URL, KNOWN_GOOGLE_EMBED_MODELS } from "./shared.js";
import { Embeddings } from "./openai-provider.js";
import { OllamaEmbeddingProvider } from "./ollama-provider.js";
import { OnnxEmbeddingProvider, isOnnxRuntimeMissingError } from "./onnx-provider.js";
import { FallbackEmbeddingProvider } from "./fallback-provider.js";
import { ChainEmbeddingProvider } from "./chain-provider.js";
import { pluginLogger } from "../../utils/logger.js";

/**
 * Factory: creates the right EmbeddingProvider from plugin config.
 * - When embedding.preferredProviders has length > 1: chain (try in order; aligns with LLM failover, Ollama-as-tier).
 * - provider='ollama' → OllamaEmbeddingProvider (with optional OpenAI fallback if apiKey set)
 * - provider='openai' → Embeddings (OpenAI)
 * - provider='onnx'   → OnnxEmbeddingProvider (with optional OpenAI fallback if apiKey set)
 */
export function createEmbeddingProvider(cfg: EmbeddingConfig, onFallback?: (err: unknown) => void): EmbeddingProvider {
  const { provider, model, apiKey, models, dimensions, endpoint, batchSize, preferredProviders, retryIntervalMs } = cfg;

  if (preferredProviders && preferredProviders.length > 1) {
    const chain: EmbeddingProvider[] = [];
    const labels: string[] = [];
    const openaiModels = models?.length ? models : ["text-embedding-3-small"];
    // All providers in the chain must use the same dimensions (config.dimensions). For ollama+openai, use 1536 and an ollama model that supports it, or 768 with openai dimension override if supported.
    const ollamaModel =
      model && !["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"].includes(model)
        ? model
        : "nomic-embed-text";
    // Use cfg.model if it is a known Google embed model; otherwise default to text-embedding-005 (#385).
    // Non-Google model names are rejected to prevent sending them to the Google endpoint.
    const googleModel = model && KNOWN_GOOGLE_EMBED_MODELS.has(model) ? model : "text-embedding-005";
    for (const name of preferredProviders) {
      if (name === "ollama") {
        try {
          chain.push(new OllamaEmbeddingProvider({ model: ollamaModel, dimensions, endpoint, batchSize }));
          labels.push("ollama");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "embeddings",
            operation: "chain-build-ollama",
          });
        }
      } else if (name === "openai" && apiKey) {
        try {
          const client = new OpenAI({ apiKey });
          chain.push(
            new Embeddings(
              client,
              model && ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"].includes(model)
                ? model
                : openaiModels[0],
              dimensions,
              batchSize,
            ),
          );
          labels.push("openai");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "embeddings",
            operation: "chain-build-openai",
          });
        }
      } else if (name === "google" && cfg.googleApiKey && cfg.googleApiKey.length >= 10) {
        try {
          const client = new OpenAI({ apiKey: cfg.googleApiKey, baseURL: GOOGLE_EMBEDDING_BASE_URL });
          chain.push(new Embeddings(client, googleModel, dimensions, batchSize));
          labels.push("google");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "embeddings",
            operation: "chain-build-google",
          });
        }
      }
    }
    if (chain.length === 0) {
      throw new Error(
        "embedding.preferredProviders: no provider could be built (check apiKey for openai/google, Ollama for ollama, distill.apiKey or llm.providers.google for Google).",
      );
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
        return new FallbackEmbeddingProvider(primary, fallback, onFallback, "ollama", "openai", retryIntervalMs);
      } catch (err) {
        // Fallback creation failed (e.g. Ollama dimensions exceed all OpenAI model limits).
        // Warn the user so they know their fallback isn't working.
        pluginLogger.warn(
          `memory-hybrid: Failed to create OpenAI fallback for Ollama provider: ${err instanceof Error ? err.message : String(err)}. Continuing with Ollama-only (no fallback).`,
        );
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
    // Use configured model only when it is a known Google embedding model; otherwise default to text-embedding-005.
    // Non-Google model names are rejected here to prevent sending them to the Google endpoint (#385).
    const googleEmbedModel = model && KNOWN_GOOGLE_EMBED_MODELS.has(model) ? model : "text-embedding-005";
    return new Embeddings(client, googleEmbedModel, dimensions, batchSize);
  }

  if (provider === "onnx") {
    const primary = new OnnxEmbeddingProvider({ model, dimensions, batchSize });
    if (apiKey) {
      const openaiClient = new OpenAI({ apiKey });
      const openaiModels = models?.length ? models : ["text-embedding-3-small"];
      try {
        const fallback = new Embeddings(openaiClient, openaiModels, dimensions, batchSize);
        const onSwitch = (err: unknown) => {
          if (isOnnxRuntimeMissingError(err)) {
            pluginLogger.warn("memory-hybrid: onnxruntime-node not installed; falling back to OpenAI embeddings.");
          } else {
            pluginLogger.warn(
              `memory-hybrid: ONNX embeddings failed; falling back to OpenAI. ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          onFallback?.(err);
        };
        return new FallbackEmbeddingProvider(primary, fallback, onSwitch, "onnx", "openai", retryIntervalMs);
      } catch (err) {
        pluginLogger.warn(
          `memory-hybrid: Failed to create OpenAI fallback for ONNX provider: ${err instanceof Error ? err.message : String(err)}. Continuing with ONNX-only (no fallback).`,
        );
        return primary;
      }
    }
    return primary;
  }

  throw new Error(`Unknown embedding provider: '${provider as string}'. Valid options: openai, ollama, onnx, google.`);
}
