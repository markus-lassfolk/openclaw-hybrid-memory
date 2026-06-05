import type OpenAI from "openai";
import type { ContradictionReviewItem, LlmContradictionDecision } from "../backends/facts-db/contradictions.js";
import { tryParseFirstJsonObject } from "../utils/llm-json-array.js";
import { extractAssistantMessageText } from "../utils/llm-message.js";

export function parseContradictionAdjudicationResponse(content: string): LlmContradictionDecision | null {
  const parsed = tryParseFirstJsonObject(content) as Partial<LlmContradictionDecision> | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  try {
    if (
      parsed.decision !== "keep_new" &&
      parsed.decision !== "keep_old" &&
      parsed.decision !== "merge" &&
      parsed.decision !== "manual_review"
    ) {
      return null;
    }
    if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence)) {
      return null;
    }
    return {
      decision: parsed.decision,
      confidence: parsed.confidence,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      mergedFactText: typeof parsed.mergedFactText === "string" ? parsed.mergedFactText : null,
    };
  } catch {
    return null;
  }
}

export async function adjudicateContradictionWithLlm(
  openai: OpenAI,
  model: string,
  item: ContradictionReviewItem,
): Promise<LlmContradictionDecision> {
  const response = await openai.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You adjudicate memory contradictions. Return JSON only with decision, confidence, reason, and optional mergedFactText. " +
          "Use manual_review unless one side is clearly the safer current fact. Never invent facts.",
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "Adjudicate contradiction",
          contradiction: item,
          allowedDecisions: ["keep_new", "keep_old", "merge", "manual_review"],
        }),
      },
    ],
  });
  const content = extractAssistantMessageText(response.choices[0]?.message).text;
  const parsed = parseContradictionAdjudicationResponse(content);
  if (!parsed) {
    throw new Error("LLM returned malformed contradiction adjudication JSON.");
  }
  return parsed;
}
