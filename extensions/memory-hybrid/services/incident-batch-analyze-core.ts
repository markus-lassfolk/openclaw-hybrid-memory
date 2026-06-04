import type OpenAI from "openai";

import { chatCompleteWithAdaptiveMaintenanceRetry } from "./adaptive-maintenance-llm.js";
import { maintenanceMaxOutputTokens, type MiniMaxThinkingMode } from "./chat.js";
import { checkBatchRemediationCoverage } from "./batch-incident-analysis.js";
import type { CostFeature } from "./cost-feature-labels.js";
import { estimateTokens } from "../utils/text.js";

export type IncidentBatchAnalyzeDiagnostics = {
  fallbacks: number;
  parseFailures: number;
  batchSplits: number;
  truncations: number;
  retries: number;
};

export type IncidentBatchLlmResult = {
  content: string;
  fallbacks: number;
  finishReason?: string | null;
};

export type IncidentBatchAnalyzeResult<TItem> = {
  items: TItem[] | null;
  finishReason?: string | null;
  rawContent?: string;
  diagnostics: IncidentBatchAnalyzeDiagnostics;
};

type IncidentBatchAnalyzeDeps<TItem, TIncident> = {
  model: string;
  modelSource: string;
  openai: OpenAI;
  scFallbackModels: string[];
  maxTokens: number;
  thinkingMode: MiniMaxThinkingMode;
  adaptiveEnabled: boolean;
  adaptiveStatePath?: string;
  costFeature: (typeof CostFeature)[keyof typeof CostFeature];
  costFeatureLabel: string;
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void };
  onTransientRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
  parseBatchContent: (
    content: string,
    diagnostics: IncidentBatchAnalyzeDiagnostics,
  ) => Promise<TItem[] | null>;
  buildPrompt: (batch: TIncident[]) => string;
  llmCall?: (
    batch: TIncident[],
    batchLabel: string,
    maxTokensOverride?: number,
  ) => Promise<IncidentBatchLlmResult>;
};

function splitIncidentsInHalf<T>(items: T[]): [T[], T[]] {
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)];
}

function isTransientBatchLlmError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /request was aborted|operation was aborted|llm request timeout|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|connection error/i.test(
    msg,
  );
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function callBatchAnalyzeLlm<TIncident>(
  deps: IncidentBatchAnalyzeDeps<unknown, TIncident>,
  batch: TIncident[],
  batchLabel: string,
  maxTokensOverride: number | undefined,
  diagnostics: IncidentBatchAnalyzeDiagnostics,
): Promise<IncidentBatchLlmResult> {
  if (deps.llmCall) {
    return deps.llmCall(batch, batchLabel, maxTokensOverride);
  }
  const prompt = deps.buildPrompt(batch);
  const effectiveMaxTokens = maxTokensOverride ?? deps.maxTokens;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      deps.logger.info?.(
        `memory-hybrid: incident-batch ${batchLabel}: attempt ${attempt}/4 model=${deps.model} inputTokens≈${estimateTokens(prompt)} maxTokens=${effectiveMaxTokens} thinking=${deps.thinkingMode}`,
      );
      const detail = await chatCompleteWithAdaptiveMaintenanceRetry({
        model: deps.model,
        modelSource: deps.modelSource,
        content: prompt,
        temperature: 0.2,
        maxTokens: effectiveMaxTokens,
        openai: deps.openai,
        fallbackModels: deps.scFallbackModels,
        label: deps.costFeatureLabel,
        feature: deps.costFeature,
        logger: deps.logger,
        adaptiveStatePath: deps.adaptiveStatePath,
        enabled: deps.adaptiveEnabled,
        thinkingMode: deps.thinkingMode,
      });
      return {
        content: detail.content,
        fallbacks: detail.modelUsed !== deps.model ? 1 : 0,
        finishReason: detail.finishReason,
      };
    } catch (err) {
      lastError = err;
      if (!isTransientBatchLlmError(err) || attempt >= 4) throw err;
      const delay = 5000 * 2 ** (attempt - 1);
      diagnostics.retries++;
      deps.onTransientRetry?.({
        attempt,
        delayMs: delay,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      await sleepMs(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function mergeBatchDiagnostics(target: IncidentBatchAnalyzeDiagnostics, source: IncidentBatchAnalyzeDiagnostics): void {
  target.fallbacks += source.fallbacks;
  target.parseFailures += source.parseFailures;
  target.batchSplits += source.batchSplits;
  target.truncations += source.truncations;
  target.retries += source.retries;
}

function rejectIncompleteBatch<TItem>(
  batchLength: number,
  items: TItem[] | null,
  finishReason: string | null | undefined,
  content: string,
  diagnostics: IncidentBatchAnalyzeDiagnostics,
  batchLabel: string,
  logger?: { warn?: (msg: string) => void },
): IncidentBatchAnalyzeResult<TItem> | null {
  const coverage = checkBatchRemediationCoverage(batchLength, items?.length ?? 0);
  if (coverage.ok) return null;
  logger?.warn?.(
    `memory-hybrid: incident-batch ${batchLabel}: ${coverage.reason} expected=${coverage.expected} parsed=${coverage.parsed}`,
  );
  return { items: null, finishReason, rawContent: content, diagnostics };
}

/**
 * Analyze a batch of incidents with auto-split on under-coverage, zero parse, or output truncation.
 */
export async function analyzeIncidentBatchWithSplit<TItem, TIncident>(
  deps: IncidentBatchAnalyzeDeps<TItem, TIncident> & {
    allowSplit?: boolean;
    allowBudgetBump?: boolean;
    depth?: number;
    batchLabel?: string;
  },
  batch: TIncident[],
): Promise<IncidentBatchAnalyzeResult<TItem>> {
  const diagnostics: IncidentBatchAnalyzeDiagnostics = {
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
    const llm = await callBatchAnalyzeLlm(deps, batch, batchLabel, maxTokensOverride, diagnostics);
    diagnostics.fallbacks += llm.fallbacks;
    const items = await deps.parseBatchContent(llm.content, diagnostics);
    return { items, finishReason: llm.finishReason, content: llm.content };
  };

  let { items, finishReason, content } = await runOnce();

  if (items === null) {
    return { items: null, finishReason, rawContent: content, diagnostics };
  }

  const isTruncated = finishReason === "length";
  const underCoverage = batch.length > 0 && items.length > 0 && items.length < batch.length;

  if (isTruncated) diagnostics.truncations++;

  if (
    allowBudgetBump &&
    isTruncated &&
    batch.length > 0 &&
    (underCoverage || items.length < batch.length)
  ) {
    const catalogMax = maintenanceMaxOutputTokens(deps.model);
    const bumped = Math.min(catalogMax, Math.max(deps.maxTokens + 1, Math.ceil(deps.maxTokens * 1.5)));
    if (bumped > deps.maxTokens) {
      deps.logger.info?.(
        `memory-hybrid: incident-batch ${batchLabel}: output truncated (finish=length); retrying with maxTokens=${bumped}`,
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
    (finishReason === "length" || (items.length > 0 && items.length < batch.length));

  if (needsSplit) {
    diagnostics.batchSplits++;
    deps.logger.warn?.(
      `memory-hybrid: incident-batch ${batchLabel}: auto-split expected=${batch.length} parsed=${items.length} finish=${finishReason ?? "stop"}`,
    );
    const [left, right] = splitIncidentsInHalf(batch);
    const leftResult = await analyzeIncidentBatchWithSplit(
      { ...deps, depth: depth + 1, allowBudgetBump: false, batchLabel: `${batchLabel}/L` },
      left,
    );
    const rightResult = await analyzeIncidentBatchWithSplit(
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
    const merged = [...leftResult.items, ...rightResult.items];
    const rejected = rejectIncompleteBatch(batch.length, merged, finishReason, content, diagnostics, batchLabel, deps.logger);
    if (rejected) return rejected;
    return {
      items: merged,
      finishReason:
        leftResult.finishReason === "length" || rightResult.finishReason === "length" ? "length" : finishReason,
      diagnostics,
    };
  }

  const rejected = rejectIncompleteBatch(batch.length, items, finishReason, content, diagnostics, batchLabel, deps.logger);
  if (rejected) return rejected;

  return { items, finishReason, rawContent: content, diagnostics };
}
