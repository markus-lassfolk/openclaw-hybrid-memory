/**
 * FallbackEmbeddingProvider: tries primary provider, permanently switches to fallback on first failure.
 */

import { capturePluginError } from "../error-reporter.js";
import { is429OrWrapped } from "../chat.js";
import type { EmbeddingProvider } from "./types.js";
import { isConfigError, isOllamaCircuitBreakerOpen, isOllamaConnectionFailure } from "./shared.js";
import { pluginLogger } from "../../utils/logger.js";

/**
 * Wrapper that tries a primary provider and switches permanently to a fallback on first failure.
 * Useful for Ollama → OpenAI fallback when Ollama is temporarily unavailable.
 */
export class FallbackEmbeddingProvider implements EmbeddingProvider {
  private active: EmbeddingProvider;
  private readonly primary: EmbeddingProvider;
  private readonly fallback: EmbeddingProvider | null;
  private switched = false;
  private lastRetryAttempt = 0;
  private readonly retryIntervalMs: number;
  private readonly onSwitch?: (err: unknown) => void;
  private readonly primaryLabel: string;
  private readonly fallbackLabel: string;
  readonly dimensions: number;
  modelName: string;
  /** "ollama" when using primary, "openai" when using fallback (so logs reflect actual provider). */
  get activeProvider(): string {
    return this.switched ? this.fallbackLabel : this.primaryLabel;
  }

  constructor(
    primary: EmbeddingProvider,
    fallback: EmbeddingProvider | null,
    onSwitch?: (err: unknown) => void,
    primaryLabel = "ollama",
    fallbackLabel = "openai",
    retryIntervalMs = 60000,
  ) {
    if (!Number.isFinite(retryIntervalMs) || retryIntervalMs <= 0) {
      throw new Error(`FallbackEmbeddingProvider: retryIntervalMs must be a finite number > 0, got ${retryIntervalMs}`);
    }
    if (retryIntervalMs < 1000) {
      // Values below 1 s are valid for tests but will hammer the primary provider in production.
      pluginLogger.warn(
        `FallbackEmbeddingProvider: retryIntervalMs=${retryIntervalMs}ms is very low; values under 1000ms may cause excessive primary-probe traffic after a fallback switch.`,
      );
    }
    if (fallback && fallback.dimensions !== primary.dimensions) {
      throw new Error(
        `Primary (${primary.modelName}: ${primary.dimensions}d) and fallback ` +
          `(${fallback.modelName}: ${fallback.dimensions}d) must have matching dimensions`,
      );
    }
    this.active = primary;
    this.primary = primary;
    this.fallback = fallback;
    this.onSwitch = onSwitch;
    this.primaryLabel = primaryLabel;
    this.fallbackLabel = fallbackLabel;
    this.retryIntervalMs = retryIntervalMs;
    this.dimensions = primary.dimensions;
    this.modelName = primary.modelName;
  }

  /**
   * Attempt to return to the primary provider after a fallback switch.
   * Updates `switched`, `active`, and `modelName` on success.
   * Returns the result if primary recovered, or null if still failing (stay on fallback).
   */
  private async tryReturnToPrimary<T>(
    fn: (provider: EmbeddingProvider) => Promise<T>,
    phase: string,
  ): Promise<T | null> {
    this.lastRetryAttempt = Date.now();
    try {
      const result = await fn(this.primary);
      this.active = this.primary;
      this.switched = false;
      this.modelName = this.active.modelName;
      return result;
    } catch (err) {
      const asErr = err instanceof Error ? err : new Error(String(err));
      // Skip reporting config errors (404/403/401 — operator issues), 429 (rate limit), and circuit breaker open — not bugs (#329, #394, #385, #397, #458).
      if (
        !isConfigError(asErr) &&
        !is429OrWrapped(asErr) &&
        !isOllamaCircuitBreakerOpen(asErr) &&
        !isOllamaConnectionFailure(asErr)
      ) {
        capturePluginError(asErr, {
          subsystem: "embeddings",
          operation: "fallback-retry-primary",
          phase,
        });
      }
      // Primary still failing — continue using fallback
      return null;
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.fallback) {
      return this.active.embed(text);
    }
    if (this.switched && Date.now() - this.lastRetryAttempt >= this.retryIntervalMs) {
      const recovered = await this.tryReturnToPrimary((p) => p.embed(text), "embed");
      if (recovered !== null) return recovered;
    }
    if (this.switched) {
      return this.active.embed(text);
    }
    try {
      return await this.active.embed(text);
    } catch (err) {
      const asErr = err instanceof Error ? err : new Error(String(err));
      // Skip reporting config errors (404/403/401 — operator issues), 429 (rate limit), and circuit breaker open — not bugs (#329, #394, #385, #397, #458).
      if (
        !isConfigError(asErr) &&
        !is429OrWrapped(asErr) &&
        !isOllamaCircuitBreakerOpen(asErr) &&
        !isOllamaConnectionFailure(asErr)
      ) {
        capturePluginError(asErr, {
          subsystem: "embeddings",
          operation: "fallback-switch",
          phase: "embed",
        });
      }
      this.onSwitch?.(err);
      this.active = this.fallback;
      this.switched = true;
      this.lastRetryAttempt = Date.now();
      this.modelName = this.active.modelName;
      return this.active.embed(text);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.fallback) {
      return this.active.embedBatch(texts);
    }
    if (this.switched && Date.now() - this.lastRetryAttempt >= this.retryIntervalMs) {
      const recovered = await this.tryReturnToPrimary((p) => p.embedBatch(texts), "embedBatch");
      if (recovered !== null) return recovered;
    }
    if (this.switched) {
      return this.active.embedBatch(texts);
    }
    try {
      return await this.active.embedBatch(texts);
    } catch (err) {
      const asErr = err instanceof Error ? err : new Error(String(err));
      // Skip reporting config errors (404/403/401 — operator issues), 429 (rate limit), and circuit breaker open — not bugs (#329, #394, #385, #397, #458).
      if (
        !isConfigError(asErr) &&
        !is429OrWrapped(asErr) &&
        !isOllamaCircuitBreakerOpen(asErr) &&
        !isOllamaConnectionFailure(asErr)
      ) {
        capturePluginError(asErr, {
          subsystem: "embeddings",
          operation: "fallback-switch",
          phase: "embedBatch",
        });
      }
      this.onSwitch?.(err);
      this.active = this.fallback;
      this.switched = true;
      this.lastRetryAttempt = Date.now();
      this.modelName = this.active.modelName;
      return this.active.embedBatch(texts);
    }
  }
}
