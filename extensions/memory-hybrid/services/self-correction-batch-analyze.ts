import type OpenAI from "openai";

import { resolveMiniMaxThinkingMode, type HybridMemoryConfig } from "../config.js";
import { chatCompleteWithAdaptiveMaintenanceRetry } from "./adaptive-maintenance-llm.js";
import { distillMaxOutputTokens, type MiniMaxThinkingMode } from "./chat.js";
import { CostFeature } from "./cost-feature-labels.js";
import { parseSelfCorrectionLLMResponse } from "./self-correction-llm-parser.js";
import type { CorrectionIncident } from "./self-correction-extract.js";
import { fillPrompt, loadPrompt } from "../utils/prompt-loader.js";
import { estimateTokens } from "../utils/text.js";

export type SelfCorrectionRemediationItem = {
  category: string;
  severity: string;
  remediationType: string;
  remediationContent: string | { text?: string; entity?: string; key?: string; tags?: string[] };
  repeated?: boolean;
};

export type SelfCorrectionBatchAnalyzeDiagnostics = {
  fallbacks: number;
  parseFailures: number;
  batchSplits: number;
  truncations: number;
  retries: number;
};

export type SelfCorrectionBatchAnalyzeResult = {
  items: SelfCorrectionRemediationItem[] | null;
  finishReason?: string | null;
  rawContent?: string;
  diagnostics: SelfCorrectionBatchAnalyzeDiagnostics;
};

export const DEFAULT_MINIMAX_SELF_CORRECTION_BATCH_SIZE = 5;
export const DEFAULT_SELF_CORRECTION_BATCH_SIZE = 25;
export const DEFAULT_SELF_CORRECTION_BATCH_DELAY_MS = 250;

export function resolveSelfCorrectionBatchSize(
  model: string,
  scCfg: { analysisBatchSize?: number },
): number {
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

function splitIncidentsInHalf<T>(items: T[]): [T[], T[]] {
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)];
}

function isTransientSelfCorrectionLlmError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /request was aborted|operation was aborted|llm request timeout|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|connection error/i.test(
    msg,
  );
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
  attemptAnalysisJsonRepair: (rawContent: string) => Promise<{
    items: SelfCorrectionRemediationItem[] | null;
    fallbacks: number;
  }>;
};

async function callAnalyzeLlm(
  deps: AnalyzeDeps,
  batch: CorrectionIncident[],
  batchLabel: string,
  maxTokensOverride?: number,
): Promise<{
  content: string;
  fallbacks: number;
  finishReason?: string | null;
}> {
  const prompt = fillPrompt(loadPrompt("self-correction-analyze"), {
    incidents_json: JSON.stringify(batch),
  });
  const effectiveMaxTokens = maxTokensOverride ?? deps.maxTokens;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      deps.logger.info?.(
        `memory-hybrid: self-correction-run ${batchLabel}: attempt ${attempt}/4 model=${deps.model} inputTokens≈${estimateTokens(prompt)} maxTokens=${effectiveMaxTokens} thinking=${deps.thinkingMode}`,
      );
      const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
        model: deps.model,
        modelSource: deps.modelSource,
        content: prompt,
        temperature: 0.2,
        maxTokens: effectiveMaxTokens,
        openai: deps.openai,
        fallbackModels: deps.scFallbackModels,
        label: `memory-hybrid: self-correction analyze (${batchLabel})`,
        feature: CostFeature.selfCorrectionAnalyze,
        logger: deps.logger,
        adaptiveStatePath: deps.adaptiveStatePath,
        enabled: deps.adaptiveEnabled,
        thinkingMode: deps.thinkingMode,
        onRetry: (info) => deps.onRetry?.({ attempt: info.attempt, delayMs: info.delayMs, error: info.error }),
      });
      return {
        content: detail.content,
        fallbacks: detail.modelUsed !== deps.model ? 1 : 0,
        finishReason: detail.finishReason,
      };
    } catch (err) {
      lastError = err;
      if (!isTransientSelfCorrectionLlmError(err) || attempt >= 4) throw err;
      const delay = 5000 * 2 ** (attempt - 1);
      deps.onRetry?.({
        attempt,
        delayMs: delay,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      await sleepMs(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function parseBatchContent(
  deps: AnalyzeDeps,
  batch: CorrectionIncident[],
  content: string,
  diagnostics: SelfCorrectionBatchAnalyzeDiagnostics,
): Promise<SelfCorrectionRemediationItem[] | null> {
  const parsed = parseSelfCorrectionLLMResponse(content);
  if (parsed !== null) return parsed as SelfCorrectionRemediationItem[];
  if (content.trim().length === 0) return [];
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
  const diagnostics: SelfCorrectionBatchAnalyzeDiagnostics = {
    fallbacks: 0,
    parseFailures: 0,
    batchSplits: 0,
    truncations: 0,
    retries: 0,
  };
  const depth = deps.depth ?? 0;
  const batchLabel = deps.batchLabel ?? `depth=${depth} incidents=${batch.length}`;
  const allowSplit = deps.allowSplit !== false;
  const allowBudgetBump = deps.allowBudgetBump !== false;

  const runOnce = async (maxTokensOverride?: number) => {
    const llm = await callAnalyzeLlm(deps, batch, batchLabel, maxTokensOverride);
    diagnostics.fallbacks += llm.fallbacks;
    const items = await parseBatchContent(deps, batch, llm.content, diagnostics);
    return { items, finishReason: llm.finishReason, content: llm.content };
  };

  let { items, finishReason, content } = await runOnce();

  if (items === null) {
    return { items: null, finishReason, rawContent: content, diagnostics };
  }

  const isTruncated = finishReason === "length";
  const underCoverage = batch.length > 0 && items.length > 0 && items.length < batch.length;
  const zeroWithIncidents = batch.length > 0 && items.length === 0;

  if (isTruncated) diagnostics.truncations++;

  if (
    allowBudgetBump &&
    isTruncated &&
    batch.length > 0 &&
    (underCoverage || zeroWithIncidents || items.length < batch.length)
  ) {
    const catalogMax = distillMaxOutputTokens(deps.model);
    const bumped = Math.min(catalogMax, Math.max(deps.maxTokens + 1, Math.ceil(deps.maxTokens * 1.5)));
    if (bumped > deps.maxTokens) {
      deps.logger.info?.(
        `memory-hybrid: self-correction-run ${batchLabel}: output truncated (finish=length); retrying with maxTokens=${bumped}`,
      );
      const retried = await runOnce(bumped);
      if (retried.items !== null) {
        items = retried.items;
        finishReason = retried.finishReason;
        content = retried.content;
      }
    }
  }

  const needsSplit =
    allowSplit &&
    batch.length > 1 &&
    (finishReason === "length" || (batch.length > 0 && items.length < batch.length));

  if (needsSplit) {
    diagnostics.batchSplits++;
    deps.logger.warn?.(
      `memory-hybrid: self-correction-run ${batchLabel}: auto-split expected=${batch.length} parsed=${items.length} finish=${finishReason ?? "stop"}`,
    );
    const [left, right] = splitIncidentsInHalf(batch);
    const leftResult = await analyzeSelfCorrectionIncidentBatchWithSplit(
      { ...deps, depth: depth + 1, allowBudgetBump: false, batchLabel: `${batchLabel}/L` },
      left,
    );
    const rightResult = await analyzeSelfCorrectionIncidentBatchWithSplit(
      { ...deps, depth: depth + 1, allowBudgetBump: false, batchLabel: `${batchLabel}/R` },
      right,
    );
    mergeBatchDiagnostics(diagnostics, leftResult.diagnostics);
    mergeBatchDiagnostics(diagnostics, rightResult.diagnostics);
    if (leftResult.items === null || rightResult.items === null) {
      return {
        items: null,
        finishReason,
        rawContent: leftResult.rawContent ?? rightResult.rawContent,
        diagnostics,
      };
    }
    return {
      items: [...leftResult.items, ...rightResult.items],
      finishReason: leftResult.finishReason === "length" || rightResult.finishReason === "length" ? "length" : finishReason,
      diagnostics,
    };
  }

  return { items, finishReason, rawContent: content, diagnostics };
}

function mergeBatchDiagnostics(
  target: SelfCorrectionBatchAnalyzeDiagnostics,
  source: SelfCorrectionBatchAnalyzeDiagnostics,
): void {
  target.fallbacks += source.fallbacks;
  target.parseFailures += source.parseFailures;
  target.batchSplits += source.batchSplits;
  target.truncations += source.truncations;
  target.retries += source.retries;
}

export function resolveSelfCorrectionThinkingMode(cfg: HybridMemoryConfig | undefined): MiniMaxThinkingMode {
  return resolveMiniMaxThinkingMode(cfg, "disabled");
}
