import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as adaptiveLlm from "../services/adaptive-maintenance-llm.js";
import {
  DEFAULT_MINIMAX_SELF_CORRECTION_BATCH_SIZE,
  analyzeSelfCorrectionIncidentBatchWithSplit,
  resolveSelfCorrectionBatchDelayMs,
  resolveSelfCorrectionBatchSize,
} from "../services/self-correction-batch-analyze.js";
import type { CorrectionIncident } from "../services/self-correction-extract.js";

const SAMPLE_INCIDENT: CorrectionIncident = {
  userMessage: "wrong",
  precedingAssistant: "ran command",
  followingAssistant: "sorry",
  sessionFile: "a.jsonl",
  timestamp: "2026-01-01",
};

const SAMPLE_ITEM = {
  category: "WRONG_APPROACH",
  severity: "LOW",
  remediationType: "TOOLS_RULE",
  remediationContent: "Verify first.",
  repeated: false,
};

describe("resolveSelfCorrectionBatchSize", () => {
  it("defaults to 5 for MiniMax/M3 models", () => {
    expect(resolveSelfCorrectionBatchSize("minimax/MiniMax-M3", {})).toBe(DEFAULT_MINIMAX_SELF_CORRECTION_BATCH_SIZE);
    expect(DEFAULT_MINIMAX_SELF_CORRECTION_BATCH_SIZE).toBe(5);
  });

  it("defaults to 25 for non-MiniMax models", () => {
    expect(resolveSelfCorrectionBatchSize("gpt-4o", {})).toBe(25);
  });

  it("honors explicit analysisBatchSize override", () => {
    expect(resolveSelfCorrectionBatchSize("minimax/MiniMax-M3", { analysisBatchSize: 8 })).toBe(8);
  });
});

describe("resolveSelfCorrectionBatchDelayMs", () => {
  it("defaults to 250ms", () => {
    expect(resolveSelfCorrectionBatchDelayMs({})).toBe(250);
  });
});

describe("analyzeSelfCorrectionIncidentBatchWithSplit", () => {
  let call = 0;

  beforeEach(() => {
    call = 0;
    vi.spyOn(adaptiveLlm, "chatCompleteWithAdaptiveMaintenanceRetry").mockImplementation(async () => {
      call++;
      return {
        content: JSON.stringify(Array.from({ length: 2 }, () => SAMPLE_ITEM)),
        modelUsed: "test-model",
        finishReason: "stop",
        attemptChain: ["test-model"],
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-splits when a multi-incident batch parses as a valid empty array", async () => {
    const llmCalls: number[] = [];
    const incidents = Array.from({ length: 4 }, (_, i) => ({
      ...SAMPLE_INCIDENT,
      userMessage: `#${i}`,
      sessionFile: `s-${i}.jsonl`,
    }));
    const result = await analyzeSelfCorrectionIncidentBatchWithSplit(
      {
        model: "test-model",
        modelSource: "test",
        openai: {} as any,
        scFallbackModels: [],
        maxTokens: 8000,
        thinkingMode: "disabled",
        adaptiveEnabled: false,
        logger: {},
        attemptAnalysisJsonRepair: vi.fn(),
        llmCall: async (batch) => {
          llmCalls.push(batch.length);
          if (batch.length > 1) {
            return { content: "[]", fallbacks: 0, finishReason: "stop" };
          }
          return {
            content: JSON.stringify([{ ...SAMPLE_ITEM, incidentIndex: 0 }]),
            fallbacks: 0,
            finishReason: "stop",
          };
        },
      },
      incidents,
    );
    expect(llmCalls.length).toBeGreaterThan(1);
    expect(result.diagnostics.batchSplits).toBeGreaterThan(0);
    expect(result.items?.length).toBe(4);
  });

  it("auto-splits when parsed count is below incident count", async () => {
    const incidents = Array.from({ length: 4 }, (_, i) => ({
      ...SAMPLE_INCIDENT,
      userMessage: `#${i}`,
      sessionFile: `s-${i}.jsonl`,
    }));
    const result = await analyzeSelfCorrectionIncidentBatchWithSplit(
      {
        model: "test-model",
        modelSource: "test",
        openai: {} as any,
        scFallbackModels: [],
        maxTokens: 8000,
        thinkingMode: "disabled",
        adaptiveEnabled: false,
        logger: {},
        attemptAnalysisJsonRepair: vi.fn(),
      },
      incidents,
    );
    expect(result.items?.length).toBe(4);
    expect(result.diagnostics.batchSplits).toBeGreaterThan(0);
  });

  it("treats blank LLM output as parse failure (not a successful empty array)", async () => {
    const attemptAnalysisJsonRepair = vi.fn(async () => ({ items: null, fallbacks: 0 }));
    vi.spyOn(adaptiveLlm, "chatCompleteWithAdaptiveMaintenanceRetry").mockResolvedValue({
      content: "   \n  ",
      modelUsed: "test-model",
      finishReason: "stop",
      attemptChain: ["test-model"],
    });

    const result = await analyzeSelfCorrectionIncidentBatchWithSplit(
      {
        model: "test-model",
        modelSource: "test",
        openai: {} as any,
        scFallbackModels: [],
        maxTokens: 8000,
        thinkingMode: "disabled",
        adaptiveEnabled: false,
        logger: {},
        attemptAnalysisJsonRepair,
      },
      [SAMPLE_INCIDENT, { ...SAMPLE_INCIDENT, sessionFile: "b.jsonl" }],
    );

    expect(result.items).toBeNull();
    expect(result.diagnostics.parseFailures).toBeGreaterThan(0);
    expect(attemptAnalysisJsonRepair).toHaveBeenCalled();
  });

  it("increments parseFailures once when JSON repair succeeds after initial parse failure", async () => {
    const attemptAnalysisJsonRepair = vi.fn(async () => ({
      items: [
        { ...SAMPLE_ITEM, incidentIndex: 0 },
        { ...SAMPLE_ITEM, incidentIndex: 1 },
      ],
      fallbacks: 0,
    }));
    vi.spyOn(adaptiveLlm, "chatCompleteWithAdaptiveMaintenanceRetry").mockResolvedValue({
      content: "not valid json",
      modelUsed: "test-model",
      finishReason: "stop",
      attemptChain: ["test-model"],
    });

    const result = await analyzeSelfCorrectionIncidentBatchWithSplit(
      {
        model: "test-model",
        modelSource: "test",
        openai: {} as any,
        scFallbackModels: [],
        maxTokens: 8000,
        thinkingMode: "disabled",
        adaptiveEnabled: false,
        logger: {},
        attemptAnalysisJsonRepair,
      },
      [SAMPLE_INCIDENT, { ...SAMPLE_INCIDENT, sessionFile: "b.jsonl" }],
    );

    expect(result.items?.length).toBe(2);
    expect(result.diagnostics.parseFailures).toBe(1);
    expect(attemptAnalysisJsonRepair).toHaveBeenCalled();
  });

  it("normalizes incidentIndex after auto-split merge", async () => {
    const result = await analyzeSelfCorrectionIncidentBatchWithSplit(
      {
        model: "test-model",
        modelSource: "test",
        openai: {} as any,
        scFallbackModels: [],
        maxTokens: 8000,
        thinkingMode: "disabled",
        adaptiveEnabled: false,
        logger: {},
        attemptAnalysisJsonRepair: vi.fn(),
        llmCall: async (batch) => {
          if (batch.length > 1) {
            return {
              content: JSON.stringify([{ ...SAMPLE_ITEM, incidentIndex: 0 }]),
              fallbacks: 0,
              finishReason: "length",
            };
          }
          return {
            content: JSON.stringify([{ ...SAMPLE_ITEM, incidentIndex: 0 }]),
            fallbacks: 0,
            finishReason: "stop",
          };
        },
      },
      Array.from({ length: 4 }, (_, i) => ({
        ...SAMPLE_INCIDENT,
        userMessage: `#${i}`,
        sessionFile: `s-${i}.jsonl`,
      })),
    );

    expect(result.diagnostics.batchSplits).toBeGreaterThan(0);
    expect(result.items?.length).toBe(4);
    expect(result.items?.map((item) => item.incidentIndex).sort()).toEqual([0, 1, 2, 3]);
  });

  it("uses llmCall override for split sub-batches", async () => {
    const llmCalls: number[] = [];
    const result = await analyzeSelfCorrectionIncidentBatchWithSplit(
      {
        model: "test-model",
        modelSource: "test",
        openai: {} as any,
        scFallbackModels: [],
        maxTokens: 8000,
        thinkingMode: "disabled",
        adaptiveEnabled: false,
        logger: {},
        attemptAnalysisJsonRepair: vi.fn(),
        llmCall: async (batch) => {
          llmCalls.push(batch.length);
          if (batch.length > 1) {
            return {
              content: JSON.stringify(Array.from({ length: batch.length - 1 }, () => SAMPLE_ITEM)),
              fallbacks: 0,
              finishReason: "stop",
            };
          }
          return {
            content: JSON.stringify([SAMPLE_ITEM]),
            fallbacks: 0,
            finishReason: "stop",
          };
        },
      },
      Array.from({ length: 4 }, (_, i) => ({
        ...SAMPLE_INCIDENT,
        userMessage: `#${i}`,
        sessionFile: `s-${i}.jsonl`,
      })),
    );

    expect(llmCalls.length).toBeGreaterThan(1);
    expect(result.items?.length).toBe(4);
    expect(result.diagnostics.batchSplits).toBeGreaterThan(0);
  });

  it("rejects a single-incident batch that parses as an empty array", async () => {
    vi.spyOn(adaptiveLlm, "chatCompleteWithAdaptiveMaintenanceRetry").mockResolvedValue({
      content: "[]",
      modelUsed: "test-model",
      finishReason: "stop",
      attemptChain: ["test-model"],
    });

    const result = await analyzeSelfCorrectionIncidentBatchWithSplit(
      {
        model: "test-model",
        modelSource: "test",
        openai: {} as any,
        scFallbackModels: [],
        maxTokens: 8000,
        thinkingMode: "disabled",
        adaptiveEnabled: false,
        logger: {},
        attemptAnalysisJsonRepair: vi.fn(),
      },
      [SAMPLE_INCIDENT],
    );

    expect(result.items).toBeNull();
  });
});
