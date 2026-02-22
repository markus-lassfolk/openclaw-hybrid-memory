/**
 * Unified chat completion for distill and other LLM features.
 * All LLM calls go through the OpenClaw gateway (openai client); provider-agnostic model fallback (issue #87).
 */

import OpenAI from "openai";
import { capturePluginError } from "./error-reporter.js";

/** True when model name suggests long-context (e.g. Gemini). Used only for token limits. Only "gemini" is matched; "thinking" is not, to avoid false positives with gateway aliases. */
function isLongContextModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("gemini");
}

export async function chatComplete(opts: {
  model: string;
  content: string;
  temperature?: number;
  maxTokens?: number;
  openai: OpenAI;
}): Promise<string> {
  const { model, content, temperature = 0.2, maxTokens } = opts;
  const effectiveMaxTokens = maxTokens ?? distillMaxOutputTokens(model);

  try {
    const resp = await opts.openai.chat.completions.create({
      model,
      messages: [{ role: "user", content }],
      temperature,
      max_tokens: effectiveMaxTokens,
    });
    return resp.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    capturePluginError(error, {
      subsystem: "chat",
      operation: "chatComplete",
      phase: "gateway",
    });
    throw error;
  }
}

export function distillBatchTokenLimit(model: string): number {
  return isLongContextModel(model) ? 500_000 : 80_000;
}

/** Max output tokens for distill/ingest LLM calls. Long-context models (e.g. gateway-routed Gemini) support 65k+; else 8k. */
export function distillMaxOutputTokens(model: string): number {
  return isLongContextModel(model) ? 65_536 : 8000;
}

/**
 * Custom error class that includes retry attempt information.
 */
export class LLMRetryError extends Error {
  constructor(
    message: string,
    public readonly cause: Error,
    public readonly attemptNumber: number,
  ) {
    super(message);
    this.name = "LLMRetryError";
  }
}

/**
 * Retry wrapper for LLM calls with exponential backoff.
 * Retries on failure with increasing delays: 1s, 3s, 9s.
 * On final failure, throws LLMRetryError with attempt number.
 */
export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; label?: string },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxRetries) {
        const retryError = new LLMRetryError(
          `Failed after ${attempt + 1} attempts: ${lastError.message}`,
          lastError,
          attempt + 1,
        );
        capturePluginError(retryError, {
          subsystem: "chat",
          operation: "withLLMRetry",
          retryAttempt: attempt + 1,
        });
        throw retryError;
      }
      const delay = Math.pow(3, attempt) * 1000; // 1s, 3s, 9s
      if (opts?.label) {
        console.warn(`${opts.label}: attempt ${attempt + 1} failed, retrying in ${delay / 1000}s...`);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

/**
 * Wrapper for chatComplete with retry and fallback model support.
 * Tries primary model with retries, then falls back to each fallback model in order.
 * All calls go through the gateway (openai client).
 */
export async function chatCompleteWithRetry(opts: {
  model: string;
  content: string;
  temperature?: number;
  maxTokens?: number;
  openai: OpenAI;
  fallbackModels?: string[];
  label?: string;
}): Promise<string> {
  const { fallbackModels = [], label: rawLabel, maxTokens, ...chatOpts } = opts;
  const label = rawLabel ?? "LLM call";
  const modelsToTry = [opts.model, ...fallbackModels];

  let lastError: Error | undefined;

  for (let i = 0; i < modelsToTry.length; i++) {
    const currentModel = modelsToTry[i];
    const isFallback = i > 0;
    const attemptLabel = isFallback ? `${label} (fallback: ${currentModel})` : label;

    try {
      return await withLLMRetry(
        () => chatComplete({ ...chatOpts, model: currentModel, maxTokens }),
        { maxRetries: 3, label: attemptLabel },
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < modelsToTry.length - 1) {
        console.warn(
          `${label}: model ${currentModel} failed after retries, trying fallback model ${modelsToTry[i + 1]}...`,
        );
      }
    }
  }

  const finalError = lastError ?? new Error("All models failed");
  capturePluginError(finalError, {
    subsystem: "chat",
    operation: "chatCompleteWithRetry",
    phase: "fallback-exhausted",
  });
  throw finalError;
}
