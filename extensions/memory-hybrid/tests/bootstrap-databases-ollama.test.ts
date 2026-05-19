/**
 * Bootstrap Ollama auto-start regression (#1480–#1483).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import { _resetOllamaAutoStartForTesting, maybeAutoStartOllama } from "../setup/bootstrap-databases.js";

const probeOllamaEndpoint = vi.fn();
const clearOllamaHealthCacheEntry = vi.fn();
const spawnMock = vi.fn();

vi.mock("../setup/provider-router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../setup/provider-router.js")>();
  return {
    ...actual,
    probeOllamaEndpoint: (...args: unknown[]) => probeOllamaEndpoint(...args),
    clearOllamaHealthCacheEntry: (...args: unknown[]) => clearOllamaHealthCacheEntry(...args),
  };
});

vi.mock("../utils/process-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/process-runner.js")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

describe("maybeAutoStartOllama", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetOllamaAutoStartForTesting();
    probeOllamaEndpoint.mockReset();
    clearOllamaHealthCacheEntry.mockReset();
    spawnMock.mockReset();
    probeOllamaEndpoint.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns detached ollama serve with error handler when Ollama is down and localAutoStart is enabled", async () => {
    const errorHandlers: Record<string, (err: Error) => void> = {};
    spawnMock.mockReturnValue({
      on: (event: string, cb: (err: Error) => void) => {
        if (event === "error") errorHandlers.error = cb;
      },
      unref: vi.fn(),
    });

    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough", model: "text-embedding-3-small" },
      llm: {
        localAutoStart: true,
        default: ["ollama/llama3"],
        providers: { ollama: { baseURL: "http://127.0.0.1:11434/v1" } },
      },
    });
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    };

    maybeAutoStartOllama(cfg, api as never);
    await vi.advanceTimersByTimeAsync(2500);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    expect(spawnMock).toHaveBeenCalledWith(
      "ollama",
      ["serve"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(errorHandlers.error).toBeTypeOf("function");
    expect(() => errorHandlers.error?.(new Error("spawn ENOENT"))).not.toThrow();
  });

  it("does not leave unhandled rejection when spawn emits error before handlers attach (#1480)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    spawnMock.mockImplementation(() => {
      const fake = {
        on: vi.fn(),
        unref: vi.fn(),
      };
      queueMicrotask(() => {
        for (const call of (fake.on as ReturnType<typeof vi.fn>).mock.calls) {
          if (call[0] === "error") {
            (call[1] as (err: Error) => void)(new Error("spawn failed"));
          }
        }
      });
      return fake;
    });

    const cfg = hybridConfigSchema.parse({
      embedding: { apiKey: "sk-test-key-that-is-long-enough", model: "text-embedding-3-small" },
      llm: {
        localAutoStart: true,
        default: ["ollama/llama3"],
        providers: { ollama: { baseURL: "http://127.0.0.1:11434/v1" } },
      },
    });
    const api = {
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    };

    try {
      maybeAutoStartOllama(cfg, api as never);
      await vi.advanceTimersByTimeAsync(2500);
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
