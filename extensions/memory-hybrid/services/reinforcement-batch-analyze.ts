import type OpenAI from "openai";

import type { SelfCorrectionBatchSettings } from "./self-correction-batch-analyze.js";
import { serializeIncidentsForBatchPrompt } from "./batch-incident-analysis.js";
import { CostFeature } from "./cost-feature-labels.js";
import {
  analyzeIncidentBatchWithSplit,
  type IncidentBatchAnalyzeDiagnostics,
  type IncidentBatchLlmResult,
} from "./incident-batch-analyze-core.js";
import type { ReinforcementIncident } from "./reinforcement-extract.js";
import type { MiniMaxThinkingMode } from "./chat.js";
import { parseStructuredItemsAcceptingEmpty } from "../utils/llm-json-array.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";

export type ReinforcementRemediationItem = {
  category: string;
  severity: string;
  remediationType: string;
  remediationContent:
    | string
    | {
        text?: string;
        entity?: string;
        key?: string;
        tags?: string[];
        taskPattern?: string;
        targetFile?: string;
        suggestedChange?: string;
      };
  incidentIndex?: number;
};

export type ReinforcementBatchAnalyzeDiagnostics = IncidentBatchAnalyzeDiagnostics;

export type ReinforcementBatchAnalyzeResult = {
  items: ReinforcementRemediationItem[] | null;
  finishReason?: string | null;
  rawContent?: string;
  diagnostics: ReinforcementBatchAnalyzeDiagnostics;
};

export type ReinforcementBatchLlmResult = IncidentBatchLlmResult;

export const DEFAULT_REINFORCEMENT_BATCH_SIZE = 25;
export const DEFAULT_MINIMAX_REINFORCEMENT_BATCH_SIZE = 1;

export function resolveReinforcementAnalysisBatchSize(
  model: string,
  reinfCfg: { analysisBatchSize?: number },
  scCfg?: SelfCorrectionBatchSettings,
): number {
  const configured = reinfCfg.analysisBatchSize ?? scCfg?.analysisBatchSize;
  if (typeof configured === "number" && configured >= 1) return Math.floor(configured);
  if (/minimax|m3/i.test(model)) return DEFAULT_MINIMAX_REINFORCEMENT_BATCH_SIZE;
  return DEFAULT_REINFORCEMENT_BATCH_SIZE;
}

function isReinforcementRemediationItem(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  return typeof (item as Record<string, unknown>).remediationType === "string";
}

type AnalyzeDeps = {
  model: string;
  modelSource: string;
  openai: OpenAI;
  fallbackModels: string[];
  maxTokens: number;
  adaptiveEnabled: boolean;
  adaptiveStatePath?: string;
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void };
  thinkingMode?: MiniMaxThinkingMode;
  onTransientRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
  attemptAnalysisJsonRepair: (rawContent: string) => Promise<{
    items: ReinforcementRemediationItem[] | null;
    fallbacks: number;
  }>;
  llmCall?: (
    batch: ReinforcementIncident[],
    batchLabel: string,
    maxTokensOverride?: number,
  ) => Promise<ReinforcementBatchLlmResult>;
};

async function parseBatchContent(
  deps: AnalyzeDeps,
  content: string,
  diagnostics: ReinforcementBatchAnalyzeDiagnostics,
): Promise<ReinforcementRemediationItem[] | null> {
  const parsed = parseStructuredItemsAcceptingEmpty(content, isReinforcementRemediationItem);
  if (parsed !== null) return parsed as ReinforcementRemediationItem[];
  diagnostics.parseFailures++;
  try {
    const repaired = await deps.attemptAnalysisJsonRepair(content);
    diagnostics.fallbacks += repaired.fallbacks;
    if (repaired.items !== null) return repaired.items;
  } catch {
    return null;
  }
  return null;
}

export async function analyzeReinforcementIncidentBatchWithSplit(
  deps: AnalyzeDeps & {
    allowSplit?: boolean;
    allowBudgetBump?: boolean;
    depth?: number;
    batchLabel?: string;
    llmCall?: AnalyzeDeps["llmCall"];
  },
  batch: ReinforcementIncident[],
): Promise<ReinforcementBatchAnalyzeResult> {
  return analyzeIncidentBatchWithSplit(
    {
      ...deps,
      scFallbackModels: deps.fallbackModels,
      thinkingMode: deps.thinkingMode ?? "disabled",
      costFeature: CostFeature.extractReinforcement,
      costFeatureLabel: `memory-hybrid: reinforcement analyze (${deps.batchLabel ?? "batch"})`,
      parseBatchContent: (content, diagnostics) => parseBatchContent(deps, content, diagnostics),
      buildPrompt: (incidents) =>
        fillPrompt(loadPrompt("reinforcement-analyze"), {
          incidents_json: serializeIncidentsForBatchPrompt(incidents),
        }),
    },
    batch,
  );
}
