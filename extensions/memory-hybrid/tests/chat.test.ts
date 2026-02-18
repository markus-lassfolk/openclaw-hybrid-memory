import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chatComplete,
  distillBatchTokenLimit,
  isGeminiModel,
} from "../services/chat.js";

describe("isGeminiModel", () => {
  it("returns true for gemini model names", () => {
    expect(isGeminiModel("gemini-2.0-flash")).toBe(true);
    expect(isGeminiModel("gemini-1.5-pro")).toBe(true);
    expect(isGeminiModel("gemini-1.5-flash")).toBe(true);
    expect(isGeminiModel("models/gemini-2.0-flash")).toBe(true);
    expect(isGeminiModel("GEMINI-2.0")).toBe(true);
  });

  it("returns false for non-Gemini models", () => {
    expect(isGeminiModel("gpt-4o-mini")).toBe(false);
    expect(isGeminiModel("gpt-4")).toBe(false);
    expect(isGeminiModel("claude-3-haiku")).toBe(false);
  });
});

describe("distillBatchTokenLimit", () => {
  it("returns 500_000 for Gemini models", () => {
    expect(distillBatchTokenLimit("gemini-2.0-flash")).toBe(500_000);
    expect(distillBatchTokenLimit("gemini-1.5-pro")).toBe(500_000);
    expect(distillBatchTokenLimit("models/gemini-2.0-flash")).toBe(500_000);
  });

  it("returns 80_000 for non-Gemini models", () => {
    expect(distillBatchTokenLimit("gpt-4o-mini")).toBe(80_000);
    expect(distillBatchTokenLimit("gpt-4")).toBe(80_000);
  });
});

describe("chatComplete", () => {
  const mockOpenai = {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: "Hello from OpenAI" } }],
        }),
      },
    },
  } as unknown as import("openai").default;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("calls OpenAI for gpt-4o-mini", async () => {
    const result = await chatComplete({
      model: "gpt-4o-mini",
      content: "test",
      openai: mockOpenai,
    });
    expect(result).toBe("Hello from OpenAI");
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "test" }],
      }),
    );
  });

  it("throws for Gemini model when no API key", async () => {
    await expect(
      chatComplete({
        model: "gemini-2.0-flash",
        content: "test",
        openai: mockOpenai,
      }),
    ).rejects.toThrow(/Gemini API key required/);
    expect(mockOpenai.chat.completions.create).not.toHaveBeenCalled();
  });

  it("throws for Gemini when config key is too short", async () => {
    await expect(
      chatComplete({
        model: "gemini-2.0-flash",
        content: "test",
        openai: mockOpenai,
        geminiApiKey: "short",
      }),
    ).rejects.toThrow(/Gemini API key required/);
  });

});
