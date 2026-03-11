/**
 * Tests for chatComplete() reasoning field fallback (#314).
 * Qwen3 thinking mode (Ollama) returns empty content with response in message.reasoning.
 */
import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";

vi.mock("../services/error-reporter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/error-reporter.js")>();
  return { ...actual, capturePluginError: vi.fn() };
});

import { chatComplete } from "../services/chat.js";

function makeMockOpenAI(response: { content: string | null; reasoning?: string }): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: response.content,
                ...(response.reasoning !== undefined ? { reasoning: response.reasoning } : {}),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      },
    },
  } as unknown as OpenAI;
}

describe("chatComplete — reasoning field fallback (Qwen3/Ollama thinking mode)", () => {
  it("returns content when it is non-empty (normal case)", async () => {
    const openai = makeMockOpenAI({ content: "Hello world" });
    const result = await chatComplete({ model: "ollama/qwen3:8b", content: "Say hello", openai });
    expect(result).toBe("Hello world");
  });

  it("falls back to message.reasoning when content is empty string (#314)", async () => {
    const openai = makeMockOpenAI({ content: "", reasoning: "Okay, the user wants me to say hello. Hello!" });
    const result = await chatComplete({ model: "ollama/qwen3:8b", content: "Say hello", openai });
    expect(result).toBe("Okay, the user wants me to say hello. Hello!");
  });

  it("falls back to message.reasoning when content is null", async () => {
    const openai = makeMockOpenAI({ content: null, reasoning: "The answer is 42." });
    const result = await chatComplete({ model: "ollama/qwen3:8b", content: "Answer", openai });
    expect(result).toBe("The answer is 42.");
  });

  it("trims whitespace from reasoning fallback", async () => {
    const openai = makeMockOpenAI({ content: "", reasoning: "  trimmed reasoning  " });
    const result = await chatComplete({ model: "ollama/qwen3:8b", content: "test", openai });
    expect(result).toBe("trimmed reasoning");
  });

  it("returns empty string when both content and reasoning are empty", async () => {
    const openai = makeMockOpenAI({ content: "", reasoning: "" });
    const result = await chatComplete({ model: "ollama/qwen3:8b", content: "test", openai });
    expect(result).toBe("");
  });

  it("returns empty string when content is empty and reasoning is absent", async () => {
    const openai = makeMockOpenAI({ content: "" });
    const result = await chatComplete({ model: "ollama/qwen3:8b", content: "test", openai });
    expect(result).toBe("");
  });

  it("prefers non-empty content over reasoning even when reasoning is present", async () => {
    const openai = makeMockOpenAI({ content: "Actual content", reasoning: "Internal thinking" });
    const result = await chatComplete({ model: "ollama/qwen3:8b", content: "test", openai });
    expect(result).toBe("Actual content");
  });
});
