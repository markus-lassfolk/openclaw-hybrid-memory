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
  "openai/gpt-4.1-nano": { inputPer1M: 0.10, outputPer1M: 0.40 },
  "openai/gpt-4.1-mini": { inputPer1M: 0.40, outputPer1M: 1.60 },
  "openai/gpt-4o": { inputPer1M: 2.50, outputPer1M: 10.00 },
  "openai/gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.60 },
  "openai/o3": { inputPer1M: 2.00, outputPer1M: 8.00 },
  "openai/o3-mini": { inputPer1M: 1.10, outputPer1M: 4.40 },
  "openai/gpt-5.4": { inputPer1M: 2.00, outputPer1M: 8.00 },
  // Google
  "google/gemini-2.0-flash-lite": { inputPer1M: 0.075, outputPer1M: 0.30 },
  "google/gemini-2.0-flash": { inputPer1M: 0.10, outputPer1M: 0.40 },
  "google/gemini-3.1-pro-preview": { inputPer1M: 1.25, outputPer1M: 10.00 },
  // Anthropic
  "anthropic/claude-sonnet-4-6": { inputPer1M: 3.00, outputPer1M: 15.00 },
  "anthropic/claude-opus-4-6": { inputPer1M: 15.00, outputPer1M: 75.00 },
  "anthropic/claude-haiku-3.5": { inputPer1M: 0.80, outputPer1M: 4.00 },
  // MiniMax
  "minimax/MiniMax-M2.5": { inputPer1M: 0.20, outputPer1M: 1.10 },
};

/** Lowercased index built once at module load for O(1) case-insensitive lookup. */
const MODEL_PRICING_LOWER: Record<string, ModelPricing> = Object.fromEntries(
  Object.entries(MODEL_PRICING).map(([k, v]) => [k.toLowerCase(), v]),
);

/**
 * Look up pricing for a model. Returns null if the model is not in the table.
 * Model name is matched case-insensitively.
 */
export function getModelPricing(model: string): ModelPricing | null {
  // Direct match first (fastest path)
  if (model in MODEL_PRICING) return MODEL_PRICING[model]!;
  // O(1) case-insensitive lookup via pre-built lowercase index
  return MODEL_PRICING_LOWER[model.toLowerCase()] ?? null;
}

/**
 * Estimate cost in USD for a given model and token counts.
 * Returns null if the model is not in the pricing table.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M;
}

// ---------------------------------------------------------------------------
// Config-mode cost estimates
// ---------------------------------------------------------------------------

export interface ModeEstimate {
  mode: "essential" | "normal" | "expert" | "full";
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
 * Estimates are based on typical usage patterns with the default cheapest model
 * (openai/gpt-4.1-nano at $0.10/$0.40 per 1M tokens). Actual costs depend on
 * usage volume and model selection.
 */
export function getModeCostEstimates(): ModeEstimate[] {
  return [
    {
      mode: "essential",
      description: "Minimal — embeddings only, no LLM features",
      features: ["embeddings", "structured-recall"],
      monthlyLow: 0.00,
      monthlyHigh: 0.05,
    },
    {
      mode: "normal",
      description: "Standard — auto-classify + query-expansion + HyDE",
      features: ["embeddings", "auto-classify", "query-expansion", "hyde", "structured-recall"],
      monthlyLow: 0.05,
      monthlyHigh: 0.50,
    },
    {
      mode: "expert",
      description: "Full intelligence — adds reflection, self-correction, cross-agent learning",
      features: [
        "embeddings", "auto-classify", "query-expansion", "hyde", "structured-recall",
        "reflection", "self-correction", "cross-agent-learning", "tool-effectiveness",
      ],
      monthlyLow: 0.50,
      monthlyHigh: 3.00,
    },
    {
      mode: "full",
      description: "Everything — all features including distill, dream-cycle, extract-daily",
      features: [
        "embeddings", "auto-classify", "query-expansion", "hyde", "structured-recall",
        "reflection", "self-correction", "cross-agent-learning", "tool-effectiveness",
        "distill", "dream-cycle", "extract-daily", "extract-implicit", "consolidate",
      ],
      monthlyLow: 3.00,
      monthlyHigh: 15.00,
    },
  ];
}

