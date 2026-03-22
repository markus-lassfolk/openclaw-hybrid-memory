/**
 * Shared HyDE (Hypothetical Document Embeddings) query expansion logic.
 *
 * Extracted to avoid duplication between retrieval-orchestrator.ts and recall-pipeline.ts.
 */

import type OpenAI from "openai";
import type { PendingLLMWarnings } from "./chat.js";
import { chatCompleteWithRetry, is500Like, is404Like, isOllamaOOM } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";
import { getCronModelConfig, getLLMModelPreference } from "../config.js";

export interface HydeOptions {
  /** The raw query text to expand. */
  query: string;
  /** Raw config object for getCronModelConfig. */
  rawCfg: Parameters<typeof getCronModelConfig>[0];
  /** Optional model override (from queryExpansion.model). */
  model?: string;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** OpenAI-compatible client. */
  openai: OpenAI;
  /** Label for logging/telemetry. */
  label?: string;
  /** Pending LLM warnings accumulator. */
  pendingWarnings: PendingLLMWarnings;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Logger for warnings. */
  logger: { warn: (msg: string) => void };
  /** Subsystem name for error reporting. */
  subsystem: string;
  /** Operation name for error reporting. */
  operation: string;
}

/**
 * Run HyDE query expansion: generate a hypothetical answer, then embed it.
 *
 * @returns The expanded text if successful, or the original query on failure.
 */
export async function expandQueryWithHyde(opts: HydeOptions): Promise<string> {
  try {
    const cronCfg = getCronModelConfig(opts.rawCfg);
    const pref = getLLMModelPreference(cronCfg, "nano");
    const hydeModel = opts.model ?? pref[0];
    const fallbackModels = opts.model ? [] : pref.slice(1);
    const hydeContent = await chatCompleteWithRetry({
      model: hydeModel,
      fallbackModels,
      content: `Write a short factual statement (1-2 sentences) that answers: ${opts.query}

Output only the statement, no preamble.`,
      temperature: 0.3,
      maxTokens: 150,
      openai: opts.openai,
      label: opts.label ?? "HyDE",
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      pendingWarnings: opts.pendingWarnings,
    });
    const hydeText = hydeContent.trim();
    if (hydeText.length > 10) {
      return hydeText;
    }
    return opts.query;
  } catch (err) {
    const hydeErr = err instanceof Error ? err : new Error(String(err));
    const isTransient =
      isOllamaOOM(hydeErr) ||
      is500Like(hydeErr) ||
      is404Like(hydeErr) ||
      /timed out|llm request timeout|request was aborted|econnrefused/i.test(hydeErr.message);
    if (!isTransient) {
      capturePluginError(hydeErr, { subsystem: opts.subsystem, operation: opts.operation });
    }
    if (isOllamaOOM(hydeErr)) {
      opts.logger.warn(
        `memory-hybrid: Ollama model OOM during HyDE generation — model requires more memory than available. ` +
          `Using raw query. Consider using a smaller model or configuring a cloud fallback.`,
      );
    } else {
      opts.logger.warn(`memory-hybrid: HyDE generation failed, using raw query: ${err}`);
    }
    return opts.query;
  }
}
