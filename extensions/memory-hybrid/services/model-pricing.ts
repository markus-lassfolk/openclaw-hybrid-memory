/**
 * Static LLM model pricing table for cost estimation.
 *
 * ⚠️ DISCLAIMER: Prices are rough estimates based on publicly published
 * rates as of 2026. Actual billing may differ due to promotions,
 * batch discounts, caching, or provider changes. Do not use for billing.
 */

export interface ModelPricing {
  /** USD per 1M input tokens */
  inputPer1M: number;
  /** USD per 1M output tokens */
  outputPer1M: number;
}

/** Static pricing table. Keys match the provider/model format used in LLM config. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "openai/gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "openai/gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "openai/gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "openai/gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "openai/o3": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "openai/o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "openai/gpt-5.4": { inputPer1M: 2.0, outputPer1M: 8.0 },
  // Google
  "google/gemini-2.0-flash-lite": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "google/gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "google/gemini-3.1-pro-preview": { inputPer1M: 1.25, outputPer1M: 10.0 },
  // Anthropic
  "anthropic/claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "anthropic/claude-opus-4-6": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "anthropic/claude-haiku-3.5": { inputPer1M: 0.8, outputPer1M: 4.0 },
  // MiniMax
  "minimax/MiniMax-M2.5": { inputPer1M: 0.2, outputPer1M: 1.1 },
};

/** Lowercased index built once at module load for O(1) case-insensitive lookup. */
const MODEL_PRICING_LOWER: Record<string, ModelPricing> = Object.fromEntries(
  Object.entries(MODEL_PRICING).map(([k, v]) => [k.toLowerCase(), v]),
);

/**
 * Look up pricing for a model. Returns null if the model is not in the table.
 * Model name is matched case-insensitively.
 * Local Ollama models always return $0 (no API cost).
 */
export function getModelPricing(model: string): ModelPricing | null {
  // Local Ollama models are always free ($0)
  if (model.toLowerCase().startsWith("ollama/")) return { inputPer1M: 0, outputPer1M: 0 };
  // Direct match first (fastest path)
  if (model in MODEL_PRICING) return MODEL_PRICING[model]!;
  // O(1) case-insensitive lookup via pre-built lowercase index
  return MODEL_PRICING_LOWER[model.toLowerCase()] ?? null;
}

/**
 * Estimate cost in USD for a given model and token counts.
 * Returns null if the model is not in the pricing table.
 */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M;
}

// ---------------------------------------------------------------------------
// Config-mode cost estimates
// ---------------------------------------------------------------------------

export interface ModeEstimate {
  mode: "local" | "minimal" | "enhanced" | "complete";
  /** Human-readable description of features enabled in this mode. */
  description: string;
  /** List of features enabled (for display). */
  features: string[];
  /** Estimated monthly cost lower bound (USD). */
  monthlyLow: number;
  /** Estimated monthly cost upper bound (USD). */
  monthlyHigh: number;
}

/**
 * Return cost estimates ($/month) for each config mode.
 *
 * Local: no external LLM. Minimal: nano/flash-tier only (distill, auto-classify).
 * Enhanced/Complete: broader model use. Estimates use openai/gpt-4.1-nano equivalents.
 */
export function getModeCostEstimates(): ModeEstimate[] {
  return [
    {
      mode: "local",
      description: "No external LLM — FTS-only recall, local SQLite + files",
      features: ["structured-recall", "auto-capture"],
      monthlyLow: 0.0,
      monthlyHigh: 0.0,
    },
    {
      mode: "minimal",
      description: "Nano for classify, flash for distill — good value at low cost",
      features: ["embeddings", "auto-classify", "distill", "structured-recall", "graph", "procedures"],
      monthlyLow: 0.02,
      monthlyHigh: 0.3,
    },
    {
      mode: "enhanced",
      description: "Reflection, self-correction, entity lookup, classify-at-write",
      features: [
        "embeddings",
        "auto-classify",
        "structured-recall",
        "reflection",
        "self-correction",
        "entity-lookup",
        "classify-before-write",
      ],
      monthlyLow: 0.3,
      monthlyHigh: 2.5,
    },
    {
      mode: "complete",
      description: "Everything — query expansion, ingest, dream-cycle, extract-daily",
      features: [
        "embeddings",
        "auto-classify",
        "query-expansion",
        "structured-recall",
        "reflection",
        "self-correction",
        "entity-lookup",
        "classify-before-write",
        "distill",
        "dream-cycle",
        "extract-daily",
        "extract-implicit",
        "consolidate",
        "ingest",
      ],
      monthlyLow: 2.0,
      monthlyHigh: 15.0,
    },
  ];
}
