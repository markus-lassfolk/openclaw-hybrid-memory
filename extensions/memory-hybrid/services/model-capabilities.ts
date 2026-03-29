/**
 * Per-model capabilities: context window, max output tokens, and batch token limit for distillation.
 * Source: docs/MODEL-REFERENCE.md (Azure Foundry, partners, and other providers).
 * Used by chat.ts for distillBatchTokenLimit and distillMaxOutputTokens; can be used for context-audit or config hints.
 */

interface ModelCapabilities {
  /** Context window (input + output) in tokens. */
  contextWindow: number;
  /** Max output tokens for a single completion (distill, reflection, etc.). */
  maxOutputTokens: number;
  /** Max input tokens to send in one distill batch request (conservative; leaves room for system + output). */
  batchTokenLimitForDistill: number;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 128_000,
  maxOutputTokens: 8_000,
  batchTokenLimitForDistill: 80_000,
};

/** Strip provider prefix (e.g. "google/gemini-2.0-flash" → "gemini-2.0-flash") and lowercase for matching. */
function normalizeModelId(model: string): string {
  const s = model.trim().toLowerCase();
  const slash = s.indexOf("/");
  return slash >= 0 ? s.slice(slash + 1) : s;
}

type Matcher = (normalized: string) => boolean;

/**
 * Catalog: first matching entry wins. Order matters (more specific patterns first).
 * Values from docs/MODEL-REFERENCE.md.
 */
const CAPABILITIES: Array<{ match: Matcher; cap: ModelCapabilities }> = [
  // ——— Gemini (1M+ context) ———
  {
    match: (n) => n.includes("gemini"),
    cap: {
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      batchTokenLimitForDistill: 400_000,
    },
  },

  // ——— GPT-5.4 (1.05M context) ———
  {
    match: (n) => n.startsWith("gpt-5.4"),
    cap: {
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      batchTokenLimitForDistill: 400_000,
    },
  },

  // ——— GPT-5.2-chat / 5.1-chat / 5-chat (128k, 16k out) ———
  {
    match: (n) =>
      n === "gpt-5.2-chat" ||
      n.startsWith("gpt-5.2-chat") ||
      n === "gpt-5.1-chat" ||
      n.startsWith("gpt-5.1-chat") ||
      n === "gpt-5-chat" ||
      n.startsWith("gpt-5-chat"),
    cap: {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      batchTokenLimitForDistill: 80_000,
    },
  },

  // ——— GPT-5.3 / 5.2 / 5.1 / 5 (400k context, 128k out) ———
  {
    match: (n) =>
      n.startsWith("gpt-5.3") ||
      n.startsWith("gpt-5.2") ||
      n.startsWith("gpt-5.1") ||
      n.startsWith("gpt-5-pro") ||
      n.startsWith("gpt-5-codex") ||
      n === "gpt-5" ||
      n.startsWith("gpt-5-mini") ||
      n.startsWith("gpt-5-nano"),
    cap: {
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      batchTokenLimitForDistill: 400_000,
    },
  },

  // ——— o-series (200k in / 100k out) ———
  {
    match: (n) =>
      n.startsWith("o3-pro") ||
      n.startsWith("o4-mini") ||
      n === "o3" ||
      n.startsWith("o3-mini") ||
      n === "o1" ||
      n.startsWith("codex-mini"),
    cap: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      batchTokenLimitForDistill: 200_000,
    },
  },
  {
    match: (n) => n.startsWith("o1-preview"),
    cap: {
      contextWindow: 128_000,
      maxOutputTokens: 32_768,
      batchTokenLimitForDistill: 80_000,
    },
  },
  {
    match: (n) => n.startsWith("o1-mini"),
    cap: {
      contextWindow: 128_000,
      maxOutputTokens: 65_536,
      batchTokenLimitForDistill: 80_000,
    },
  },

  // ——— GPT-4.1 (1M / 128k standard; 32k out) ———
  {
    match: (n) => n.startsWith("gpt-4.1"),
    cap: {
      contextWindow: 128_000,
      maxOutputTokens: 32_768,
      batchTokenLimitForDistill: 128_000,
    },
  },

  // ——— GPT-4o / GPT-4 Turbo (128k, 16k out) ———
  {
    match: (n) =>
      n.startsWith("gpt-4o") || n.startsWith("gpt-4o-mini") || (n.startsWith("gpt-4") && n.includes("turbo")),
    cap: {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      batchTokenLimitForDistill: 80_000,
    },
  },

  // ——— gpt-oss ———
  {
    match: (n) => n.startsWith("gpt-oss"),
    cap: {
      contextWindow: 131_072,
      maxOutputTokens: 131_072,
      batchTokenLimitForDistill: 80_000,
    },
  },

  // ——— Claude (Anthropic): 1M for 4-6, 200k for 4-5 / 4-1 ———
  {
    match: (n) =>
      (n.includes("claude-opus-4-6") || n.includes("claude-sonnet-4-6")) && !n.includes("4-5") && !n.includes("4-1"),
    cap: {
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      batchTokenLimitForDistill: 400_000,
    },
  },
  {
    match: (n) => n.includes("claude-opus") || n.includes("claude-sonnet") || n.includes("claude-haiku"),
    cap: {
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      batchTokenLimitForDistill: 200_000,
    },
  },
  {
    match: (n) => n.includes("claude-3"),
    cap: {
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
      batchTokenLimitForDistill: 80_000,
    },
  },

  // ——— DeepSeek (128k–163k) ———
  {
    match: (n) => n.includes("deepseek-r1") || n.includes("deepseek-v3.2") || n.includes("deepseek-v3.1"),
    cap: {
      contextWindow: 163_840,
      maxOutputTokens: 128_000,
      batchTokenLimitForDistill: 128_000,
    },
  },

  // ——— Model router (Azure): conservative ———
  {
    match: (n) => n.includes("model-router"),
    cap: {
      contextWindow: 200_000,
      maxOutputTokens: 32_768,
      batchTokenLimitForDistill: 80_000,
    },
  },
];

/**
 * Return capabilities for the given model id (with or without provider prefix), or null if unknown.
 */
function getModelCapabilities(model: string): ModelCapabilities | null {
  const normalized = normalizeModelId(model);
  for (const { match, cap } of CAPABILITIES) {
    if (match(normalized)) return cap;
  }
  return null;
}

/**
 * Max input tokens to use for one distill batch request. Conservative so fallback models can handle the same chunk.
 * Returns 80_000 for unknown models.
 */
export function getDistillBatchTokenLimit(model: string): number {
  const cap = getModelCapabilities(model);
  return cap?.batchTokenLimitForDistill ?? DEFAULT_CAPABILITIES.batchTokenLimitForDistill;
}

/**
 * Max output tokens for distill/reflection/ingest LLM calls.
 * Returns 8_000 for unknown models.
 */
export function getDistillMaxOutputTokens(model: string): number {
  const cap = getModelCapabilities(model);
  return cap?.maxOutputTokens ?? DEFAULT_CAPABILITIES.maxOutputTokens;
}

/**
 * Context window in tokens (for hints or context-audit). Returns 128_000 for unknown models.
 */
function getContextWindow(model: string): number {
  const cap = getModelCapabilities(model);
  return cap?.contextWindow ?? DEFAULT_CAPABILITIES.contextWindow;
}

/**
 * True for models that require `max_completion_tokens` instead of `max_tokens` in the API request
 * (e.g. GPT-5+, o-series). Used by chatComplete so direct client calls (verify, etc.) work with Azure Foundry and others.
 */
export function requiresMaxCompletionTokens(model: string): boolean {
  const bare = normalizeModelId(model);
  return /^gpt-5/i.test(bare) || isReasoningModel(model);
}

/**
 * True for o1, o3, o4-mini, etc. — reasoning models that reject temperature/top_p and use max_completion_tokens.
 */
export function isReasoningModel(model: string): boolean {
  const bare = normalizeModelId(model);
  return /^o[0-9]+(?:-[a-z]+)?$/.test(bare);
}
