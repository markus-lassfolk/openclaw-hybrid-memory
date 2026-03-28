/**
 * Factory function: creates the right EmbeddingProvider from plugin config.
 */

import OpenAI from "openai";
import { pluginLogger } from "../../utils/logger.js";
import { capturePluginError } from "../error-reporter.js";
import { ChainEmbeddingProvider } from "./chain-provider.js";
import { FallbackEmbeddingProvider } from "./fallback-provider.js";
import { OllamaEmbeddingProvider } from "./ollama-provider.js";
import { OnnxEmbeddingProvider, isOnnxRuntimeMissingError } from "./onnx-provider.js";
import { Embeddings } from "./openai-provider.js";
import {
  GOOGLE_EMBEDDING_BASE_URL,
  GOOGLE_EMBED_DEFAULT_DIMENSIONS,
  GOOGLE_EMBED_DEFAULT_MODEL,
  KNOWN_GOOGLE_EMBED_MODELS,
  OPENAI_ONLY_EMBED_MODELS,
  isAzureOpenAiCompatibleEndpoint,
} from "./shared.js";
import type { EmbeddingConfig, EmbeddingProvider } from "./types.js";
import { createApimGatewayFetch, isAzureApiManagementGatewayUrl } from "../../utils/apim-gateway-fetch.js";

/** Classic Azure OpenAI REST (e.g. `/openai/deployments/...`) uses this query param. `/openai/v1` compat endpoints reject it (400). */
export const AZURE_OPENAI_API_VERSION = "2024-10-21";

/**
 * Build OpenAI client options for the openai embedding provider.
 * When endpoint is set, uses it as baseURL; when it's Azure, adds the api-key header and (for non-v1 REST paths) api-version.
 * Azure resource roots must use /openai/v1 (not bare /v1). Deployment-style URLs (/openai/deployments/...) are left as-is.
 */
function openaiEmbeddingClientOpts(
  apiKey: string,
  endpoint?: string,
): {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  defaultQuery?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
} {
  const opts: {
    apiKey: string;
    baseURL?: string;
    defaultHeaders?: Record<string, string>;
    defaultQuery?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
  } = { apiKey };
  if (typeof endpoint === "string" && endpoint.trim().length > 0) {
    const baseURL = endpoint.trim().replace(/\/+$/, "");
    const isAzureDeploymentPath = /\/openai\/deployments\//i.test(baseURL);
    const hasOpenAiV1Path = /\/openai\/v1(?:\/|$)/i.test(baseURL);
    const isAzureEndpoint = isAzureOpenAiCompatibleEndpoint(baseURL) && !isAzureApiManagementGatewayUrl(baseURL);
    if (hasOpenAiV1Path || (isAzureEndpoint && isAzureDeploymentPath)) {
      opts.baseURL = baseURL;
    } else if (isAzureEndpoint && !isAzureDeploymentPath) {
      // If the user already appended /openai (e.g. .../openai.azure.com/openai), don't double it.
      const endsWithOpenAi = /\/openai$/i.test(baseURL);
      opts.baseURL = endsWithOpenAi ? `${baseURL}/v1` : `${baseURL}/openai/v1`;
    } else if (isAzureApiManagementGatewayUrl(baseURL) && !isAzureDeploymentPath) {
      // e.g. https://xxx.azure-api.net/resource-name → .../openai/v1 (not bare /v1)
      // Guard against double-prefix when user already appended /openai to the gateway URL.
      const apimEndsWithOpenAi = /\/openai$/i.test(baseURL);
      opts.baseURL = apimEndsWithOpenAi ? `${baseURL}/v1` : `${baseURL}/openai/v1`;
    } else if (isAzureApiManagementGatewayUrl(baseURL) && isAzureDeploymentPath) {
      // APIM gateway with deployment path: use as-is, don't append /v1
      opts.baseURL = baseURL;
    } else {
      opts.baseURL = baseURL.includes("/v1") ? baseURL : `${baseURL}/v1`;
    }
    if (isAzureOpenAiCompatibleEndpoint(opts.baseURL) && !isAzureApiManagementGatewayUrl(opts.baseURL)) {
      opts.defaultHeaders = { "api-key": apiKey };
      const openAiV1Compat = /\/openai\/v1(?:\/|$)/i.test(opts.baseURL);
      // Foundry / Azure AI: `/openai/v1/*` returns 400 "API version not supported" when `api-version` is present.
      if (!openAiV1Compat) {
        opts.defaultQuery = { "api-version": AZURE_OPENAI_API_VERSION };
      }
    }
    // API Management gateway: same api-key auth as Azure resource, but SDK Bearer breaks auth — strip it in fetch.
    if (opts.baseURL && isAzureApiManagementGatewayUrl(opts.baseURL)) {
      opts.defaultHeaders = { ...(opts.defaultHeaders ?? {}), "api-key": apiKey };
      opts.fetch = createApimGatewayFetch(apiKey);
      const openAiV1Compat = /\/openai\/v1(?:\/|$)/i.test(opts.baseURL);
      // APIM deployment-style paths need api-version (passed through to backend Azure OpenAI)
      if (!openAiV1Compat) {
        opts.defaultQuery = { "api-version": AZURE_OPENAI_API_VERSION };
      }
    }
  }
  return opts;
}

/** API model id(s) for OpenAI-compatible embeddings: optional Azure deployment name overrides logical `model`. */
function openAiEmbeddingApiModels(cfg: EmbeddingConfig, forFallback = false): string[] {
  const { model, models, deployment } = cfg;
  if (deployment && deployment.trim().length > 0) {
    return [deployment.trim()];
  }
  if (forFallback && !models?.length) {
    // For fallback paths where primary provider is non-OpenAI, check if cfg.model is a valid OpenAI model
    if (model && OPENAI_ONLY_EMBED_MODELS.has(model)) {
      return [model];
    }
    return ["text-embedding-3-small"];
  }
  return models?.length ? models : [model];
}

/** When using Azure `deployment` as the API model id, pass `cfg.model` for dimension limits and `dimensions` param. */
function azureEmbeddingLogicalModelHint(cfg: EmbeddingConfig): string | undefined {
  return cfg.deployment && cfg.deployment.trim().length > 0 ? cfg.model : undefined;
}

/**
 * Factory: creates the right EmbeddingProvider from plugin config.
 * - When embedding.preferredProviders has length > 1: chain (try in order; aligns with LLM failover, Ollama-as-tier).
 * - provider='ollama' → OllamaEmbeddingProvider (with optional OpenAI fallback if apiKey set)
 * - provider='openai' → Embeddings (OpenAI)
 * - provider='onnx'   → OnnxEmbeddingProvider (with optional OpenAI fallback if apiKey set)
 */
export function createEmbeddingProvider(cfg: EmbeddingConfig, onFallback?: (err: unknown) => void): EmbeddingProvider {
  const { provider, model, apiKey, models, dimensions, endpoint, batchSize, preferredProviders, retryIntervalMs } = cfg;
  const openaiApiModels = openAiEmbeddingApiModels(cfg);

  if (preferredProviders && preferredProviders.length > 1) {
    const chain: EmbeddingProvider[] = [];
    const labels: string[] = [];
    // When Google is in the chain with an OpenAI-only model name, we use 768 for Google; chain requires same dimensions for all.
    const googleInChainWithOpenAiModel =
      preferredProviders.includes("google") && model && OPENAI_ONLY_EMBED_MODELS.has(model);
    const chainDimensions = googleInChainWithOpenAiModel ? GOOGLE_EMBED_DEFAULT_DIMENSIONS : dimensions;
    const ollamaModel =
      model && !["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"].includes(model)
        ? model
        : "nomic-embed-text";
    const googleModel = model && KNOWN_GOOGLE_EMBED_MODELS.has(model) ? model : GOOGLE_EMBED_DEFAULT_MODEL;
    for (const name of preferredProviders) {
      if (name === "ollama") {
        try {
          chain.push(
            new OllamaEmbeddingProvider({ model: ollamaModel, dimensions: chainDimensions, endpoint, batchSize }),
          );
          labels.push("ollama");
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "embeddings",
            operation: "chain-build-ollama",
          });
        }
      } else if (name === "openai" && apiKey) {
        try {
          const client = new OpenAI(openaiEmbeddingClientOpts(apiKey, endpoint));
          // In chain mode, use forFallback=true to get valid OpenAI models when primary is non-OpenAI
          const chainOpenAiModels = openAiEmbeddingApiModels(cfg, true);
          chain.push(
            new Embeddings(client, chainOpenAiModels, chainDimensions, batchSize, azureEmbeddingLogicalModelHint(cfg)),
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
          chain.push(new Embeddings(client, googleModel, chainDimensions, batchSize));
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
      const openaiClient = new OpenAI(openaiEmbeddingClientOpts(apiKey, endpoint));
      try {
        // For Ollama fallback, use forFallback=true to get valid OpenAI models
        const fallbackModels = openAiEmbeddingApiModels(cfg, true);
        const fallback = new Embeddings(
          openaiClient,
          fallbackModels,
          dimensions,
          batchSize,
          azureEmbeddingLogicalModelHint(cfg),
        );
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
    const openaiClient = new OpenAI(openaiEmbeddingClientOpts(apiKey, endpoint));
    return new Embeddings(openaiClient, openaiApiModels, dimensions, batchSize, azureEmbeddingLogicalModelHint(cfg));
  }

  if (provider === "google") {
    if (!cfg.googleApiKey || cfg.googleApiKey.length < 10) {
      throw new Error("Google embedding provider requires distill.apiKey or llm.providers.google.apiKey.");
    }
    const client = new OpenAI({ apiKey: cfg.googleApiKey, baseURL: GOOGLE_EMBEDDING_BASE_URL });
    // Use configured model only when it is a known Google embedding model; otherwise default.
    // When config has an OpenAI-only model name (e.g. text-embedding-3-large), use 768 dims so the API and vectors match.
    const googleEmbedModel = model && KNOWN_GOOGLE_EMBED_MODELS.has(model) ? model : GOOGLE_EMBED_DEFAULT_MODEL;
    const googleDimensions =
      model && OPENAI_ONLY_EMBED_MODELS.has(model) ? GOOGLE_EMBED_DEFAULT_DIMENSIONS : dimensions;
    return new Embeddings(client, googleEmbedModel, googleDimensions, batchSize);
  }

  if (provider === "onnx") {
    const primary = new OnnxEmbeddingProvider({ model, dimensions, batchSize });
    if (apiKey) {
      const openaiClient = new OpenAI(openaiEmbeddingClientOpts(apiKey, endpoint));
      try {
        // For ONNX fallback, use forFallback=true to get valid OpenAI models
        const fallbackModels = openAiEmbeddingApiModels(cfg, true);
        const fallback = new Embeddings(
          openaiClient,
          fallbackModels,
          dimensions,
          batchSize,
          azureEmbeddingLogicalModelHint(cfg),
        );
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
