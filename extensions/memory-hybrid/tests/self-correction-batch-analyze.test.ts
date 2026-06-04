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
      const count = call === 1 ? 2 : 2;
      return {
        content: JSON.stringify(Array.from({ length: count }, () => SAMPLE_ITEM)),
        modelUsed: "test-model",
        finishReason: "stop",
        attemptChain: ["test-model"],
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
});
