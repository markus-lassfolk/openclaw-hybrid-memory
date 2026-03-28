/**
 * ChainEmbeddingProvider: tries a list of providers in order; first success wins.
 */

import { capturePluginError } from "../error-reporter.js";
import type { EmbeddingProvider } from "./types.js";
import { AllEmbeddingProvidersFailed } from "./types.js";
import { shouldSuppressEmbeddingError, isConfigError } from "./shared.js";

/**
 * Tries a list of embedding providers in order; first success wins (no retry of earlier providers).
 * Aligns with LLM failover: same idea as getLLMModelPreference / tier; Ollama can be first tier.
 */
export class ChainEmbeddingProvider implements EmbeddingProvider {
  private readonly providers: EmbeddingProvider[];
  private readonly labels: string[];
  private activeIndex = 0;
  /** Per-provider cooldown: maps provider index → { timestamp until which it should be skipped, original error }.
   *  Config errors (401/403/404) mark a provider as failed for CHAIN_PROVIDER_COOLDOWN_MS so we
   *  don't waste a round-trip retrying a known-broken provider on every call (#385 Bug 4). */
  private readonly failedUntil = new Map<number, { expiry: number; error: Error }>();
  private static readonly COOLDOWN_MS = 60_000; // 60s, matches FallbackEmbeddingProvider.retryIntervalMs
  readonly dimensions: number;
  modelName: string;
  get activeProvider(): string {
    // When the active provider is itself a FallbackEmbeddingProvider that has switched internally,
    // prefer its own activeProvider over the chain's label for accurate reporting (#560).
    // The `?.activeProvider` can be undefined: EmbeddingProvider.activeProvider is optional
    // (`?: string`), so providers that don't implement it will hit the `??` fallback and return
    // the chain's own label. Both branches are intentionally reachable.
    return this.providers[this.activeIndex]?.activeProvider ?? this.labels[this.activeIndex];
  }

  constructor(providers: EmbeddingProvider[], labels: string[]) {
    if (providers.length === 0 || providers.length !== labels.length) {
      throw new Error("ChainEmbeddingProvider requires non-empty providers and same-length labels");
    }
    const dim = providers[0].dimensions;
    if (providers.some((p) => p.dimensions !== dim)) {
      throw new Error("ChainEmbeddingProvider: all providers must have the same dimensions");
    }
    this.providers = providers;
    this.labels = labels;
    this.dimensions = dim;
    this.modelName = providers[0].modelName;
  }

  private async tryProviders<T>(fn: (provider: EmbeddingProvider) => Promise<T>, phase: string): Promise<T> {
    let currentIndex = 0;
    this.modelName = this.providers[0].modelName;
    const collectedErrors: Error[] = [];
    while (currentIndex < this.providers.length) {
      // Skip providers in cooldown (config errors like 401/403/404 or transient errors). Expire stale entries.
      const cooldownEntry = this.failedUntil.get(currentIndex);
      if (cooldownEntry !== undefined) {
        if (Date.now() < cooldownEntry.expiry) {
          // Still in cooldown — add the original error to collectedErrors so safeEmbed can suppress correctly
          collectedErrors.push(cooldownEntry.error);
          currentIndex++;
          if (currentIndex < this.providers.length) {
            this.modelName = this.providers[currentIndex].modelName;
          }
          continue;
        }
        // Cooldown expired — let this provider retry
        this.failedUntil.delete(currentIndex);
      }
      try {
        const result = await fn(this.providers[currentIndex]);
        // Success — clear any lingering cooldown (belt-and-suspenders)
        this.failedUntil.delete(currentIndex);
        this.activeIndex = currentIndex;
        return result;
      } catch (err) {
        const asErr = err instanceof Error ? err : new Error(String(err));
        collectedErrors.push(asErr);
        // Mark provider as failed for cooldown period when it's a config error
        if (isConfigError(asErr)) {
          this.failedUntil.set(currentIndex, { expiry: Date.now() + ChainEmbeddingProvider.COOLDOWN_MS, error: asErr });
        }
        // Only capture individual provider failures when there are remaining fallbacks.
        // When this is the last provider, we'll degrade gracefully via AllEmbeddingProvidersFailed.
        const isLast = currentIndex + 1 >= this.providers.length;
        if (!isLast) {
          // Skip reporting config errors (404/403/401 — operator issues), 429 (rate limit), and circuit breaker open — not bugs (#329, #394, #385, #397, #458)
          if (!shouldSuppressEmbeddingError(asErr)) {
            capturePluginError(asErr, {
              subsystem: "embeddings",
              operation: "chain-failover",
              phase,
            });
          }
        }
        currentIndex++;
        if (currentIndex < this.providers.length) {
          this.modelName = this.providers[currentIndex].modelName;
        }
      }
    }
    // All providers exhausted — throw a typed error so callers can degrade gracefully
    // without reporting noise to error monitoring.
    throw new AllEmbeddingProvidersFailed(collectedErrors);
  }

  async embed(text: string): Promise<number[]> {
    return this.tryProviders((provider) => provider.embed(text), "embed");
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.tryProviders((provider) => provider.embedBatch(texts), "embedBatch");
  }
}
