import type OpenAI from "openai";
import type { ContradictionReviewItem, LlmContradictionDecision } from "../backends/facts-db/contradictions.js";

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function parseContradictionAdjudicationResponse(content: string): LlmContradictionDecision | null {
  const rawJson = extractJsonObject(content);
  if (!rawJson) return null;

  try {
    const parsed = JSON.parse(rawJson) as Partial<LlmContradictionDecision>;
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
  const content = response.choices[0]?.message?.content;
  const parsed = parseContradictionAdjudicationResponse(typeof content === "string" ? content : "");
  if (!parsed) {
    throw new Error("LLM returned malformed contradiction adjudication JSON.");
  }
  return parsed;
}
