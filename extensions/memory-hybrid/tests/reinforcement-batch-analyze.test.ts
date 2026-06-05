import { describe, expect, it, vi, afterEach } from "vitest";
import * as adaptiveLlm from "../services/adaptive-maintenance-llm.js";
import {
  analyzeReinforcementIncidentBatchWithSplit,
  resolveReinforcementAnalysisBatchSize,
} from "../services/reinforcement-batch-analyze.js";

const SAMPLE_ITEM = {
  category: "POSITIVE",
  severity: "LOW",
  remediationType: "POSITIVE_RULE",
  remediationContent: "Always verify before acting.",
};

describe("resolveReinforcementAnalysisBatchSize", () => {
  it("defaults to 1 for MiniMax/M3 models", () => {
    expect(resolveReinforcementAnalysisBatchSize("minimax/MiniMax-M3", {})).toBe(1);
  });

  it("defaults to 25 for non-MiniMax models", () => {
    expect(resolveReinforcementAnalysisBatchSize("gpt-4o", {})).toBe(25);
  });
});

describe("analyzeReinforcementIncidentBatchWithSplit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a single-incident batch and assigns incidentIndex metadata via caller ordering", async () => {
    vi.spyOn(adaptiveLlm, "chatCompleteWithAdaptiveMaintenanceRetry").mockResolvedValue({
      content: JSON.stringify([{ ...SAMPLE_ITEM, incidentIndex: 0 }]),
      modelUsed: "test-model",
      finishReason: "stop",
      attemptChain: ["test-model"],
    });

    const result = await analyzeReinforcementIncidentBatchWithSplit(
      {
        model: "test-model",
        modelSource: "test",
        openai: {} as never,
        fallbackModels: [],
        maxTokens: 8000,
        adaptiveEnabled: false,
        logger: {},
        attemptAnalysisJsonRepair: vi.fn(async () => ({ items: null, fallbacks: 0 })),
      },
      [
        {
          userMessage: "good job",
          sessionFile: "a.jsonl",
          agentBehavior: "helpful",
          precedingUserMessage: "",
          recalledMemoryIds: [],
          toolCallSequence: [],
          confidence: 0.9,
        },
      ],
    );

    expect(result.items?.length).toBe(1);
    expect(result.items?.[0]?.incidentIndex).toBe(0);
  });

  it("invokes onTransientRetry when wired through deps", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const onTransientRetry = vi.fn();
    const resultPromise = analyzeReinforcementIncidentBatchWithSplit(
      {
        model: "test-model",
        modelSource: "test",
        openai: {} as never,
        fallbackModels: [],
        maxTokens: 8000,
        adaptiveEnabled: false,
        logger: {},
        onTransientRetry,
        attemptAnalysisJsonRepair: vi.fn(async () => ({ items: null, fallbacks: 0 })),
        llmCall: async () => {
          calls++;
          if (calls === 1) throw new Error("ECONNRESET");
          return {
            content: JSON.stringify([{ ...SAMPLE_ITEM, incidentIndex: 0 }]),
            fallbacks: 0,
            finishReason: "stop",
          };
        },
      },
      [
        {
          userMessage: "good job",
          sessionFile: "a.jsonl",
          agentBehavior: "helpful",
          precedingUserMessage: "",
          recalledMemoryIds: [],
          toolCallSequence: [],
          confidence: 0.9,
        },
      ],
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();

    expect(onTransientRetry).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.retries).toBe(1);
    expect(result.items?.length).toBe(1);
  });
});
