import { describe, expect, it, vi, afterEach } from "vitest";
import { CostFeature } from "../services/cost-feature-labels.js";
import { analyzeIncidentBatchWithSplit } from "../services/incident-batch-analyze-core.js";
import { maintenanceMaxOutputTokens } from "../services/chat.js";

const SAMPLE_ITEM = { remediationType: "TOOLS_RULE", category: "X", severity: "LOW" };

const baseDeps = {
  model: "gpt-4o-mini",
  modelSource: "test",
  openai: {} as never,
  scFallbackModels: [] as string[],
  thinkingMode: "disabled" as const,
  adaptiveEnabled: false,
  costFeature: CostFeature.selfCorrectionAnalyze,
  costFeatureLabel: "test batch",
  logger: { info: vi.fn(), warn: vi.fn() },
  parseBatchContent: async (content: string) => {
    try {
      return JSON.parse(content) as typeof SAMPLE_ITEM[];
    } catch {
      return null;
    }
  },
  buildPrompt: (batch: unknown[]) => JSON.stringify(batch),
};

describe("analyzeIncidentBatchWithSplit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries transient LLM errors and records diagnostics.retries", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const onTransientRetry = vi.fn();
    const resultPromise = analyzeIncidentBatchWithSplit(
      {
        ...baseDeps,
        maxTokens: 8000,
        onTransientRetry,
        llmCall: async () => {
          calls++;
          if (calls === 1) throw new Error("LLM request timeout after 120s");
          return {
            content: JSON.stringify([SAMPLE_ITEM, SAMPLE_ITEM]),
            fallbacks: 0,
            finishReason: "stop",
          };
        },
      },
      [{ id: 1 }, { id: 2 }],
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(calls).toBe(2);
    expect(onTransientRetry).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.retries).toBe(1);
    expect(result.items?.length).toBe(2);
  });

  it("bumps maxTokens on truncation when below maintenance catalog cap", async () => {
    const maxTokensUsed: number[] = [];
    const result = await analyzeIncidentBatchWithSplit(
      {
        ...baseDeps,
        maxTokens: 10_000,
        llmCall: async (_batch, _label, maxTokensOverride) => {
          maxTokensUsed.push(maxTokensOverride ?? 10_000);
          if (maxTokensUsed.length === 1) {
            return {
              content: JSON.stringify([SAMPLE_ITEM]),
              fallbacks: 0,
              finishReason: "length",
            };
          }
          return {
            content: JSON.stringify([SAMPLE_ITEM, SAMPLE_ITEM]),
            fallbacks: 0,
            finishReason: "stop",
          };
        },
      },
      [{ id: 1 }, { id: 2 }],
    );

    expect(maxTokensUsed.length).toBeGreaterThanOrEqual(2);
    expect(maxTokensUsed[0]).toBe(10_000);
    expect(maxTokensUsed[1]).toBeGreaterThan(10_000);
    expect(result.items?.length).toBe(2);
  });

  it("skips budget bump at maintenance catalog cap and auto-splits instead", async () => {
    const catalogCap = maintenanceMaxOutputTokens("minimax/MiniMax-M3");
    const maxTokensUsed: number[] = [];
    const result = await analyzeIncidentBatchWithSplit(
      {
        ...baseDeps,
        model: "minimax/MiniMax-M3",
        maxTokens: catalogCap,
        llmCall: async (batch, _label, maxTokensOverride) => {
          maxTokensUsed.push(maxTokensOverride ?? catalogCap);
          if (batch.length > 1) {
            return {
              content: JSON.stringify([SAMPLE_ITEM]),
              fallbacks: 0,
              finishReason: "length",
            };
          }
          return {
            content: JSON.stringify([SAMPLE_ITEM]),
            fallbacks: 0,
            finishReason: "stop",
          };
        },
      },
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    );

    expect(maxTokensUsed.every((t) => t === catalogCap)).toBe(true);
    expect(result.diagnostics.batchSplits).toBeGreaterThan(0);
    expect(result.items?.length).toBe(4);
    expect(result.items?.map((item) => (item as Record<string, unknown>).incidentIndex)).toEqual([0, 1, 2, 3]);
  });

  it("splits when a multi-incident batch parses as a valid empty array with finishReason stop", async () => {
    const llmCalls: number[] = [];
    const result = await analyzeIncidentBatchWithSplit(
      {
        ...baseDeps,
        maxTokens: 8000,
        llmCall: async (batch) => {
          llmCalls.push(batch.length);
          if (batch.length > 1) {
            return { content: "[]", fallbacks: 0, finishReason: "stop" };
          }
          return {
            content: JSON.stringify([SAMPLE_ITEM]),
            fallbacks: 0,
            finishReason: "stop",
          };
        },
      },
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    );

    expect(llmCalls.length).toBeGreaterThan(1);
    expect(result.diagnostics.batchSplits).toBeGreaterThan(0);
    expect(result.items?.length).toBe(4);
  });
});
