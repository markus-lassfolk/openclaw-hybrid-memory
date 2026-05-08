/**
 * Optional nano-tier LLM triage for stewardship (cost control).
 */

import type OpenAI from "openai";
import type { HybridMemoryConfig } from "../config.js";
import { getCronModelConfig, getLLMModelPreference } from "../config.js";
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
    const res = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: `Reply with ONLY valid JSON: {"needsHeavy":true or false}. needsHeavy means substantive reasoning or multi-step dispatch is likely needed (not a trivial heartbeat).
Goals summary (truncated):
${goalSummaries.slice(0, 6000)}`,
        },
      ],
      max_tokens: 60,
      temperature: 0,
    });
    const text = (res.choices[0]?.message?.content ?? "").trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const j = JSON.parse(cleaned) as { needsHeavy?: boolean };
    return j.needsHeavy === true;
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "goal-stewardship-triage",
      operation: "llmTriageNeedsHeavy",
    });
    return null;
  }
}
