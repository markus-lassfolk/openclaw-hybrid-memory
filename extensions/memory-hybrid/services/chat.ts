/**
 * Unified chat completion for distill and other LLM features.
 * Routes to OpenAI or Gemini based on model name.
 */

import OpenAI from "openai";

/** Exported for tests. */
export function isGeminiModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("gemini") || m.startsWith("models/gemini");
}

function resolveGeminiApiKey(configKey?: string): string | null {
  if (configKey && configKey.trim().length >= 10) {
    if (configKey.startsWith("env:")) {
      const varName = configKey.slice(4).trim();
      return process.env[varName] ?? null;
    }
    return configKey;
  }
  return process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? null;
}

export async function chatComplete(opts: {
  model: string;
  content: string;
  temperature?: number;
  maxTokens?: number;
  openai: OpenAI;
  geminiApiKey?: string;
}): Promise<string> {
  const { model, content, temperature = 0.2, maxTokens } = opts;
  const effectiveMaxTokens = maxTokens ?? distillMaxOutputTokens(model);

  if (isGeminiModel(model)) {
    const apiKey = resolveGeminiApiKey(opts.geminiApiKey);
    if (!apiKey) {
      throw new Error(
        "Gemini API key required for Gemini models. Set plugins.entries[\"openclaw-hybrid-memory\"].config.distill.apiKey, or GOOGLE_API_KEY / GEMINI_API_KEY env var.",
      );
    }
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    const modelId = model.startsWith("models/") ? model : `models/${model}`;
    const response = await ai.models.generateContent({
      model: modelId,
      contents: content,
      config: {
        temperature,
        maxOutputTokens: effectiveMaxTokens,
      },
    });
    const text = response.text;
    if (text == null) {
      throw new Error("Gemini returned no text");
    }
    return text;
  }

  // Retry logic for transient errors (rate limits, 5xx)
  const maxRetries = 2;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await opts.openai.chat.completions.create({
        model,
        messages: [{ role: "user", content }],
        temperature,
        max_tokens: effectiveMaxTokens,
      });
      return resp.choices[0]?.message?.content?.trim() ?? "";
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export function distillBatchTokenLimit(model: string): number {
  if (isGeminiModel(model)) {
    return 500_000;
  }
  return 80_000;
}

/** Max output tokens for distill/ingest LLM calls. Gemini supports 65k+ for long fact lists; OpenAI default 8k. */
export function distillMaxOutputTokens(model: string): number {
  return isGeminiModel(model) ? 65_536 : 8000;
}

/**
 * Retry wrapper for LLM calls with exponential backoff.
 * Retries on failure with increasing delays: 1s, 3s, 9s.
 */
export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; label?: string },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = Math.pow(3, attempt) * 1000; // 1s, 3s, 9s
      if (opts?.label) {
        console.warn(`${opts.label}: attempt ${attempt + 1} failed, retrying in ${delay / 1000}s...`);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}
