import OpenAI from "openai";
import { analyzeSelfCorrectionIncidentBatchWithSplit } from "../../services/self-correction-batch-analyze.js";
import { analyzeReinforcementIncidentBatchWithSplit } from "../../services/reinforcement-batch-analyze.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "../../services/adaptive-maintenance-llm.js";
import {
  chatCompleteWithRetryDetailed,
  maintenanceMaxOutputTokens,
  distillMaxOutputTokens,
  resolveMaintenanceChatTimeoutMs,
  type MiniMaxThinkingMode,
} from "../../services/chat.js";
import { CostFeature } from "../../services/cost-feature-labels.js";
import { fillPrompt, loadPrompt } from "../../utils/prompt-loader.js";
import { estimateTokens } from "../../utils/text.js";
import type { AbCellMetrics, AbModelId, AbTaskId, AbThinkingMode } from "./types.js";
import { MODELS } from "./types.js";
import type { AbCorpus } from "./corpus.js";

export type RunCellOpts = {
  openai: OpenAI;
  corpus: AbCorpus;
  task: AbTaskId;
  model: AbModelId;
  thinking: AbThinkingMode;
};

function toThinkingMode(t: AbThinkingMode): MiniMaxThinkingMode | undefined {
  if (t === "enabled") return "adaptive";
  return t;
}

function preview(text: string, max = 2000): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export async function runAbCell(opts: RunCellOpts): Promise<AbCellMetrics> {
  const { openai, corpus, task, model, thinking } = opts;
  const started = Date.now();
  const thinkingMode = toThinkingMode(thinking);
  const base: Omit<AbCellMetrics, "ok" | "latencyMs" | "operational"> = {
    task,
    model,
    thinking,
  };

  try {
    switch (task) {
      case "self-correction":
        return await runSelfCorrectionCell(openai, corpus, model, thinkingMode, started, base);
      case "reinforcement":
        return await runReinforcementCell(openai, corpus, model, thinkingMode, started, base);
      case "distill":
        return await runDistillCell(openai, corpus, model, thinkingMode, started, base);
      case "reflection":
        return await runReflectionCell(openai, corpus, model, thinkingMode, started, base);
      case "consolidation":
        return await runConsolidationCell(openai, corpus, model, thinkingMode, started, base);
      default:
        throw new Error(`Unknown task: ${task}`);
    }
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: String(err),
      latencyMs: Date.now() - started,
      operational: {},
    };
  }
}

async function runSelfCorrectionCell(
  openai: OpenAI,
  corpus: AbCorpus,
  model: AbModelId,
  thinkingMode: MiniMaxThinkingMode | undefined,
  started: number,
  base: Omit<AbCellMetrics, "ok" | "latencyMs" | "operational">,
): Promise<AbCellMetrics> {
  const incidents = corpus.selfCorrectionIncidents.slice(0, 8);
  const maxTokens = maintenanceMaxOutputTokens(model);
  const result = await analyzeSelfCorrectionIncidentBatchWithSplit(
    {
      model,
      modelSource: "ab-maintenance",
      openai,
      scFallbackModels: [],
      maxTokens,
      thinkingMode: thinkingMode ?? "disabled",
      adaptiveEnabled: false,
      logger: {},
      attemptAnalysisJsonRepair: async () => ({ items: null, fallbacks: 0 }),
    },
    incidents,
  );
  const expected = incidents.length;
  const parsed = result.items?.length ?? 0;
  return {
    ...base,
    ok: parsed === expected && result.items !== null,
    latencyMs: Date.now() - started,
    inputTokensEst: estimateTokens(JSON.stringify(incidents)),
    outputTokensEst: parsed * 200,
    operational: {
      expected,
      parsed,
      coveragePct: expected > 0 ? Math.round((100 * parsed) / expected) : 100,
      parseFailures: result.diagnostics.parseFailures,
      batchSplits: result.diagnostics.batchSplits,
      truncations: result.diagnostics.truncations,
      retries: result.diagnostics.retries,
      finishReason: result.finishReason ?? "unknown",
    },
    outputPreview: preview(JSON.stringify(result.items ?? null)),
  };
}

async function runReinforcementCell(
  openai: OpenAI,
  corpus: AbCorpus,
  model: AbModelId,
  thinkingMode: MiniMaxThinkingMode | undefined,
  started: number,
  base: Omit<AbCellMetrics, "ok" | "latencyMs" | "operational">,
): Promise<AbCellMetrics> {
  const incidents = corpus.reinforcementIncidents.slice(0, 8);
  if (incidents.length === 0) {
    return {
      ...base,
      ok: true,
      latencyMs: Date.now() - started,
      operational: { skipped: true, reason: "no reinforcement incidents in corpus" },
      outputPreview: "(skipped — empty corpus)",
    };
  }
  const maxTokens = maintenanceMaxOutputTokens(model);
  const result = await analyzeReinforcementIncidentBatchWithSplit(
    {
      model,
      modelSource: "ab-maintenance",
      openai,
      fallbackModels: [],
      maxTokens,
      adaptiveEnabled: false,
      thinkingMode: thinkingMode ?? "disabled",
      logger: {},
      attemptAnalysisJsonRepair: async () => ({ items: null, fallbacks: 0 }),
    },
    incidents,
  );
  const expected = incidents.length;
  const parsed = result.items?.length ?? 0;
  return {
    ...base,
    ok: parsed === expected && result.items !== null,
    latencyMs: Date.now() - started,
    operational: {
      expected,
      parsed,
      coveragePct: expected > 0 ? Math.round((100 * parsed) / expected) : 100,
      parseFailures: result.diagnostics.parseFailures,
      batchSplits: result.diagnostics.batchSplits,
      truncations: result.diagnostics.truncations,
      retries: result.diagnostics.retries,
    },
    outputPreview: preview(JSON.stringify(result.items ?? null)),
  };
}

async function runDistillCell(
  openai: OpenAI,
  corpus: AbCorpus,
  model: AbModelId,
  thinkingMode: MiniMaxThinkingMode | undefined,
  started: number,
  base: Omit<AbCellMetrics, "ok" | "latencyMs" | "operational">,
): Promise<AbCellMetrics> {
  const promptPrefix = loadPrompt("distill-sessions");
  const userContent = `${promptPrefix}\n\n${corpus.distillText.slice(0, 80_000)}`;
  const detail = await chatCompleteWithRetryDetailed({
    model,
    content: userContent,
    temperature: 0.2,
    maxTokens: distillMaxOutputTokens(model),
    openai,
    fallbackModels: [],
    label: "ab-maintenance: distill",
    thinkingMode,
    timeoutMs: resolveMaintenanceChatTimeoutMs(model, thinkingMode),
  });
  const lines = detail.content.split("\n").filter((l) => l.trim().startsWith("{"));
  const parsedLines = lines.filter((l) => {
    try {
      JSON.parse(l);
      return true;
    } catch {
      return false;
    }
  });
  return {
    ...base,
    ok: parsedLines.length >= 3 && detail.finishReason !== "length",
    latencyMs: Date.now() - started,
    inputTokensEst: estimateTokens(userContent),
    operational: {
      jsonlLines: parsedLines.length,
      finishReason: detail.finishReason ?? "unknown",
      truncated: detail.finishReason === "length",
    },
    outputPreview: preview(detail.content),
  };
}

async function runReflectionCell(
  openai: OpenAI,
  corpus: AbCorpus,
  model: AbModelId,
  thinkingMode: MiniMaxThinkingMode | undefined,
  started: number,
  base: Omit<AbCellMetrics, "ok" | "latencyMs" | "operational">,
): Promise<AbCellMetrics> {
  const factLines = corpus.factsSample.facts.slice(0, 60).map((f) => `[${f.category}] ${f.text.slice(0, 300)}`);
  const prompt = fillPrompt(loadPrompt("reflection"), { window: "30", facts: factLines.join("\n") });
  const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
    model,
    modelSource: "ab-maintenance",
    content: prompt,
    temperature: 0.3,
    maxTokens: maintenanceMaxOutputTokens(model),
    openai,
    fallbackModels: model === MODELS.m3 ? [MODELS.m27Highspeed] : [MODELS.m3],
    label: "ab-maintenance: reflection",
    feature: CostFeature.reflection,
    logger: {},
    enabled: false,
    thinkingMode: thinkingMode ?? "disabled",
  });
  const patterns = detail.content.split("\n").filter((l) => /^PATTERN:\s/.test(l.trim()));
  return {
    ...base,
    ok: patterns.length >= 2,
    latencyMs: Date.now() - started,
    inputTokensEst: estimateTokens(prompt),
    operational: {
      patternCount: patterns.length,
      finishReason: detail.finishReason ?? "unknown",
    },
    outputPreview: preview(detail.content),
  };
}

async function runConsolidationCell(
  openai: OpenAI,
  corpus: AbCorpus,
  model: AbModelId,
  thinkingMode: MiniMaxThinkingMode | undefined,
  started: number,
  base: Omit<AbCellMetrics, "ok" | "latencyMs" | "operational">,
): Promise<AbCellMetrics> {
  const cluster = corpus.factsSample.consolidationClusters[0];
  if (!cluster || cluster.length < 2) {
    return {
      ...base,
      ok: false,
      error: "no consolidation cluster in facts sample",
      latencyMs: Date.now() - started,
      operational: {},
    };
  }
  const factsList = cluster.map((f, i) => `${i + 1}. ${f.text}`).join("\n");
  const prompt = fillPrompt(loadPrompt("consolidate"), { facts_list: factsList });
  const detail = await chatCompleteWithRetryDetailed({
    model,
    content: prompt,
    temperature: 0,
    maxTokens: 300,
    openai,
    fallbackModels: [],
    label: "ab-maintenance: consolidation",
    thinkingMode,
    timeoutMs: resolveMaintenanceChatTimeoutMs(model, thinkingMode),
  });
  const merged = detail.content.trim();
  return {
    ...base,
    ok: merged.length >= 20 && merged.length <= 800,
    latencyMs: Date.now() - started,
    inputTokensEst: estimateTokens(prompt),
    operational: {
      mergedChars: merged.length,
      finishReason: detail.finishReason ?? "unknown",
    },
    outputPreview: preview(merged),
  };
}
