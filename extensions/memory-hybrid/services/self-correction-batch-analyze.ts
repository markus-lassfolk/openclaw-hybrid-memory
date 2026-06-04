import type OpenAI from "openai";

import { resolveMiniMaxThinkingMode, type HybridMemoryConfig } from "../config.js";
import { serializeIncidentsForBatchPrompt } from "./batch-incident-analysis.js";
import { CostFeature } from "./cost-feature-labels.js";
import {
  analyzeIncidentBatchWithSplit,
  type IncidentBatchAnalyzeDiagnostics,
  type IncidentBatchLlmResult,
} from "./incident-batch-analyze-core.js";
import { parseSelfCorrectionLLMResponse } from "./self-correction-llm-parser.js";
import type { CorrectionIncident } from "./self-correction-extract.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import type { MiniMaxThinkingMode } from "./chat.js";

export type SelfCorrectionRemediationItem = {
  category: string;
  severity: string;
  remediationType: string;
  remediationContent: string | { text?: string; entity?: string; key?: string; tags?: string[] };
  repeated?: boolean;
  incidentIndex?: number;
};

export type SelfCorrectionBatchAnalyzeDiagnostics = IncidentBatchAnalyzeDiagnostics;

export type SelfCorrectionBatchAnalyzeResult = {
  items: SelfCorrectionRemediationItem[] | null;
  finishReason?: string | null;
  rawContent?: string;
  diagnostics: SelfCorrectionBatchAnalyzeDiagnostics;
};

export type SelfCorrectionBatchLlmResult = IncidentBatchLlmResult;

export const DEFAULT_MINIMAX_SELF_CORRECTION_BATCH_SIZE = 5;
export const DEFAULT_SELF_CORRECTION_BATCH_SIZE = 25;
export const DEFAULT_SELF_CORRECTION_BATCH_DELAY_MS = 250;

export function resolveSelfCorrectionBatchSize(model: string, scCfg: { analysisBatchSize?: number }): number {
  if (typeof scCfg.analysisBatchSize === "number" && scCfg.analysisBatchSize >= 1) {
    return Math.floor(scCfg.analysisBatchSize);
  }
  if (/minimax|m3/i.test(model)) return DEFAULT_MINIMAX_SELF_CORRECTION_BATCH_SIZE;
  return DEFAULT_SELF_CORRECTION_BATCH_SIZE;
}

export function resolveSelfCorrectionBatchDelayMs(scCfg: { batchDelayMs?: number }): number {
  if (typeof scCfg.batchDelayMs === "number" && scCfg.batchDelayMs >= 0) {
    return Math.floor(scCfg.batchDelayMs);
  }
  return DEFAULT_SELF_CORRECTION_BATCH_DELAY_MS;
}

type AnalyzeDeps = {
  model: string;
  modelSource: string;
  openai: OpenAI;
  scFallbackModels: string[];
  maxTokens: number;
  thinkingMode: MiniMaxThinkingMode;
  adaptiveEnabled: boolean;
  adaptiveStatePath?: string;
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void };
  onTransientRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
  attemptAnalysisJsonRepair: (rawContent: string) => Promise<{
    items: SelfCorrectionRemediationItem[] | null;
    fallbacks: number;
  }>;
  llmCall?: (
    batch: CorrectionIncident[],
    batchLabel: string,
    maxTokensOverride?: number,
  ) => Promise<SelfCorrectionBatchLlmResult>;
};

async function parseBatchContent(
  deps: AnalyzeDeps,
  content: string,
  diagnostics: SelfCorrectionBatchAnalyzeDiagnostics,
): Promise<SelfCorrectionRemediationItem[] | null> {
  const parsed = parseSelfCorrectionLLMResponse(content);
  if (parsed !== null) return parsed as SelfCorrectionRemediationItem[];
  diagnostics.parseFailures++;
  try {
    const repaired = await deps.attemptAnalysisJsonRepair(content);
    diagnostics.fallbacks += repaired.fallbacks;
    return repaired.items;
  } catch {
    return null;
  }
}

/**
 * Analyze a batch of incidents with auto-split on under-coverage or output truncation.
 */
export async function analyzeSelfCorrectionIncidentBatchWithSplit(
  deps: AnalyzeDeps & {
    allowSplit?: boolean;
    allowBudgetBump?: boolean;
    depth?: number;
    batchLabel?: string;
  },
  batch: CorrectionIncident[],
): Promise<SelfCorrectionBatchAnalyzeResult> {
  return analyzeIncidentBatchWithSplit(
    {
      ...deps,
      costFeature: CostFeature.selfCorrectionAnalyze,
      costFeatureLabel: `memory-hybrid: self-correction analyze (${deps.batchLabel ?? "batch"})`,
      parseBatchContent: (content, diagnostics) => parseBatchContent(deps, content, diagnostics),
      buildPrompt: (incidents) =>
        fillPrompt(loadPrompt("self-correction-analyze"), {
          incidents_json: serializeIncidentsForBatchPrompt(incidents),
        }),
    },
    batch,
  );
}

export function resolveSelfCorrectionThinkingMode(cfg: HybridMemoryConfig | undefined): MiniMaxThinkingMode {
  return resolveMiniMaxThinkingMode(cfg, "disabled");
}
