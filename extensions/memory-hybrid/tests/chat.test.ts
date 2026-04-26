import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LLMRetryError,
  UnconfiguredProviderError,
  chatComplete,
  chatCompleteWithRetry,
  createPendingLLMWarnings,
  distillBatchTokenLimit,
  distillMaxOutputTokens,
  is403Like,
  is403QuotaOrRateLimitLike,
  is404Like,
  is500Like,
  isAbortOrTransientLlmError,
  isConnectionErrorLike,
  isContextLengthError,
  isOllamaOOM,
  isResponsesReasoningSequenceError,
  parseGoDurationToMs,
  parseRetryAfterMs,
  withLLMRetry,
} from "../services/chat.js";
import { isReasoningModel, requiresMaxCompletionTokens, resolveWireApi } from "../services/model-capabilities.js";

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

  it("returns catalog max output for known models, 8000 default for unknown", () => {
    expect(distillMaxOutputTokens("gpt-4o-mini")).toBe(16_384);
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

  it("uses catalog max_tokens for gpt-4o-mini (16k) when maxTokens not provided", async () => {
    await chatComplete({
      model: "gpt-4o-mini",
      content: "test",
      openai: mockOpenai,
    });
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 16_384,
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
    const fn = vi.fn().mockRejectedValueOnce(new Error("Temporary error")).mockResolvedValueOnce("success");

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
    const caughtPromise = promise.catch((err) => err);

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
    const fn = vi
      .fn()
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
      new Error(
        "404 models/text-embedding-004 is not found for API version v1beta, or is not supported for embeddings.",
      ),
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
    const googleError = new Error(
      "404 models/text-embedding-004 is not found for API version v1beta, or is not supported for embeddings.",
    );
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
    const googleError = Object.assign(new Error("404 models/text-embedding-004 is not found for API version v1beta"), {
      status: 404,
    });
    const fn = vi.fn().mockRejectedValue(googleError);
    // Throws the raw 404 error (not an LLMRetryError), called exactly once — exits before retry loop
    await expect(withLLMRetry(fn, { maxRetries: 2 })).rejects.toThrow("404 models");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#703: treats OpenAI SDK APIConnectionError as transient and does not report to GlitchTip", async () => {
    vi.clearAllMocks();
    const err = Object.assign(new Error("Connection error."), {
      name: "APIConnectionError",
      cause: { code: "ECONNRESET" },
    });
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withLLMRetry(fn, { maxRetries: 1 });
    const expectation = expect(promise).rejects.toThrow("Connection error.");
    await vi.runAllTimersAsync();
    await expectation;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#393: does not retry Google 403 country/region restriction (status property)", async () => {
    vi.clearAllMocks();
    const googleError = Object.assign(new Error("403 Country, region, or territory not supported"), { status: 403 });
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

describe("is403QuotaOrRateLimitLike", () => {
  it("detects 403 with Retry-After and excludes from is403Like (geo)", () => {
    const err = Object.assign(new Error("403 status code (no body)"), {
      status: 403,
      headers: new Headers({ "retry-after": "1282" }),
    });
    expect(is403QuotaOrRateLimitLike(err)).toBe(true);
    expect(is403Like(err)).toBe(false);
  });

  it("detects 403 with remaining-tokens: 0", () => {
    const err = Object.assign(new Error("Forbidden"), {
      status: 403,
      headers: new Headers({ "remaining-tokens": "0" }),
    });
    expect(is403QuotaOrRateLimitLike(err)).toBe(true);
    expect(is403Like(err)).toBe(false);
  });

  it("unwraps LLMRetryError so wrapped quota 403 is not classified as geo 403", () => {
    const cause = Object.assign(new Error("403 status code (no body)"), {
      status: 403,
      headers: new Headers({ "retry-after": "60", "remaining-tokens": "0" }),
    });
    const wrapped = new LLMRetryError(`Failed after 4 attempts: ${cause.message}`, cause, 4);
    expect(is403QuotaOrRateLimitLike(wrapped)).toBe(true);
    expect(is403Like(wrapped)).toBe(false);
  });

  it("detects Azure-style remaining-tokens: 0 via plain Record headers (#940)", () => {
    const err = Object.assign(new Error("Forbidden"), {
      status: 403,
      headers: { "remaining-tokens": "0" } as Record<string, string>,
    });
    expect(is403QuotaOrRateLimitLike(err)).toBe(true);
    expect(is403Like(err)).toBe(false);
  });

  it("detects Azure retry-after via plain Record headers (#940)", () => {
    const err = Object.assign(new Error("Forbidden"), {
      status: 403,
      headers: { "retry-after": "30" } as Record<string, string>,
    });
    expect(is403QuotaOrRateLimitLike(err)).toBe(true);
    expect(is403Like(err)).toBe(false);
  });
});

describe("parseGoDurationToMs / parseRetryAfterMs (OpenAI x-ratelimit-reset-* #941)", () => {
  it("parses OpenAI-documented Go durations (not integer seconds)", () => {
    expect(parseGoDurationToMs("6m0s")).toBe(360_000);
    expect(parseGoDurationToMs("1s")).toBe(1000);
    expect(parseGoDurationToMs("500ms")).toBe(500);
  });

  it("uses x-ratelimit-reset-tokens as duration, not parseInt(6m0s)===6 seconds", () => {
    const err = { headers: { "x-ratelimit-reset-tokens": "6m0s" } };
    expect(parseRetryAfterMs(err)).toBe(360_000);
  });

  it("prefers Retry-After over x-ratelimit-reset when both present", () => {
    const err = {
      headers: {
        "retry-after": "5",
        "x-ratelimit-reset-tokens": "6m0s",
      },
    };
    expect(parseRetryAfterMs(err)).toBe(5000);
  });

  it("parses plain retry-after seconds only when the value is all digits", () => {
    expect(parseRetryAfterMs({ headers: { "retry-after": "1282" } })).toBe(1_282_000);
  });
});

describe("withLLMRetry — quota 403 retries (#940)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries on quota 403 (remaining-tokens: 0) and succeeds on later attempt", async () => {
    let attempt = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt <= 2) {
        throw Object.assign(new Error("403 status code (no body)"), {
          status: 403,
          headers: { "remaining-tokens": "0", "retry-after": "1" },
        });
      }
      return "success";
    });

    const promise = withLLMRetry(fn);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on geo 403 (no retry-after/remaining-tokens headers)", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("403 Forbidden"), { status: 403 }));

    await expect(withLLMRetry(fn)).rejects.toThrow("403 Forbidden");
    expect(fn).toHaveBeenCalledTimes(1);
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
          create: vi
            .fn()
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
      await vi.advanceTimersByTimeAsync(3 ** i * 1000);
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
          create: vi
            .fn()
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
        await vi.advanceTimersByTimeAsync(3 ** retry * 1000);
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
    vi.mocked(mockOpenai.chat.completions.create).mockRejectedValue(new Error("Internal Server Error"));
    await expect(chatComplete({ model: "gpt-4o", content: "test", openai: mockOpenai })).rejects.toThrow();
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#302: does not report '500 Internal Server Error' to Sentry", async () => {
    vi.mocked(mockOpenai.chat.completions.create).mockRejectedValue(new Error("500 Internal Server Error"));
    await expect(chatComplete({ model: "gpt-4o", content: "test", openai: mockOpenai })).rejects.toThrow();
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#303: does not report 404 Not Found to Sentry", async () => {
    vi.mocked(mockOpenai.chat.completions.create).mockRejectedValue(new Error("404 Not Found"));
    await expect(chatComplete({ model: "gpt-4o", content: "test", openai: mockOpenai })).rejects.toThrow();
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
          create: vi
            .fn()
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
    const err = Object.assign(new Error("403 Country, region, or territory not supported"), { status: 403 });
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
    const err = Object.assign(new Error("403 Country, region, or territory not supported"), { status: 403 });
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
          create: vi
            .fn()
            .mockRejectedValue(
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
          create: vi
            .fn()
            .mockRejectedValue(new Error("429 Too Many Requests: you have reached your weekly usage limit")),
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
          create: vi
            .fn()
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
    const fn = vi.fn().mockRejectedValue(new Error("429 429 Too Many Requests: weekly limit reached"));
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
          create: vi
            .fn()
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
    const unconfiguredCalls = vi
      .mocked(errorReporter.capturePluginError)
      .mock.calls.filter(([err]) => err instanceof UnconfiguredProviderError);
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
    expect(isOllamaOOM(new Error("model requires more system memory (18.2 GiB) than is available (8.0 GiB)"))).toBe(
      true,
    );
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

describe("isConnectionErrorLike (#703)", () => {
  it("detects OpenAI SDK APIConnectionError by name and cause", () => {
    const err = Object.assign(new Error("Connection error."), {
      name: "APIConnectionError",
      cause: { code: "ECONNREFUSED" },
    });
    expect(isConnectionErrorLike(err)).toBe(true);
  });

  it("does not match config or model errors", () => {
    expect(isConnectionErrorLike(Object.assign(new Error("404 Not Found"), { status: 404 }))).toBe(false);
    expect(isConnectionErrorLike(new Error("Provider 'openai' is not configured"))).toBe(false);
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

  it("#1010: matches gateway phrasing '502 error code: 502'", () => {
    expect(is500Like(new Error("502 error code: 502"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// withLLMRetry — non-retryable 400 (#1011, #1016)
// ---------------------------------------------------------------------------

describe("withLLMRetry — non-retryable 400 (#1011)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("#1165: does not retry generic 400 unsupported operation (single attempt)", async () => {
    const err = Object.assign(new Error("400 The requested operation is unsupported."), { status: 400 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow(/unsupported/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry 400 with empty body phrasing; enriches message with llmContext", async () => {
    const err = Object.assign(new Error("400 status code (no body)"), { status: 400 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withLLMRetry(fn, {
        maxRetries: 3,
        llmContext: { model: "azure/test", operation: "unit" },
      }),
    ).rejects.toThrow(/400 status code.*\[llm model=azure\/test/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("#1034: retries once for Responses API malformed reasoning sequence error", async () => {
    const err = Object.assign(
      new Error("400 Item 'rs_x' of type 'reasoning' was provided without its required following item."),
      { status: 400 },
    );
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce("ok");

    const promise = withLLMRetry(fn, {
      maxRetries: 3,
      llmContext: { model: "azure-foundry/o3-pro", operation: "unit" },
    });

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("#1034: stops after one retry when malformed reasoning sequence persists", async () => {
    const err = Object.assign(
      new Error("400 Item 'rs_x' of type 'reasoning' was provided without its required following item."),
      { status: 400 },
    );
    const fn = vi.fn().mockRejectedValue(err);

    const promise = withLLMRetry(fn, {
      maxRetries: 3,
      llmContext: { model: "azure-foundry/o3-pro", operation: "unit" },
    });
    const expectation = expect(promise).rejects.toThrow("required following item");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
    expect(fn).toHaveBeenCalledTimes(2);
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
          create: vi
            .fn()
            .mockRejectedValueOnce(oomErr) // primary: OOM
            .mockResolvedValueOnce({ choices: [{ message: { content: "fallback success" } }] }), // fallback: ok
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "ollama/qwen3:8b",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["google/gemini-2.5-flash-lite"],
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

describe("chatCompleteWithRetry — Responses reasoning sequence fallback (#1034)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("isResponsesReasoningSequenceError matches LLMRetryError wrapping the provider message", () => {
    const inner = new Error("400 Item 'rs_x' of type 'reasoning' was provided without its required following item.");
    const wrapped = new LLMRetryError(`Failed after 2 attempts: ${inner.message}`, inner, 2);
    expect(isResponsesReasoningSequenceError(wrapped)).toBe(true);
  });

  it("#1034: matches variant phrasing without 'its' before required", () => {
    const msg = "Item 'rs_abc' of type 'reasoning' was provided without required following item.";
    expect(isResponsesReasoningSequenceError(new Error(msg))).toBe(true);
  });

  it("#1034: isResponsesReasoningSequenceError returns false for unrelated errors", () => {
    expect(isResponsesReasoningSequenceError(new Error("400 invalid_request_error"))).toBe(false);
    expect(isResponsesReasoningSequenceError(new Error("context length exceeded"))).toBe(false);
  });

  it("azure-foundry/o3-pro uses reasoning model token params", () => {
    expect(isReasoningModel("azure-foundry/o3-pro")).toBe(true);
    expect(requiresMaxCompletionTokens("azure-foundry/o3-pro")).toBe(true);
  });

  it("falls back after one retry when primary hits malformed reasoning sequence 400", async () => {
    const err = Object.assign(
      new Error("400 Item 'rs_x' of type 'reasoning' was provided without its required following item."),
      { status: 400 },
    );
    const mockOpenai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(err)
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce({
              choices: [{ message: { content: "fallback ok" } }],
            }),
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "azure-foundry/o3-pro",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["azure-foundry/o3"],
      label: "test",
    });

    await vi.advanceTimersByTimeAsync(1100);
    const result = await promise;
    expect(result).toBe("fallback ok");
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledTimes(3);
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

  // #490: proxy/gateway may strip HTTP status and return message-only errors
  it("#490: returns true for 'Country, region, or territory not supported' without numeric prefix", () => {
    expect(is403Like(new Error("Country, region, or territory not supported"))).toBe(true);
  });

  it("#490: returns true for 'Country, region, or territory not supported' embedded in a longer message", () => {
    expect(is403Like(new Error("upstream error: Country, region, or territory not supported"))).toBe(true);
  });

  it("#490: returns true for PERMISSION_DENIED gRPC status in message", () => {
    expect(is403Like(new Error("PERMISSION_DENIED: Country, region, or territory not supported"))).toBe(true);
  });

  it("#490: returns true for standalone PERMISSION_DENIED without extra context", () => {
    expect(is403Like(new Error("PERMISSION_DENIED"))).toBe(true);
  });

  it("#490: returns true for 'access denied' (non-filesystem)", () => {
    expect(is403Like(new Error("access denied by provider"))).toBe(true);
  });

  it("#490: returns false for filesystem 'access denied' (e.g. EACCES)", () => {
    // Must not false-positive on OS-level permission errors
    expect(is403Like(new Error("access denied to file /etc/hosts"))).toBe(false);
    expect(is403Like(new Error("access denied: path /tmp/foo"))).toBe(false);
  });

  it("#490: returns false for 'access forbidden' on a directory", () => {
    expect(is403Like(new Error("access forbidden: directory /var/run"))).toBe(false);
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
    const err = Object.assign(new Error("403 Country, region, or territory not supported"), { status: 403 });
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
    const err = Object.assign(new Error("403 Country, region, or territory not supported"), { status: 403 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow("403 Country");
    // Must not have retried — short-circuits immediately
    expect(fn).toHaveBeenCalledTimes(1);
    // Must not report to GlitchTip
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  // #490: GlitchTip issue 324 — proxy/gateway strips HTTP status from the Error, leaving
  // only the provider's message body. The is403Like() check must still detect these.
  it("#490: withLLMRetry short-circuits on 'Country, region, or territory not supported' without numeric prefix (GlitchTip #324)", async () => {
    vi.clearAllMocks();
    // Simulates the exact error format that caused GlitchTip issue 324:
    // the proxy strips .status and the "403 " prefix, leaving only the provider message body.
    const err = new Error("Country, region, or territory not supported");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow("Country, region, or territory not supported");
    // Must NOT retry — should exit on first attempt
    expect(fn).toHaveBeenCalledTimes(1);
    // Must NOT create LLMRetryError and report to GlitchTip
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#490: withLLMRetry short-circuits on PERMISSION_DENIED (gRPC status) without .status property", async () => {
    vi.clearAllMocks();
    const err = new Error("PERMISSION_DENIED: Country, region, or territory not supported");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow("PERMISSION_DENIED");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#490: chatCompleteWithRetry falls back immediately when primary is geo-blocked (message-only 403)", async () => {
    // The geo-blocked model fails with a message-only error (no .status, no numeric prefix).
    // chatCompleteWithRetry must try the next model without retrying the geo-blocked one.
    const geoErr = new Error("Country, region, or territory not supported");
    const mockOpenai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(geoErr) // primary: geo-blocked (1 attempt, no retry)
            .mockResolvedValueOnce({ choices: [{ message: { content: "fallback ok" } }] }), // fallback: ok
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "google/gemini-2.5-flash",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["openai/gpt-4o-mini"],
      label: "#490 test",
    });

    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("fallback ok");
    // Primary must be called exactly once (no retry for geo-blocking), fallback once
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledTimes(2);
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#490: does not report to GlitchTip when ALL models are geo-blocked (message-only 403, no .status)", async () => {
    vi.clearAllMocks();
    const geoErr = new Error("Country, region, or territory not supported");
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(geoErr),
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

    const expectation = expect(promise).rejects.toThrow("Country, region");
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
    const drained = warnings.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatch(/403|country|region|access denied/i);
  });
});

describe("isContextLengthError (#442)", () => {
  it("detects the exact OpenAI error message", () => {
    const err = Object.assign(new Error("400 Invalid 'input': maximum context length is 8192 tokens."), {
      status: 400,
    });
    expect(isContextLengthError(err)).toBe(true);
  });

  it("detects status=400 with context length in message", () => {
    const err = Object.assign(new Error("400 Bad Request: context length exceeded"), { status: 400 });
    expect(isContextLengthError(err)).toBe(true);
  });

  it("does not match a generic 400 error", () => {
    const err = Object.assign(new Error("400 Bad Request: invalid model name"), { status: 400 });
    expect(isContextLengthError(err)).toBe(false);
  });

  it("does not match a 404 or 5xx error", () => {
    expect(isContextLengthError(new Error("404 Not Found"))).toBe(false);
    expect(isContextLengthError(new Error("500 Internal Server Error"))).toBe(false);
  });

  // #488: Ollama "Input length X exceeds maximum allowed token size N"
  it("#488: detects Ollama 'Input length exceeds maximum allowed token size' with status=400", () => {
    const err = Object.assign(new Error("Input length 768 exceeds maximum allowed token size 512"), { status: 400 });
    expect(isContextLengthError(err)).toBe(true);
  });

  it("#488: detects Ollama pattern with '400' prefix in message and status=400", () => {
    const err = Object.assign(new Error("400 Input length 768 exceeds maximum allowed token size 512"), {
      status: 400,
    });
    expect(isContextLengthError(err)).toBe(true);
  });

  it("#488: detects Ollama pattern without numeric status property (message-only)", () => {
    // Ollama may not always expose a .status property — match via message pattern
    const err = new Error("Input length 768 exceeds maximum allowed token size 512");
    expect(isContextLengthError(err)).toBe(true);
  });

  it("#488: does not false-positive on unrelated 400 errors mentioning 'input'", () => {
    const err = Object.assign(new Error("400 Bad Request: invalid input format"), { status: 400 });
    expect(isContextLengthError(err)).toBe(false);
  });
});

describe("withLLMRetry — context-length error (#442)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("#442: does not retry 400 context-length errors", async () => {
    const err = Object.assign(new Error("400 Invalid 'input': maximum context length is 8192 tokens."), {
      status: 400,
    });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow("maximum context length");
    // Must not have retried — short-circuits immediately
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("#488: does not retry Ollama 'Input length exceeds maximum allowed token size' error", async () => {
    const err = Object.assign(new Error("Input length 768 exceeds maximum allowed token size 512"), { status: 400 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow("Input length 768");
    // Must not have retried — short-circuits immediately
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("#488: does not report Ollama context-length error to GlitchTip", async () => {
    vi.clearAllMocks();
    const err = Object.assign(new Error("Input length 768 exceeds maximum allowed token size 512"), { status: 400 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withLLMRetry(fn, { maxRetries: 3 })).rejects.toThrow();
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });
});

describe("chatCompleteWithRetry — context-length error (#488)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("#488: falls through to next model immediately on context-length error", async () => {
    const contextLengthErr = Object.assign(new Error("Input length 768 exceeds maximum allowed token size 512"), {
      status: 400,
    });
    const mockOpenai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(contextLengthErr) // primary: context too long
            .mockResolvedValueOnce({ choices: [{ message: { content: "fallback ok" } }] }), // fallback: ok
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "ollama/qwen3:0.6b",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["gpt-4o-mini"],
    });

    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe("fallback ok");
    // Primary called once (no retry on context-length), fallback called once
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it("#488: does not report to GlitchTip when all models fail with context-length error", async () => {
    const contextLengthErr = Object.assign(new Error("Input length 768 exceeds maximum allowed token size 512"), {
      status: 400,
    });
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(contextLengthErr),
        },
      },
    } as unknown as import("openai").default;

    const warnings = createPendingLLMWarnings();
    const promise = chatCompleteWithRetry({
      model: "ollama/qwen3:0.6b",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["ollama/qwen3:1.7b"],
      pendingWarnings: warnings,
    });

    const expectation = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
    const drained = warnings.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatch(/context window|input.*long|exceeds/i);
  });
});

describe("chatCompleteWithRetry — connection error (#703)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("#703: falls through to next model when primary returns OpenAI SDK Connection error", async () => {
    const connectionErr = Object.assign(new Error("Connection error."), {
      name: "APIConnectionError",
      cause: { code: "ECONNRESET" },
    });
    const mockOpenai = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValueOnce(connectionErr)
            .mockRejectedValueOnce(connectionErr)
            .mockResolvedValueOnce({ choices: [{ message: { content: "fallback ok" } }] }),
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "openai/gpt-4o",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["openai/gpt-4o-mini"],
      label: "test",
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("fallback ok");
    expect(mockOpenai.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it("#703: does not report to GlitchTip when all models fail with OpenAI SDK Connection error", async () => {
    const connectionErr = Object.assign(new Error("Connection error."), {
      name: "APIConnectionError",
      cause: { code: "ECONNRESET" },
    });
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(connectionErr),
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "openai/gpt-4o",
      content: "test",
      openai: mockOpenai,
      fallbackModels: ["openai/gpt-4o-mini"],
    });

    const expectation = expect(promise).rejects.toThrow("Connection error.");
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });

  it("#935 #936: does not report to GlitchTip when retries exhaust on Request was aborted", async () => {
    const mockOpenai = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("Request was aborted")),
        },
      },
    } as unknown as import("openai").default;

    const promise = chatCompleteWithRetry({
      model: "openai/gpt-4o",
      content: "test",
      openai: mockOpenai,
      fallbackModels: [],
    });

    const expectation = expect(promise).rejects.toThrow("Request was aborted");
    await vi.runAllTimersAsync();
    await expectation;
    expect(errorReporter.capturePluginError).not.toHaveBeenCalled();
  });
});

describe("isAbortOrTransientLlmError", () => {
  it("detects Request was aborted", () => {
    expect(isAbortOrTransientLlmError(new Error("Request was aborted."))).toBe(true);
  });

  it("detects gateway stopped / unreachable phrasing", () => {
    expect(isAbortOrTransientLlmError(new Error("gateway client stopped"))).toBe(true);
    expect(isAbortOrTransientLlmError(new Error("Gateway not reachable. Is it running?"))).toBe(true);
  });

  it("unwraps LLMRetryError cause", () => {
    const inner = new Error("Request was aborted.");
    expect(isAbortOrTransientLlmError(new LLMRetryError("wrap", inner, 1))).toBe(true);
  });

  it("returns false for arbitrary model failure", () => {
    expect(isAbortOrTransientLlmError(new Error("model not found"))).toBe(false);
  });
});

describe("resolveWireApi", () => {
  it('returns "responses" for azure-foundry-responses prefix', () => {
    expect(resolveWireApi("azure-foundry-responses/o3-pro")).toBe("responses");
    expect(resolveWireApi("azure-foundry-responses/gpt-5.4-pro")).toBe("responses");
  });

  it('returns "chat" for standard providers', () => {
    expect(resolveWireApi("openai/gpt-4o")).toBe("chat");
    expect(resolveWireApi("google/gemini-2.0-flash")).toBe("chat");
    expect(resolveWireApi("azure-foundry/gpt-5.4-nano")).toBe("chat");
    expect(resolveWireApi("anthropic/claude-sonnet-4-5")).toBe("chat");
  });

  it("respects explicit wireApi override", () => {
    expect(resolveWireApi("openai/gpt-4o", "responses")).toBe("responses");
    expect(resolveWireApi("azure-foundry-responses/o3-pro", "chat")).toBe("chat");
  });

  it('defaults to "chat" for bare model names', () => {
    expect(resolveWireApi("gpt-4o")).toBe("chat");
    expect(resolveWireApi("o3-pro")).toBe("chat");
  });
});

describe("chatComplete with wireApi='responses'", () => {
  const mockResponsesCreate = vi.fn().mockResolvedValue({
    id: "resp_123",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Response from Responses API" }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  const mockOpenaiWithResponses = {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
    responses: {
      create: mockResponsesCreate,
    },
  } as unknown as import("openai").default;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses responses.create when wireApi is 'responses'", async () => {
    const result = await chatComplete({
      model: "azure-foundry-responses/o3-pro",
      content: "test",
      openai: mockOpenaiWithResponses,
      wireApi: "responses",
    });
    expect(result).toBe("Response from Responses API");
    expect(mockResponsesCreate).toHaveBeenCalled();
    expect(mockOpenaiWithResponses.chat.completions.create).not.toHaveBeenCalled();
  });

  it("auto-detects responses wire for azure-foundry-responses prefix", async () => {
    const result = await chatComplete({
      model: "azure-foundry-responses/o3-pro",
      content: "test",
      openai: mockOpenaiWithResponses,
    });
    expect(result).toBe("Response from Responses API");
    expect(mockResponsesCreate).toHaveBeenCalled();
  });

  it("still uses chat.completions.create for standard models", async () => {
    vi.mocked(mockOpenaiWithResponses.chat.completions.create).mockResolvedValue({
      choices: [{ message: { content: "Hello from Chat" } }],
    } as any);

    const result = await chatComplete({
      model: "openai/gpt-4o",
      content: "test",
      openai: mockOpenaiWithResponses,
    });
    expect(result).toBe("Hello from Chat");
    expect(mockOpenaiWithResponses.chat.completions.create).toHaveBeenCalled();
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });
});
