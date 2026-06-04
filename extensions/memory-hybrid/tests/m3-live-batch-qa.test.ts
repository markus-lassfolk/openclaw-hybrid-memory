/**
 * Live MiniMax M3 batch QA — gated by MINIMAX_API_KEY.
 * Validates batch-size tuning under thinking=disabled and 32k maintenance output budget.
 */
import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { analyzeSelfCorrectionIncidentBatchWithSplit } from "../services/self-correction-batch-analyze.js";

const apiKey = process.env.MINIMAX_API_KEY?.trim();
const live = apiKey ? describe : describe.skip;

const baseIncident = {
  userMessage: "That was wrong — verify first.",
  precedingAssistant: "I ran the command without checking.",
  followingAssistant: "I will verify next time.",
  sessionFile: "2026-01-01-session.jsonl",
  timestamp: "2026-01-01",
};

function makeIncidents(n: number) {
  const templates = [
    "Stop waiting — just run it.",
    "Wrong API again.",
    "Why edit silently?",
    "Use curl not Python.",
    "Forgot SSH user.",
  ];
  return Array.from({ length: n }, (_, i) => ({
    ...baseIncident,
    userMessage: `#${i + 1} ${templates[i % templates.length]}`,
    sessionFile: `s-${i}.jsonl`,
  }));
}

live("live MiniMax M3 batch QA", () => {
  const openai = new OpenAI({ apiKey, baseURL: "https://api.minimax.io/v1" });

  const deps = {
    model: "MiniMax-M3",
    modelSource: "live-test",
    openai,
    scFallbackModels: [],
    maxTokens: 32_768,
    thinkingMode: "disabled" as const,
    adaptiveEnabled: false,
    logger: { info: () => {}, warn: () => {} },
    attemptAnalysisJsonRepair: vi.fn(async () => ({ items: null, fallbacks: 0 })),
  };

  it("single-incident batch returns one parsed item", async () => {
    const result = await analyzeSelfCorrectionIncidentBatchWithSplit(deps, makeIncidents(1));
    expect(result.items?.length).toBe(1);
    expect(result.finishReason).not.toBe("length");
  }, 120_000);

  it("batch 5 with auto-split returns five parsed items", async () => {
    const result = await analyzeSelfCorrectionIncidentBatchWithSplit(deps, makeIncidents(5));
    expect(result.items?.length).toBe(5);
  }, 300_000);

  it("batch 8 with auto-split returns eight parsed items", async () => {
    const result = await analyzeSelfCorrectionIncidentBatchWithSplit(deps, makeIncidents(8));
    expect(result.items?.length).toBe(8);
  }, 300_000);
});
