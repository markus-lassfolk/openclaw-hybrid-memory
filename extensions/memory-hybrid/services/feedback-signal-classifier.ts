/**
 * Hybrid LLM classifier for user feedback signals (correction, frustration, praise, directive).
 */
import type OpenAI from "openai";

import { chatCompleteWithAdaptiveMaintenanceRetry } from "./adaptive-maintenance-llm.js";
import { CostFeature } from "./cost-feature-labels.js";
import type { MiniMaxThinkingMode } from "./chat.js";
import { parseStructuredItemsAcceptingEmpty } from "../utils/llm-json-array.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { insertSignalClassification } from "./signal-classification-store.js";
import type { DatabaseSync } from "node:sqlite";
import type { CorrectionIncident } from "./self-correction-extract.js";

export type FeedbackSignalVerdict = "correction" | "frustration" | "praise" | "directive" | "neutral";

export type FeedbackSignalTurn = {
  turnIndex: number;
  sessionFile: string;
  userMessage: string;
  precedingAssistant: string;
  followingAssistant?: string;
  source: "regex" | "implicit" | "heuristic";
};

export type FeedbackSignalClassification = {
  turnIndex: number;
  verdict: FeedbackSignalVerdict;
  polarity: "negative" | "positive" | "neutral";
  confidence: number;
  categories: string[];
  explanation: string;
  recommendedPipeline: "self-correction" | "implicit" | "reinforcement" | "none";
};

const VALID_VERDICTS = new Set<string>(["correction", "frustration", "praise", "directive", "neutral"]);

function isClassificationItem(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const row = item as Record<string, unknown>;
  return typeof row.turnIndex === "number" && typeof row.verdict === "string" && VALID_VERDICTS.has(row.verdict);
}

function normalizeClassification(item: Record<string, unknown>): FeedbackSignalClassification {
  const verdict = String(item.verdict) as FeedbackSignalVerdict;
  const polarityRaw = String(item.polarity ?? "neutral");
  const polarity = polarityRaw === "negative" || polarityRaw === "positive" ? polarityRaw : ("neutral" as const);
  const confidence = Number(item.confidence);
  const categories = Array.isArray(item.categories)
    ? item.categories.filter((c): c is string => typeof c === "string").slice(0, 8)
    : [];
  const pipelineRaw = String(item.recommendedPipeline ?? "none");
  const recommendedPipeline =
    pipelineRaw === "self-correction" ||
    pipelineRaw === "implicit" ||
    pipelineRaw === "reinforcement" ||
    pipelineRaw === "none"
      ? pipelineRaw
      : "none";
  return {
    turnIndex: Number(item.turnIndex),
    verdict,
    polarity,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    categories,
    explanation: String(item.explanation ?? "").slice(0, 200),
    recommendedPipeline,
  };
}

export async function classifyFeedbackSignalBatch(opts: {
  turns: FeedbackSignalTurn[];
  openai: OpenAI;
  model: string;
  modelSource?: string;
  fallbackModels?: string[];
  thinkingMode?: MiniMaxThinkingMode;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<{ classifications: FeedbackSignalClassification[]; modelUsed: string }> {
  if (opts.turns.length === 0) {
    return { classifications: [], modelUsed: opts.model };
  }
  const payload = opts.turns.map((t) => ({
    turnIndex: t.turnIndex,
    source: t.source,
    sessionFile: t.sessionFile,
    userMessage: t.userMessage.slice(0, 600),
    precedingAssistant: t.precedingAssistant.slice(0, 400),
    followingAssistant: t.followingAssistant?.slice(0, 400) ?? "",
  }));
  const prompt = fillPrompt(loadPrompt("feedback-signal-classify"), {
    turns_json: JSON.stringify(payload),
  });
  const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
    model: opts.model,
    modelSource: opts.modelSource ?? "maintenance",
    content: prompt,
    temperature: 0.2,
    maxTokens: 2000,
    openai: opts.openai,
    fallbackModels: opts.fallbackModels ?? [],
    label: "memory-hybrid: feedback-signal-classify",
    feature: CostFeature.feedbackSignalClassify,
    thinkingMode: opts.thinkingMode ?? "disabled",
    responseFormat: { type: "json_object" },
    logger: opts.logger ?? {},
  });
  let parsed = parseStructuredItemsAcceptingEmpty(detail.content, isClassificationItem);
  if (parsed === null) {
    const envelopeMatch = detail.content.match(/\{[\s\S]*"turns"[\s\S]*\}/);
    if (envelopeMatch) {
      try {
        const env = JSON.parse(envelopeMatch[0]) as { turns?: unknown[] };
        if (Array.isArray(env.turns)) {
          parsed = env.turns.filter(isClassificationItem);
        }
      } catch {
        parsed = [];
      }
    } else {
      parsed = [];
    }
  }
  const classifications = (parsed ?? []).map((item) => normalizeClassification(item as Record<string, unknown>));
  return { classifications, modelUsed: detail.modelUsed };
}

export function turnToCorrectionIncident(turn: FeedbackSignalTurn): CorrectionIncident {
  return {
    userMessage: turn.userMessage,
    precedingAssistant: turn.precedingAssistant,
    followingAssistant: turn.followingAssistant ?? "",
    sessionFile: turn.sessionFile,
  };
}

export function isSelfCorrectionClassification(c: FeedbackSignalClassification, minConfidence: number): boolean {
  return (
    (c.verdict === "correction" || c.verdict === "frustration") &&
    c.confidence >= minConfidence &&
    (c.recommendedPipeline === "self-correction" || c.recommendedPipeline === "none")
  );
}

export async function classifyAndFilterCorrectionIncidents(opts: {
  incidents: CorrectionIncident[];
  openai: OpenAI;
  model: string;
  fallbackModels?: string[];
  minConfidence: number;
  batchSize: number;
  factsDb?: { getRawDb?(): DatabaseSync | undefined | null };
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}): Promise<{ incidents: CorrectionIncident[]; classifications: FeedbackSignalClassification[] }> {
  const turns: FeedbackSignalTurn[] = opts.incidents.map((inc, idx) => ({
    turnIndex: idx,
    sessionFile: inc.sessionFile,
    userMessage: inc.userMessage,
    precedingAssistant: inc.precedingAssistant,
    followingAssistant: inc.followingAssistant,
    source: "regex" as const,
  }));
  const allClassifications: FeedbackSignalClassification[] = [];
  const kept: CorrectionIncident[] = [];
  const rawDb = opts.factsDb?.getRawDb?.() ?? null;

  for (let i = 0; i < turns.length; i += opts.batchSize) {
    const batchSlice = turns.slice(i, i + opts.batchSize);
    const batch = batchSlice.map((t, localIdx) => ({ ...t, turnIndex: localIdx }));
    const { classifications, modelUsed } = await classifyFeedbackSignalBatch({
      turns: batch,
      openai: opts.openai,
      model: opts.model,
      fallbackModels: i === 0 ? opts.fallbackModels : [],
      logger: opts.logger,
    });
    allClassifications.push(...classifications);
    for (const c of classifications) {
      const turn = batch[c.turnIndex];
      if (!turn) continue;
      if (rawDb) {
        insertSignalClassification(rawDb, {
          sessionFile: turn.sessionFile,
          turnIndex: turn.turnIndex,
          source: turn.source,
          verdict: c.verdict,
          polarity: c.polarity,
          confidence: c.confidence,
          categories: c.categories,
          explanation: c.explanation,
          recommendedPipeline: c.recommendedPipeline,
          routedTo: isSelfCorrectionClassification(c, opts.minConfidence) ? "self-correction" : null,
          model: modelUsed,
          userMessagePreview: turn.userMessage.slice(0, 120),
        });
      }
      if (isSelfCorrectionClassification(c, opts.minConfidence)) {
        kept.push(turnToCorrectionIncident(turn));
      }
    }
  }

  opts.logger?.info?.(
    `memory-hybrid: feedback-signal-classify — ${kept.length}/${opts.incidents.length} incidents kept after LLM filter (minConfidence=${opts.minConfidence})`,
  );
  return { incidents: kept, classifications: allClassifications };
}
