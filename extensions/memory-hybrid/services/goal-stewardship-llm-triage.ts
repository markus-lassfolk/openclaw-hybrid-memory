/**
 * Optional nano-tier LLM triage for stewardship (cost control).
 */

import type OpenAI from "openai";
import type { HybridMemoryConfig } from "../config.js";
import { getCronModelConfig, getLLMModelPreference } from "../config.js";
import { tryParseFirstJsonObject } from "../utils/llm-json-array.js";
import { capTimeoutByMaintenanceRunDeadline, getMaintenanceRunAbortSignal } from "../utils/maintenance-run-deadline.js";
import { chatCompleteWithRetry, resolveMaintenanceChatTimeoutMs } from "./chat.js";
import { capturePluginError } from "./error-reporter.js";

export async function llmTriageNeedsHeavy(
  openai: OpenAI | undefined,
  cfg: HybridMemoryConfig,
  goalSummaries: string,
): Promise<boolean | null> {
  if (!cfg.goalStewardship.llmTriageOnHeartbeat || !openai) return null;
  try {
    const models = getLLMModelPreference(getCronModelConfig(cfg), "nano");
    const model = models[0];
    if (!model) return null;
    const raw = await chatCompleteWithRetry({
      model,
      content: `Reply with ONLY valid JSON: {"needsHeavy":true or false}. needsHeavy means substantive reasoning or multi-step dispatch is likely needed (not a trivial heartbeat).
Goals summary (truncated):
${goalSummaries.slice(0, 6000)}`,
      maxTokens: 60,
      temperature: 0,
      openai,
      label: "goal-stewardship: llm-triage",
      feature: "goal-stewardship",
      timeoutMs: capTimeoutByMaintenanceRunDeadline(resolveMaintenanceChatTimeoutMs(model)),
      signal: getMaintenanceRunAbortSignal(),
    });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const j = tryParseFirstJsonObject(cleaned) as { needsHeavy?: boolean } | null;
    if (!j) return null;
    return j.needsHeavy === true;
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "goal-stewardship-triage",
      operation: "llmTriageNeedsHeavy",
    });
    return null;
  }
}
