import type OpenAI from "openai";
import type { ContradictionReviewItem, LlmContradictionDecision } from "../backends/facts-db/contradictions.js";
import { tryParseFirstJsonObject } from "../utils/llm-json-array.js";
import { capTimeoutByMaintenanceRunDeadline, getMaintenanceRunAbortSignal } from "../utils/maintenance-run-deadline.js";
import { chatCompleteWithRetry, resolveMaintenanceChatTimeoutMs } from "./chat.js";

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

const ADJUDICATION_SYSTEM_PROMPT =
  "You adjudicate memory contradictions. Return JSON only with decision, confidence, reason, and optional mergedFactText. " +
  "Use manual_review unless one side is clearly the safer current fact. Never invent facts.";

export interface NliContradictionVerdict {
  verdict: "contradiction" | "entailment" | "neutral";
  confidence: number;
  reason: string;
}

export function parseNliContradictionResponse(content: string): NliContradictionVerdict | null {
  const parsed = tryParseFirstJsonObject(content) as Partial<NliContradictionVerdict> | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.verdict !== "contradiction" && parsed.verdict !== "entailment" && parsed.verdict !== "neutral") {
    return null;
  }
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence)) return null;
  return {
    verdict: parsed.verdict,
    confidence: Math.max(0, Math.min(1, parsed.confidence)),
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

const NLI_SYSTEM_PROMPT =
  "You judge whether two memory statements can both be true at the same time. Return JSON only: " +
  '{"verdict": "contradiction" | "entailment" | "neutral", "confidence": 0..1, "reason": "..."}. ' +
  'Return "contradiction" ONLY when the statements cannot both be true (a direct factual conflict), ' +
  'not when they merely differ in topic, time, or detail. When unsure, return "neutral".';

/** NLI-lite verdict for the nightly free-text contradiction candidates pass (LIVING-MEMORY.md). */
export async function adjudicateNliContradiction(
  openai: OpenAI,
  model: string,
  pair: { newerText: string; olderText: string },
): Promise<NliContradictionVerdict> {
  const userPayload = JSON.stringify({
    task: "Can both statements be true?",
    newerStatement: pair.newerText,
    olderStatement: pair.olderText,
  });
  const content = await chatCompleteWithRetry({
    model,
    content: `${NLI_SYSTEM_PROMPT}\n\n${userPayload}`,
    temperature: 0,
    maxTokens: 300,
    openai,
    label: "memory-hybrid: contradiction-nli",
    feature: "contradiction-nli",
    responseFormat: { type: "json_object" },
    timeoutMs: capTimeoutByMaintenanceRunDeadline(resolveMaintenanceChatTimeoutMs(model)),
    signal: getMaintenanceRunAbortSignal(),
  });
  const parsed = parseNliContradictionResponse(content);
  if (!parsed) {
    throw new Error("LLM returned malformed NLI contradiction JSON.");
  }
  return parsed;
}

export async function adjudicateContradictionWithLlm(
  openai: OpenAI,
  model: string,
  item: ContradictionReviewItem,
): Promise<LlmContradictionDecision> {
  const userPayload = JSON.stringify({
    task: "Adjudicate contradiction",
    contradiction: item,
    allowedDecisions: ["keep_new", "keep_old", "merge", "manual_review"],
  });
  const content = await chatCompleteWithRetry({
    model,
    content: `${ADJUDICATION_SYSTEM_PROMPT}\n\n${userPayload}`,
    temperature: 0,
    maxTokens: 500,
    openai,
    label: "memory-hybrid: adjudicate-contradiction",
    feature: "contradiction-adjudication",
    responseFormat: { type: "json_object" },
    timeoutMs: capTimeoutByMaintenanceRunDeadline(resolveMaintenanceChatTimeoutMs(model)),
    signal: getMaintenanceRunAbortSignal(),
  });
  const parsed = parseContradictionAdjudicationResponse(content);
  if (!parsed) {
    throw new Error("LLM returned malformed contradiction adjudication JSON.");
  }
  return parsed;
}
