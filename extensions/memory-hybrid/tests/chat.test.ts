import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chatComplete,
  distillBatchTokenLimit,
  distillMaxOutputTokens,
  withLLMRetry,
  LLMRetryError,
  chatCompleteWithRetry,
} from "../services/chat.js";

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

describe("distillMaxOutputTokens", () => {
  it("returns 65_536 for Gemini models", () => {
    expect(distillMaxOutputTokens("gemini-2.0-flash")).toBe(65_536);
    expect(distillMaxOutputTokens("gemini-1.5-pro")).toBe(65_536);
    expect(distillMaxOutputTokens("models/gemini-2.0-flash")).toBe(65_536);
  });

  it("returns 8000 for non-Gemini models", () => {
    expect(distillMaxOutputTokens("gpt-4o-mini")).toBe(8000);
    expect(distillMaxOutputTokens("gpt-4")).toBe(8000);
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

  it("uses 8000 max_tokens for OpenAI when maxTokens not provided", async () => {
    await chatComplete({
      model: "gpt-4o-mini",
      content: "test",
      openai: mockOpenai,
    });
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 8000,
      }),
    );
  });

  it("uses explicit maxTokens when provided", async () => {
    await chatComplete({
      model: "gpt-4o-mini",
      content: "test",
      maxTokens: 4000,
      openai: mockOpenai,
    });
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 4000,
      }),
    );
  });

  it("routes gemini-2.0-flash through gateway (openai.chat.completions.create)", async () => {
    mockOpenai.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: "Hello from gateway" } }],
    } as any);
    const result = await chatComplete({
      model: "gemini-2.0-flash",
      content: "test message",
      openai: mockOpenai,
    });
    expect(result).toBe("Hello from gateway");
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "test message" }],
        max_tokens: 65_536,
      }),
    );
  });

  it("uses 65536 max_tokens for long-context model (gemini) when maxTokens not provided", async () => {
    await chatComplete({
      model: "gemini-2.0-flash",
      content: "test",
      openai: mockOpenai,
    });
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 65_536,
      }),
    );
  });

});

describe("withLLMRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns result on first attempt if successful", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await withLLMRetry(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds on second attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Temporary error"))
      .mockResolvedValueOnce("success");

    const promise = withLLMRetry(fn, { maxRetries: 3 });

    // Let the first attempt fail and trigger the delay
    await vi.advanceTimersByTimeAsync(1);

    // Advance past the 1s delay
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws LLMRetryError after exhausting all retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Persistent error"));

    const promise = withLLMRetry(fn, { maxRetries: 2 });

    // Immediately check that it will reject, which starts the promise chain
    const expectation = expect(promise).rejects.toThrow(LLMRetryError);

    // Advance through all retry delays: 1s, 3s
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(1);

    // Now await the expectation
    await expectation;
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("LLMRetryError includes attemptNumber", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Test error"));

    const promise = withLLMRetry(fn, { maxRetries: 2 });

    // Catch the promise to prevent unhandled rejection
    const caughtPromise = promise.catch(err => err);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(1);

    const err = await caughtPromise;
    expect(err).toBeInstanceOf(LLMRetryError);
    expect((err as LLMRetryError).attemptNumber).toBe(3);
  });

  it("uses exponential backoff delays: 1s, 3s, 9s", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Error 1"))
      .mockRejectedValueOnce(new Error("Error 2"))
      .mockRejectedValueOnce(new Error("Error 3"))
      .mockResolvedValueOnce("success");

    const promise = withLLMRetry(fn, { maxRetries: 3 });

    // First failure, delay 1s
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);

    // Second failure, delay 3s
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(3000);

    // Third failure, delay 9s
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(9000);

    const result = await promise;
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

describe("chatCompleteWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds with primary model on first attempt", async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "Success with primary" } }],
          }),
        },
      },
    } as unknown as import("openai").default;

    const result = await chatCompleteWithRetry({
      model: "gpt-4o",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["gpt-4o-mini"],
    });

    expect(result).toBe("Success with primary");
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("falls back to second model after primary fails all retries", async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn()
            .mockRejectedValueOnce(new Error("Rate limit"))
            .mockRejectedValueOnce(new Error("Rate limit"))
            .mockRejectedValueOnce(new Error("Rate limit"))
            .mockRejectedValueOnce(new Error("Rate limit"))
            .mockResolvedValueOnce({
              choices: [{ message: { content: "Success with fallback" } }],
            }),
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "gpt-4o",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["gpt-4o-mini"],
      label: "test",
    });

    // Advance through retries for primary model (3 retries = 4 total attempts)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(Math.pow(3, i) * 1000);
    }

    // Final attempt fails, now switch to fallback
    await vi.advanceTimersByTimeAsync(1);

    const result = await promise;
    expect(result).toBe("Success with fallback");
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledTimes(5); // 4 primary + 1 fallback
  });

  it("tries all fallback models in order", async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn()
            // Primary model fails 4 times (initial + 3 retries)
            .mockRejectedValueOnce(new Error("Error"))
            .mockRejectedValueOnce(new Error("Error"))
            .mockRejectedValueOnce(new Error("Error"))
            .mockRejectedValueOnce(new Error("Error"))
            // First fallback fails 4 times
            .mockRejectedValueOnce(new Error("Error"))
            .mockRejectedValueOnce(new Error("Error"))
            .mockRejectedValueOnce(new Error("Error"))
            .mockRejectedValueOnce(new Error("Error"))
            // Second fallback succeeds
            .mockResolvedValueOnce({
              choices: [{ message: { content: "Success with second fallback" } }],
            }),
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "gpt-4o",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["gpt-4o-mini", "gpt-3.5-turbo"],
    });

    // Advance through all retries for both primary and first fallback
    for (let modelIdx = 0; modelIdx < 2; modelIdx++) {
      for (let retry = 0; retry < 3; retry++) {
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(Math.pow(3, retry) * 1000);
      }
      await vi.advanceTimersByTimeAsync(1);
    }

    const result = await promise;
    expect(result).toBe("Success with second fallback");
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledTimes(9); // 4 + 4 + 1
  });

  it("throws when all models fail", async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("All models failed")),
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "gpt-4o",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["gpt-4o-mini"],
    });

    // Set up expectation first
    const expectation = expect(promise).rejects.toThrow(LLMRetryError);

    // Just run all timers to completion - chatComplete has its own retry logic too
    await vi.runAllTimersAsync();

    await expectation;
  }, 20000); // Increase timeout
});
