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
  const { model, content, temperature = 0.2, maxTokens = 8000 } = opts;

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
        maxOutputTokens: maxTokens,
      },
    });
    const text = response.text;
    if (text == null) {
      throw new Error("Gemini returned no text");
    }
    return text;
  }

  const resp = await opts.openai.chat.completions.create({
    model,
    messages: [{ role: "user", content }],
    temperature,
    max_tokens: maxTokens,
  });
  return resp.choices[0]?.message?.content?.trim() ?? "";
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
