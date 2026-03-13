import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chatComplete,
  distillBatchTokenLimit,
  distillMaxOutputTokens,
  withLLMRetry,
  LLMRetryError,
  chatCompleteWithRetry,
  createPendingLLMWarnings,
  is404Like,
  is403Like,
  is500Like,
  isOllamaOOM,
  UnconfiguredProviderError,
} from "../services/chat.js";

vi.mock("../services/error-reporter.js", () => ({
  capturePluginError: vi.fn(),
}));
import * as errorReporter from "../services/error-reporter.js";

describe("distillBatchTokenLimit", () => {
  it("returns 400_000 for Gemini models (conservative limit for fallback models)", () => {
    expect(distillBatchTokenLimit("gemini-2.0-flash")).toBe(400_000);
    expect(distillBatchTokenLimit("gemini-1.5-pro")).toBe(400_000);
    expect(distillBatchTokenLimit("models/gemini-2.0-flash")).toBe(400_000);
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("routes gemini-2.0-flash through gateway (openai.chat.completions.create)", async () => {
    vi.mocked(mockOpenai.chat.completions.create).mockResolvedValue({
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("passes full provider/model id to completions request (gateway expects provider/model)", async () => {
    vi.mocked(mockOpenai.chat.completions.create).mockResolvedValue({
      choices: [{ message: { content: "OK" } }],
    } as any);
    await chatComplete({
      model: "google/gemini-2.5-flash",
      content: "test",
      openai: mockOpenai,
    });
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "google/gemini-2.5-flash",
      }),
      expect.anything(),
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

  it("#329: does not retry Google API 404 (model not found for API version), capturePluginError not called", async () => {
    vi.clearAllMocks();
    const googleError = Object.assign(
      new Error("404 models/text-embedding-004 is not found for API version v1beta, or is not supported for embeddings."),
      { status: 404 },
    );
    const fn = vi.fn().mockRejectedValue(googleError);
    await expect(withLLMRetry(fn, { maxRetries: 2 })).rejects.toThrow("404 models/text-embedding-004");
    // Should only be called once — no retry for 404
    expect(fn).toHaveBeenCalledTimes(1);
    // 404 exits early before the final-failure branch — GlitchTip must not be called
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#329: does not retry Google API 404 without status property (message-only detection)", async () => {
    // Simulates the case where .status is not accessible (e.g. cross-realm instanceof failure)
    const googleError = new Error("404 models/text-embedding-004 is not found for API version v1beta, or is not supported for embeddings.");
    const fn = vi.fn().mockRejectedValue(googleError);
    await expect(withLLMRetry(fn, { maxRetries: 2 })).rejects.toThrow("404 models/text-embedding-004");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("#329: does not retry when error message matches Google 'is not found for api version' pattern", async () => {
    // Exact format Google returns when model is unavailable at the given API version
    const err = new Error("models/text-embedding-004 is not found for API version v1beta");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withLLMRetry(fn, { maxRetries: 2 })).rejects.toThrow("is not found for API version");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("#329: 404 exits early (before final-failure branch) — capturePluginError not called", async () => {
    vi.clearAllMocks();
    // 404 errors are detected by the dedicated is404Like() check before any retry attempt,
    // so they never reach the final-failure LLMRetryError branch where capturePluginError runs.
    const googleError = Object.assign(
      new Error("404 models/text-embedding-004 is not found for API version v1beta"),
      { status: 404 },
    );
    const fn = vi.fn().mockRejectedValue(googleError);
    // Throws the raw 404 error (not an LLMRetryError), called exactly once — exits before retry loop
    await expect(withLLMRetry(fn, { maxRetries: 2 })).rejects.toThrow("404 models");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#393: does not retry Google 403 country/region restriction (status property)", async () => {
    vi.clearAllMocks();
    const googleError = Object.assign(
      new Error("403 Country, region, or territory not supported"),
      { status: 403 },
    );
    const fn = vi.fn().mockRejectedValue(googleError);
    // Throws the raw 403 error (not an LLMRetryError), called exactly once — exits before retry loop
    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow("403 Country");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#393: does not retry 403 without status property (message-only detection)", async () => {
    vi.clearAllMocks();
    const err = new Error("403 Country, region, or territory not supported");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow("403 Country");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#393: does not retry '403 Forbidden' errors", async () => {
    vi.clearAllMocks();
    const err = Object.assign(new Error("403 Forbidden"), { status: 403 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow("403 Forbidden");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });
});

describe("is404Like", () => {
  it("returns true for error with numeric status 404", () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    expect(is404Like(err)).toBe(true);
  });

  it("returns true for error with string status '404'", () => {
    const err = Object.assign(new Error("Not Found"), { status: "404" });
    expect(is404Like(err)).toBe(true);
  });

  it("returns true for Google API 'is not found for API version' format", () => {
    const err = new Error("models/text-embedding-004 is not found for API version v1beta");
    expect(is404Like(err)).toBe(true);
  });

  it("returns true for '404 Not Found' messages", () => {
    expect(is404Like(new Error("404 Not Found"))).toBe(true);
  });

  it("returns true for 'model not found' messages", () => {
    expect(is404Like(new Error("Model not found: gpt-4"))).toBe(true);
  });

  it("returns false for non-404 errors", () => {
    expect(is404Like(new Error("Connection refused"))).toBe(false);
    expect(is404Like(new Error("500 Internal Server Error"))).toBe(false);
    expect(is404Like(new Error("file not found"))).toBe(false);
    expect(is404Like(new Error("module not found"))).toBe(false);
  });
});

describe("is403Like", () => {
  it("returns true for error with numeric status 403", () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    expect(is403Like(err)).toBe(true);
  });

  it("returns true for error with string status '403'", () => {
    const err = Object.assign(new Error("Forbidden"), { status: "403" });
    expect(is403Like(err)).toBe(true);
  });

  it("returns true for '403 Forbidden' message", () => {
    expect(is403Like(new Error("403 Forbidden"))).toBe(true);
  });

  it("returns true for Google '403 Country, region, or territory not supported'", () => {
    expect(is403Like(new Error("403 Country, region, or territory not supported"))).toBe(true);
  });

  it("returns true for 'HTTP 403' in message", () => {
    expect(is403Like(new Error("HTTP 403 Forbidden"))).toBe(true);
  });

  it("returns true for 'Error code: 403' format", () => {
    expect(is403Like(new Error("Error code: 403 - access denied"))).toBe(true);
  });

  it("returns false for non-403 errors", () => {
    expect(is403Like(new Error("Connection refused"))).toBe(false);
    expect(is403Like(new Error("401 Unauthorized"))).toBe(false);
    expect(is403Like(new Error("404 Not Found"))).toBe(false);
    expect(is403Like(new Error("500 Internal Server Error"))).toBe(false);
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

describe("chatComplete — GlitchTip suppression (#302, #303)", () => {
  const mockOpenai = {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  } as unknown as import("openai").default;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("#302: does not report 'Internal Server Error' (OpenAI SDK 500) to Sentry", async () => {
    vi.mocked(mockOpenai.chat.completions.create).mockRejectedValue(
      new Error("Internal Server Error"),
    );
    await expect(
      chatComplete({ model: "gpt-4o", content: "test", openai: mockOpenai }),
    ).rejects.toThrow();
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#302: does not report '500 Internal Server Error' to Sentry", async () => {
    vi.mocked(mockOpenai.chat.completions.create).mockRejectedValue(
      new Error("500 Internal Server Error"),
    );
    await expect(
      chatComplete({ model: "gpt-4o", content: "test", openai: mockOpenai }),
    ).rejects.toThrow();
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#303: does not report 404 Not Found to Sentry", async () => {
    vi.mocked(mockOpenai.chat.completions.create).mockRejectedValue(
      new Error("404 Not Found"),
    );
    await expect(
      chatComplete({ model: "gpt-4o", content: "test", openai: mockOpenai }),
    ).rejects.toThrow();
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });
});

describe("chatCompleteWithRetry — 500 and 404 fallback (#302, #303)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("#302: falls back to next model after 500, using only 2 attempts (not full retry budget)", async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn()
            // Primary: fails twice with 500 then stops (is500 exits after attempt 1)
            .mockRejectedValueOnce(new Error("Internal Server Error"))
            .mockRejectedValueOnce(new Error("Internal Server Error"))
            // Fallback: succeeds
            .mockResolvedValueOnce({
              choices: [{ message: { content: "fallback ok" } }],
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

    // Advance the single retry delay for the primary model (1 attempt then throw)
    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;
    expect(result).toBe("fallback ok");
    // Primary: 2 attempts, fallback: 1 attempt = 3 total
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it("#302: does not report to Sentry when all models fail with 500", async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("Internal Server Error")),
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "gpt-4o",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["gpt-4o-mini"],
    });

    const expectation = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#303: queues user warning and does not report to Sentry when all models return 404", async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("404 Not Found")),
        },
      },
    } as unknown as import("openai").default;

    const warnings = createPendingLLMWarnings();
    const promise = chatCompleteWithRetry({
      model: "gpt-4o",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["gpt-4o-mini"],
      pendingWarnings: warnings,
    });

    const expectation = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
    const drained = warnings.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatch(/404/);
  });
});

describe("chatCompleteWithRetry — 403 country/region restriction (#394, #395)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("#394: does not report to GlitchTip when all models fail with plain 403 Error", async () => {
    const err = new Error("403 Country, region, or territory not supported");
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(err),
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "google/gemini-2.5-flash",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["google/gemini-2.0-flash"],
    });

    const expectation = expect(promise).rejects.toThrow("403 Country");
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#394: queues user warning and does not report to GlitchTip when all models return 403", async () => {
    const err = Object.assign(
      new Error("403 Country, region, or territory not supported"),
      { status: 403 },
    );
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(err),
        },
      },
    } as unknown as import("openai").default;

    const warnings = createPendingLLMWarnings();
    const promise = chatCompleteWithRetry({
      model: "google/gemini-2.5-flash",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["google/gemini-2.0-flash"],
      pendingWarnings: warnings,
    });

    const expectation = expect(promise).rejects.toThrow("403");
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
    const drained = warnings.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatch(/403/);
    expect(drained[0]).toMatch(/country|region|access denied/i);
  });

  it("#395: withLLMRetry short-circuits on 403 and does not create LLMRetryError", async () => {
    const err = Object.assign(
      new Error("403 Country, region, or territory not supported"),
      { status: 403 },
    );
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow("403 Country");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });
});

describe("chatCompleteWithRetry — 429 rate limiting (#397)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("#397: does not report 429 to GlitchTip when all models are rate limited", async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(
            new Error("429 429 Too Many Requests: you (clawout) have reached your weekly usage limit"),
          ),
        },
      },
    } as unknown as import("openai").default;

    const warnings = createPendingLLMWarnings();
    const promise = chatCompleteWithRetry({
      model: "gpt-4o",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["gpt-4o-mini"],
      pendingWarnings: warnings,
    });

    const expectation = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#397: queues user-visible warning when rate limited (429)", async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(
            new Error("429 Too Many Requests: you have reached your weekly usage limit"),
          ),
        },
      },
    } as unknown as import("openai").default;

    const warnings = createPendingLLMWarnings();
    const promise = chatCompleteWithRetry({
      model: "gpt-4o",
      content: "test",
      openai: mockOpenai,
      pendingWarnings: warnings,
    });

    const expectation = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await expectation;
    const drained = warnings.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatch(/429|rate.?limit/i);
  });

  it("#397: falls back to next model after primary is rate limited (429)", async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn()
            // Primary: rate limited (4x = initial + 3 retries; but 429 uses exponential backoff)
            .mockRejectedValueOnce(new Error("429 Too Many Requests"))
            .mockRejectedValueOnce(new Error("429 Too Many Requests"))
            .mockRejectedValueOnce(new Error("429 Too Many Requests"))
            .mockRejectedValueOnce(new Error("429 Too Many Requests"))
            // Fallback: succeeds
            .mockResolvedValueOnce({
              choices: [{ message: { content: "fallback ok" } }],
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

    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("fallback ok");
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledTimes(5);
  });

  it("#397: withLLMRetry does not report 429 to GlitchTip (isTransient)", async () => {
    vi.clearAllMocks();
    const fn = vi.fn().mockRejectedValue(
      new Error("429 429 Too Many Requests: weekly limit reached"),
    );
    const promise = withLLMRetry(fn, { maxRetries: 1 });
    const expectation = expect(promise).rejects.toThrow(LLMRetryError);
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });
});

describe("chatCompleteWithRetry — UnconfiguredProviderError (#328)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("#328: does not report to GlitchTip when all models fail with UnconfiguredProviderError", async () => {
    const err = new UnconfiguredProviderError("anthropic", "anthropic/claude-sonnet-4-6");
    const mockOpenai = {
      chat: {
        completions: { create: vi.fn().mockRejectedValue(err) },
      },
    } as unknown as import("openai").default;

    const warnings = createPendingLLMWarnings();
    const promise = chatCompleteWithRetry({
      model: "anthropic/claude-sonnet-4-6",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["anthropic/claude-opus-4-6"],
      pendingWarnings: warnings,
    });

    const expectation = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
    const drained = warnings.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatch(/provider keys/i);
  });

  it("#328: does not report UnconfiguredProviderError to GlitchTip when final model is unconfigured but earlier model had a different error", async () => {
    const unconfiguredErr = new UnconfiguredProviderError("anthropic", "anthropic/claude-sonnet-4-6");
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn()
            // Primary (openai): transient ECONNREFUSED — does not count as unconfigured
            .mockRejectedValueOnce(new Error("ECONNREFUSED"))
            .mockRejectedValueOnce(new Error("ECONNREFUSED"))
            // Fallback (anthropic): unconfigured provider
            .mockRejectedValue(unconfiguredErr),
        },
      },
    } as unknown as import("openai").default;

    const warnings = createPendingLLMWarnings();
    const promise = chatCompleteWithRetry({
      model: "openai/gpt-4o",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["anthropic/claude-sonnet-4-6"],
      pendingWarnings: warnings,
    });

    const expectation = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await expectation;
    // UnconfiguredProviderError is a config issue — must NOT be reported to GlitchTip regardless of other errors
    const unconfiguredCalls = vi.mocked(errorReporter.capturePluginError).mock.calls
      .filter(([err]) => err instanceof UnconfiguredProviderError);
    expect(unconfiguredCalls).toHaveLength(0);
    const drained = warnings.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatch(/provider keys/i);
  });
});

// ---------------------------------------------------------------------------
// isOllamaOOM (#387)
// ---------------------------------------------------------------------------

describe("isOllamaOOM (#387)", () => {
  it("matches standard Ollama OOM error message", () => {
    expect(isOllamaOOM(new Error("model requires more system memory (18.2 GiB) than is available (8.0 GiB)"))).toBe(true);
  });

  it("matches 'not enough memory to load' phrasing", () => {
    expect(isOllamaOOM(new Error("not enough memory to load model qwen3:8b"))).toBe(true);
  });

  it("matches 'requires X GiB' pattern", () => {
    expect(isOllamaOOM(new Error("model requires 18.2 GiB of system memory"))).toBe(true);
  });

  it("matches bare OOM: prefix from Ollama", () => {
    expect(isOllamaOOM(new Error("OOM: model 'qwen3:8b' cannot be loaded"))).toBe(true);
  });

  it("does not match generic 500 errors", () => {
    expect(isOllamaOOM(new Error("HTTP 500 Internal Server Error"))).toBe(false);
  });

  it("does not match connection errors", () => {
    expect(isOllamaOOM(new Error("ECONNREFUSED http://localhost:11434"))).toBe(false);
  });

  it("does not match 404 errors", () => {
    expect(isOllamaOOM(new Error("404 model not found"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isOllamaOOM("some string")).toBe(false);
    expect(isOllamaOOM(null)).toBe(false);
    expect(isOllamaOOM(500)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// is500Like — exported (#387)
// ---------------------------------------------------------------------------

describe("is500Like (#387)", () => {
  it("matches HTTP 500 error message", () => {
    expect(is500Like(new Error("HTTP 500 Internal Server Error"))).toBe(true);
  });

  it("matches OpenAI SDK InternalServerError with .status property", () => {
    const err = Object.assign(new Error("InternalServerError"), { status: 500 });
    expect(is500Like(err)).toBe(true);
  });

  it("does not match generic errors without 5xx", () => {
    expect(is500Like(new Error("Something went wrong"))).toBe(false);
  });

  it("does not match connection errors", () => {
    expect(is500Like(new Error("ECONNREFUSED"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withLLMRetry — OOM does not retry (#387)
// ---------------------------------------------------------------------------

describe("withLLMRetry — OOM does not retry (#387)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("#387: does not retry Ollama OOM error (model requires more memory than available)", async () => {
    const oomErr = new Error("model requires more system memory (18.2 GiB) than is available (8.0 GiB)");
    const fn = vi.fn().mockRejectedValue(oomErr);

    const promise = withLLMRetry(fn, { maxRetries: 3 });
    const expectation = expect(promise).rejects.toThrow("model requires more system memory");
    await vi.runAllTimersAsync();
    await expectation;
    // Must NOT retry — called exactly once
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("#387: does not report OOM to GlitchTip (thrown directly, not wrapped in LLMRetryError)", async () => {
    const oomErr = new Error("model requires more system memory (18.2 GiB) than is available (8.0 GiB)");
    const fn = vi.fn().mockRejectedValue(oomErr);

    const promise = withLLMRetry(fn);
    const expectation = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// chatCompleteWithRetry — OOM falls through to next model (#387)
// ---------------------------------------------------------------------------

describe("chatCompleteWithRetry — OOM falls through to next model (#387)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("#387: falls through to next fallback model immediately when primary model OOMs", async () => {
    const oomErr = new Error("model requires more system memory (18.2 GiB) than is available (8.0 GiB)");
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn()
            .mockRejectedValueOnce(oomErr)  // primary: OOM
            .mockResolvedValueOnce({ choices: [{ message: { content: "fallback success" } }] }),  // fallback: ok
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "ollama/qwen3:8b",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["google/gemini-2.0-flash-lite"],
    });

    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("fallback success");
    // Primary called once (OOM, no retry), fallback called once
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("#387: does not report to GlitchTip when all models fail with OOM", async () => {
    const oomErr = new Error("model requires more system memory (18.2 GiB) than is available (8.0 GiB)");
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(oomErr),
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "ollama/qwen3:8b",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["ollama/qwen3:4b"],
    });

    const expectation = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await expectation;
    // OOM is a 500-like transient error — must NOT be reported to GlitchTip
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// is403Like (#395)
// ---------------------------------------------------------------------------

describe("is403Like", () => {
  it("returns true for error with status 403", () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    expect(is403Like(err)).toBe(true);
  });

  it("returns true for error with status '403' (string)", () => {
    const err = Object.assign(new Error("Forbidden"), { status: "403" });
    expect(is403Like(err)).toBe(true);
  });

  it("returns true for message starting with '403 Country, region, or territory not supported'", () => {
    expect(is403Like(new Error("403 Country, region, or territory not supported"))).toBe(true);
  });

  it("returns true for message matching 'HTTP 403'", () => {
    expect(is403Like(new Error("HTTP 403 Forbidden"))).toBe(true);
  });

  it("returns true for message matching '403 Forbidden'", () => {
    expect(is403Like(new Error("403 Forbidden"))).toBe(true);
  });

  it("returns false for 404 error", () => {
    expect(is403Like(new Error("404 Not Found"))).toBe(false);
  });

  it("returns false for unrelated error", () => {
    expect(is403Like(new Error("Network error"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(is403Like(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chatCompleteWithRetry — 403 country/region restriction (#395)
// ---------------------------------------------------------------------------

describe("chatCompleteWithRetry — 403 country/region restriction (#395)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("#395: does not report to GlitchTip when all models fail with LLMRetryError wrapping 403", async () => {
    const err = new Error("403 Country, region, or territory not supported");
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(err),
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "google/gemini-2.5-flash",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["google/gemini-2.0-flash"],
    });

    const expectation = expect(promise).rejects.toThrow("403 Country");
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#395: queues user warning and does not report to GlitchTip when all models return 403 with status", async () => {
    const err = Object.assign(
      new Error("403 Country, region, or territory not supported"),
      { status: 403 },
    );
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(err),
        },
      },
    } as unknown as import("openai").default;

    const warnings = createPendingLLMWarnings();
    const promise = chatCompleteWithRetry({
      model: "google/gemini-2.5-flash",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["google/gemini-2.0-flash"],
      pendingWarnings: warnings,
    });

    const expectation = expect(promise).rejects.toThrow("403");
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
    const drained = warnings.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatch(/403/);
    expect(drained[0]).toMatch(/country|region|access denied/i);
  });

  it("#395: withLLMRetry short-circuits on 403 and does not create LLMRetryError", async () => {
    const err = Object.assign(
      new Error("403 Country, region, or territory not supported"),
      { status: 403 },
    );
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow("403 Country");
    // Must not have retried — short-circuits immediately
    expect(fn).toHaveBeenCalledTimes(1);
    // Must not report to GlitchTip
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });
});
