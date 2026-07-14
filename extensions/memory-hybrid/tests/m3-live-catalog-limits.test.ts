/**
 * Live MiniMax M3 catalog calibration — gated by MINIMAX_API_KEY.
 * Probes api.minimax.io for input ceiling, output param acceptance, and quota endpoint.
 * Wire model id is `MiniMax-M3`; `minimax/MiniMax-M3` is the OpenClaw provider prefix (same catalog).
 */
import { describe, expect, it } from "vitest";
import {
  getDistillBatchTokenLimit,
  getDistillMaxOutputTokens,
  getMaintenanceMaxOutputTokens,
  isMiniMaxM3Model,
} from "../services/model-capabilities.js";

const apiKey = process.env.MINIMAX_API_KEY?.trim();
const runLiveMiniMax = apiKey && process.env.RUN_LIVE_MINIMAX_TESTS === "1";
const live = runLiveMiniMax ? describe : describe.skip;

const BASE_URL = "https://api.minimax.io/v1";
const WIRE_MODEL = "MiniMax-M3";
const BLOCK = "word ";

/** ~0.8018 prompt tokens per target token for repeated "word " filler (live-calibrated). */
function fillerForTargetTokens(targetTokens: number): string {
  const approxChars = Math.floor(targetTokens * 4);
  return `Reply only: OK\n\n${BLOCK.repeat(Math.ceil(approxChars / BLOCK.length))}`;
}

async function chatCompletion(body: Record<string, unknown>, timeoutMs = 120_000) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json()) as {
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
    error?: { message?: string; http_code?: string };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  return { status: res.status, headers: res.headers, json };
}

live("live MiniMax M3 catalog limits", () => {
  it("catalog treats MiniMax-M3 and minimax/MiniMax-M3 identically", () => {
    expect(isMiniMaxM3Model("MiniMax-M3")).toBe(true);
    expect(isMiniMaxM3Model("minimax/MiniMax-M3")).toBe(true);
    expect(getDistillMaxOutputTokens("MiniMax-M3")).toBe(getDistillMaxOutputTokens("minimax/MiniMax-M3"));
    expect(getDistillBatchTokenLimit("MiniMax-M3")).toBe(getDistillBatchTokenLimit("minimax/MiniMax-M3"));
    expect(getDistillBatchTokenLimit("MiniMax-M3")).toBe(250_000);
    expect(getMaintenanceMaxOutputTokens("MiniMax-M3")).toBe(32_768);
  });

  it("accepts recommended max_completion_tokens 131072 on short prompt", async () => {
    const { status, json } = await chatCompletion({
      model: WIRE_MODEL,
      messages: [{ role: "user", content: "Reply OK only." }],
      max_completion_tokens: 131_072,
      thinking: { type: "disabled" },
    });
    expect(status).toBe(200);
    expect(json.error).toBeUndefined();
    expect(json.choices?.[0]?.finish_reason).toBe("stop");
  }, 60_000);

  it("input ceiling is ~524169 prompt tokens (655k target ok, oversize target rejected)", async () => {
    const ok = await chatCompletion(
      {
        model: WIRE_MODEL,
        messages: [{ role: "user", content: fillerForTargetTokens(655_000) }],
        max_completion_tokens: 8,
        thinking: { type: "disabled" },
      },
      300_000,
    );
    expect(ok.status).toBe(200);
    expect(ok.json.usage?.prompt_tokens).toBeGreaterThanOrEqual(524_000);
    expect(ok.json.usage?.prompt_tokens).toBeLessThanOrEqual(524_288);

    const fail = await chatCompletion(
      {
        model: WIRE_MODEL,
        messages: [{ role: "user", content: fillerForTargetTokens(700_000) }],
        max_completion_tokens: 8,
        thinking: { type: "disabled" },
      },
      300_000,
    );
    expect(fail.status).toBe(400);
    expect(fail.json.error?.message ?? fail.json.base_resp?.status_msg ?? "").toMatch(
      /invalid params|context window exceeds limit/i,
    );
  }, 600_000);

  it("rejects provider-prefixed model id on direct api.minimax.io (gateway strips prefix)", async () => {
    const { status, json } = await chatCompletion({
      model: "minimax/MiniMax-M3",
      messages: [{ role: "user", content: "Reply OK only." }],
      max_completion_tokens: 16,
      thinking: { type: "disabled" },
    });
    expect(status).toBe(400);
    expect(json.error?.message ?? "").toMatch(/unknown model/i);
  }, 30_000);

  it("exposes quota via token_plan/remains (MiniMax does not emit OpenAI x-ratelimit-* headers)", async () => {
    const res = await fetch("https://www.minimax.io/v1/token_plan/remains", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      model_remains?: unknown[];
      base_resp?: { status_code?: number };
    };
    expect(json.base_resp?.status_code).toBe(0);
    expect(Array.isArray(json.model_remains)).toBe(true);

    const { headers } = await chatCompletion({
      model: WIRE_MODEL,
      messages: [{ role: "user", content: "Reply OK only." }],
      max_completion_tokens: 8,
      thinking: { type: "disabled" },
    });
    const rateKeys = [...headers.keys()].filter((k) => /rate|limit|remaining|quota/i.test(k));
    expect(rateKeys).toEqual([]);
  }, 60_000);
});
