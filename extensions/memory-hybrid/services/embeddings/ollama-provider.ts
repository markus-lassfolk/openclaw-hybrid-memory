/**
 * Ollama local embedding provider with per-endpoint circuit breaker.
 */

import { OLLAMA_COOLDOWN_MS, OLLAMA_MAX_FAILS } from "../../utils/constants.js";
import { pluginLogger } from "../../utils/logger.js";
import type { EmbeddingProvider } from "./types.js";

/**
 * Module-level circuit breaker state keyed by Ollama endpoint URL.
 * Shared across all OllamaEmbeddingProvider instances so that a failure on
 * one instance is visible to new instances pointing at the same endpoint,
 * while endpoints at different base URLs remain independent.
 */
const _ollamaCircuitByEndpoint = new Map<string, { failCount: number; disabledUntil: number }>();

function _getOllamaCircuit(endpoint: string): { failCount: number; disabledUntil: number } {
  if (!_ollamaCircuitByEndpoint.has(endpoint)) {
    _ollamaCircuitByEndpoint.set(endpoint, { failCount: 0, disabledUntil: 0 });
  }
  return _ollamaCircuitByEndpoint.get(endpoint)!;
}

/**
 * Reset the Ollama circuit breaker state for a given endpoint (or all endpoints if omitted).
 * Intended for use in tests only — do not call in production code.
 */
export function _resetOllamaCircuitBreakerForTesting(endpoint?: string): void {
  if (endpoint) {
    _ollamaCircuitByEndpoint.delete(endpoint);
  } else {
    _ollamaCircuitByEndpoint.clear();
  }
}

/**
 * Ollama-based embedding provider.
 * Calls Ollama REST API (POST /api/embed) — no external API key required.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  private readonly endpoint: string;
  private readonly batchSize: number;

  constructor(opts: { model: string; dimensions: number; endpoint?: string; batchSize?: number }) {
    this.modelName = opts.model;
    this.dimensions = opts.dimensions;
    this.endpoint = (opts.endpoint ?? "http://localhost:11434").replace(/\/$/, "");
    this.batchSize = opts.batchSize || 50;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    if (results.length === 0) {
      throw new Error("Ollama embed returned empty results for single text");
    }
    return results[0];
  }

  /** Maximum characters per input text sent to Ollama (~2000 tokens for most models). */
  private static readonly MAX_INPUT_CHARS = 8000;

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Circuit breaker: shared per endpoint so all instances pointing at the same URL are gated together.
    // This prevents one bad endpoint from being retried across separately-constructed instances,
    // while leaving providers at different base URLs unaffected.
    const circuit = _getOllamaCircuit(this.endpoint);
    if (Date.now() < circuit.disabledUntil) {
      throw new Error(
        `Ollama circuit breaker open — disabled until ${new Date(circuit.disabledUntil).toISOString()} (endpoint: ${this.endpoint})`,
      );
    }

    const allResults: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => {
        if (t.length > OllamaEmbeddingProvider.MAX_INPUT_CHARS) {
          pluginLogger.warn(
            `memory-hybrid: Truncating embedding input from ${t.length} to ${OllamaEmbeddingProvider.MAX_INPUT_CHARS} chars for ${this.modelName}`,
          );
          return t.slice(0, OllamaEmbeddingProvider.MAX_INPUT_CHARS);
        }
        return t;
      });
      let resp: Response;
      try {
        resp = await fetch(`${this.endpoint}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.modelName, input: batch }),
        });
      } catch (err) {
        // Connection failure — update shared circuit breaker state for this endpoint
        circuit.failCount++;
        if (circuit.failCount >= OLLAMA_MAX_FAILS) {
          circuit.disabledUntil = Date.now() + OLLAMA_COOLDOWN_MS;
          pluginLogger.warn(
            `memory-hybrid: Ollama circuit breaker open — disabling endpoint ${this.endpoint} for 5min after ${circuit.failCount} failures`,
          );
        }
        throw new Error(`Ollama connection failed (${this.endpoint}): ${err}`);
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        const errMsg = `Ollama embed failed: HTTP ${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`;
        // OOM: trip circuit breaker immediately — retrying the same model won't free memory.
        const isOOM =
          body.toLowerCase().includes("model requires more system memory") ||
          body.toLowerCase().includes("not enough memory to load") ||
          /\bmodel\s+requires\s+[\d.]+\s*gib/i.test(body) ||
          /\boom:/i.test(body);
        if (isOOM) {
          circuit.disabledUntil = Date.now() + OLLAMA_COOLDOWN_MS;
          circuit.failCount = OLLAMA_MAX_FAILS;
          pluginLogger.warn(
            `memory-hybrid: Ollama model OOM (${this.modelName}) — model requires more memory than available. Circuit breaker tripped; disabling endpoint ${this.endpoint} for 5min. Consider using a smaller model or configuring a cloud embedding fallback.`,
          );
        }
        throw new Error(errMsg);
      }
      const data = (await resp.json()) as { embeddings: number[][] };
      if (!Array.isArray(data.embeddings)) {
        throw new Error(`Ollama embed response missing 'embeddings' array`);
      }
      if (data.embeddings.length === 0) {
        throw new Error(`Ollama embed returned empty 'embeddings' array (expected ${batch.length})`);
      }
      if (data.embeddings.length !== batch.length) {
        throw new Error(`Ollama embed returned ${data.embeddings.length} embeddings for ${batch.length} inputs`);
      }
      allResults.push(...data.embeddings);
    }
    // Successful call — reset circuit breaker for this endpoint
    circuit.failCount = 0;
    circuit.disabledUntil = 0;
    return allResults;
  }
}
