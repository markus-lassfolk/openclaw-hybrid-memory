/**
 * Live MiniMax M2.7 catalog calibration — gated by MINIMAX_API_KEY.
 * Probes api.minimax.io for input ceiling, output param acceptance, and distill batch sizing.
 * Wire ids: `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`; OpenClaw prefix `minimax/...` uses same catalog.
 */
import { describe, expect, it } from "vitest";
import {
  getDistillBatchTokenLimit,
  getDistillMaxOutputTokens,
  getMaintenanceMaxOutputTokens,
  isMiniMaxM3Model,
  isMiniMaxModel,
} from "../services/model-capabilities.js";

const apiKey = process.env.MINIMAX_API_KEY?.trim();
const live = apiKey ? describe : describe.skip;

const BASE_URL = "https://api.minimax.io/v1";
const BLOCK = "word ";

function fillerForTargetTokens(targetTokens: number): string {
  const approxChars = Math.floor(targetTokens * 4);
  return `Reply only: OK\n\n${BLOCK.repeat(Math.ceil(approxChars / BLOCK.length))}`;
}

async function chatCompletion(body: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    choices?: Array<{ finish_reason?: string }>;
    error?: { message?: string };
    base_resp?: { status_msg?: string };
  };
  return { status: res.status, json };
}

live("live MiniMax M2.7 catalog limits", () => {
  it("catalog treats M2.7 wire ids and minimax/ prefix consistently", () => {
    expect(isMiniMaxModel("MiniMax-M2.7")).toBe(true);
    expect(isMiniMaxModel("minimax/MiniMax-M2.7-highspeed")).toBe(true);
    expect(isMiniMaxM3Model("MiniMax-M2.7")).toBe(false);
    expect(getDistillMaxOutputTokens("MiniMax-M2.7")).toBe(getDistillMaxOutputTokens("minimax/MiniMax-M2.7"));
    expect(getDistillMaxOutputTokens("MiniMax-M2.7-highspeed")).toBe(131_072);
    expect(getMaintenanceMaxOutputTokens("MiniMax-M2.7")).toBe(16_384);
    expect(getDistillBatchTokenLimit("minimax/MiniMax-M2.7")).toBe(150_000);
  });

  it("accepts max_completion_tokens 128000 on short prompt (M2.7 and highspeed)", async () => {
    for (const model of ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"] as const) {
      const { status, json } = await chatCompletion({
        model,
        messages: [{ role: "user", content: "Reply OK only." }],
        max_completion_tokens: 128_000,
        thinking: { type: "disabled" },
      });
      expect(status).toBe(200);
      expect(json.error).toBeUndefined();
      expect(json.choices?.[0]?.finish_reason).toBe("stop");
    }
  }, 90_000);

  it("input ceiling is ~262047 prompt tokens (327.5k target ok, 328k target rejected)", async () => {
    for (const model of ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"] as const) {
      const ok = await chatCompletion({
        model,
        messages: [{ role: "user", content: fillerForTargetTokens(327_500) }],
        max_completion_tokens: 8,
        thinking: { type: "disabled" },
      });
      expect(ok.status).toBe(200);
      expect(ok.json.usage?.prompt_tokens).toBeGreaterThanOrEqual(262_000);
      expect(ok.json.usage?.prompt_tokens).toBeLessThanOrEqual(262_144);

      const fail = await chatCompletion({
        model,
        messages: [{ role: "user", content: fillerForTargetTokens(328_000) }],
        max_completion_tokens: 8,
        thinking: { type: "disabled" },
      });
      expect(fail.status).toBe(400);
      expect(fail.json.error?.message ?? fail.json.base_resp?.status_msg ?? "").toMatch(/context window exceeds limit/i);
    }
  }, 300_000);

  it("distill batch 150k input + 128k output budget succeeds; 200k input fails", async () => {
    const ok = await chatCompletion({
      model: "MiniMax-M2.7",
      messages: [{ role: "user", content: fillerForTargetTokens(150_000) }],
      max_completion_tokens: 128_000,
      thinking: { type: "disabled" },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.usage?.prompt_tokens).toBeGreaterThan(110_000);
    expect(ok.json.usage?.prompt_tokens).toBeLessThanOrEqual(150_000);

    const fail = await chatCompletion({
      model: "MiniMax-M2.7",
      messages: [{ role: "user", content: fillerForTargetTokens(200_000) }],
      max_completion_tokens: 128_000,
      thinking: { type: "disabled" },
    });
    expect(fail.status).toBe(400);
    expect(fail.json.error?.message ?? fail.json.base_resp?.status_msg ?? "").toMatch(/context window exceeds limit/i);
  }, 180_000);

  it("rejects provider-prefixed model id on direct api.minimax.io", async () => {
    const { status, json } = await chatCompletion({
      model: "minimax/MiniMax-M2.7",
      messages: [{ role: "user", content: "Reply OK only." }],
      max_completion_tokens: 16,
      thinking: { type: "disabled" },
    });
    expect(status).toBe(400);
    expect(json.error?.message ?? "").toMatch(/unknown model/i);
  }, 30_000);
});
