/**
 * EmbeddingRegistry: manages multiple embedding models per fact (Issue #158).
 *
 * Different models capture different semantic angles (general, domain-specific,
 * query-tuned). The registry creates providers lazily and exposes a unified API
 * for embedding text with one or all registered models.
 *
 * If no additional models are registered (empty/undefined multiModels config),
 * the system works exactly as before — single-model mode with no performance impact.
 */

import OpenAI from "openai";
import type { EmbeddingModelConfig } from "../config.js";
import {
  Embeddings,
  OllamaEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings.js";

// ---------------------------------------------------------------------------
// EmbeddingRegistry
// ---------------------------------------------------------------------------

/**
 * Registry for multiple embedding models.
 *
 * Usage:
 * ```ts
 * const registry = new EmbeddingRegistry(primaryProvider, primaryModelName);
 * registry.register({ name: "nomic-embed-text", provider: "ollama", dimensions: 768, role: "domain" });
 *
 * // Embed with all models
 * const vectors = await registry.embedAll("some text");
 * // => Map { "primary" => Float32Array, "nomic-embed-text" => Float32Array }
 *
 * // Embed with a specific model
 * const vec = await registry.embed("some text", "nomic-embed-text");
 * ```
 */
export class EmbeddingRegistry {
  /** The primary (existing) embedding provider. */
  private readonly primary: EmbeddingProvider;
  /** Canonical name for the primary model (used as map key). */
  private readonly primaryName: string;

  /** Additional model configs (populated via register()). */
  private readonly modelConfigs: EmbeddingModelConfig[] = [];
  /** Lazily-initialized providers for additional models. */
  private readonly providers = new Map<string, EmbeddingProvider>();

  constructor(primary: EmbeddingProvider, primaryName: string) {
    this.primary = primary;
    this.primaryName = primaryName;
  }

  /**
   * Register an additional embedding model.
   * Skips models that are disabled (enabled === false).
   * Skips registration if a model with the same name already exists.
   */
  register(config: EmbeddingModelConfig): void {
    if (config.enabled === false) return;
    // Prevent duplicate registrations
    if (config.name === this.primaryName) return;
    if (this.modelConfigs.some((m) => m.name === config.name)) return;
    this.modelConfigs.push(config);
  }

  /**
   * Get all registered model configs (additional models only; does not include primary).
   */
  getModels(): EmbeddingModelConfig[] {
    return [...this.modelConfigs];
  }

  /**
   * Get the primary model config-like object.
   */
  getPrimaryModel(): { name: string; provider: string; dimensions: number } {
    return {
      name: this.primaryName,
      provider: this.primary.constructor.name,
      dimensions: this.primary.dimensions,
    };
  }

  /** Whether any additional models are registered (multi-model mode). */
  isMultiModel(): boolean {
    return this.modelConfigs.length > 0;
  }

  /**
   * Embed text with a specific model by name.
   * Pass undefined or primaryName to use the primary model.
   */
  async embed(text: string, modelName?: string): Promise<Float32Array> {
    if (!modelName || modelName === this.primaryName) {
      const vec = await this.primary.embed(text);
      return toFloat32Array(vec);
    }
    const provider = this.getOrCreateProvider(modelName);
    const vec = await provider.embed(text);
    return toFloat32Array(vec);
  }

  /**
   * Embed text with ALL registered models (primary + additional).
   * Returns a Map from model name → Float32Array.
   * On partial failure, the error is thrown so callers can decide how to handle it.
   */
  async embedAll(text: string): Promise<Map<string, Float32Array>> {
    const result = new Map<string, Float32Array>();

    // Primary model first
    const primaryVec = await this.primary.embed(text);
    result.set(this.primaryName, toFloat32Array(primaryVec));

    // Additional models in parallel
    if (this.modelConfigs.length > 0) {
      const tasks = this.modelConfigs.map(async (cfg) => {
        const provider = this.getOrCreateProvider(cfg.name);
        const vec = await provider.embed(text);
        return [cfg.name, toFloat32Array(vec)] as const;
      });
      const settled = await Promise.allSettled(tasks);
      for (const s of settled) {
        if (s.status === "fulfilled") {
          const [name, vec] = s.value;
          result.set(name, vec);
        } else {
          // Re-throw: partial failure in multi-model embed should not go silently
          throw s.reason instanceof Error
            ? s.reason
            : new Error(String(s.reason));
        }
      }
    }

    return result;
  }

  /**
   * Return the names of all models (primary + additional enabled models).
   */
  allModelNames(): string[] {
    return [
      this.primaryName,
      ...this.modelConfigs.map((m) => m.name),
    ];
  }

  // ---------------------------------------------------------------------------
  // Internal: lazy provider creation
  // ---------------------------------------------------------------------------

  private getOrCreateProvider(modelName: string): EmbeddingProvider {
    const existing = this.providers.get(modelName);
    if (existing) return existing;

    const cfg = this.modelConfigs.find((m) => m.name === modelName);
    if (!cfg) {
      throw new Error(`No embedding model registered with name '${modelName}'`);
    }

    const provider = createProviderForConfig(cfg);
    this.providers.set(modelName, provider);
    return provider;
  }
}

// ---------------------------------------------------------------------------
// Helper: create an EmbeddingProvider from an EmbeddingModelConfig
// ---------------------------------------------------------------------------

function createProviderForConfig(cfg: EmbeddingModelConfig): EmbeddingProvider {
  if (cfg.provider === "ollama") {
    return new OllamaEmbeddingProvider({
      model: cfg.name,
      dimensions: cfg.dimensions,
      endpoint: cfg.endpoint,
    });
  }

  if (cfg.provider === "openai") {
    if (!cfg.apiKey) {
      throw new Error(
        `EmbeddingModelConfig for '${cfg.name}': apiKey is required for openai provider`,
      );
    }
    const client = new OpenAI({ apiKey: cfg.apiKey });
    return new Embeddings(client, cfg.name, cfg.dimensions);
  }

  if (cfg.provider === "onnx") {
    throw new Error(
      `EmbeddingModelConfig for '${cfg.name}': ONNX provider is not yet implemented. ` +
        "Use provider='ollama' or provider='openai'.",
    );
  }

  throw new Error(
    `EmbeddingModelConfig for '${cfg.name}': unknown provider '${cfg.provider as string}'`,
  );
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Convert number[] or Float32Array to Float32Array. */
function toFloat32Array(vec: number[] | Float32Array): Float32Array {
  return vec instanceof Float32Array ? vec : new Float32Array(vec);
}

/**
 * Build an EmbeddingRegistry from plugin config.
 * If cfg.multiModels is empty/undefined, returns a single-model registry.
 */
export function buildEmbeddingRegistry(
  primary: EmbeddingProvider,
  primaryName: string,
  multiModels?: EmbeddingModelConfig[],
): EmbeddingRegistry {
  const registry = new EmbeddingRegistry(primary, primaryName);
  if (multiModels && multiModels.length > 0) {
    for (const modelCfg of multiModels) {
      registry.register(modelCfg);
    }
  }
  return registry;
}
