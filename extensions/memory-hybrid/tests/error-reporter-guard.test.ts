import { setEnv } from "../utils/env-manager.js";
/**
 * Test suite specifically for UnconfiguredProviderError guard behavior.
 * Uses vi.stubGlobal to mock native fetch so we can verify whether events
 * are sent or suppressed without making real HTTP calls.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Stub fetch globally before any imports so the reporter never makes real HTTP calls
const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
vi.stubGlobal("fetch", mockFetch);

describe("UnconfiguredProviderError guard with mocked fetch", () => {
  beforeAll(async () => {
    // Initialize the reporter once for the whole describe block
    const { initErrorReporter } = await import("../services/error-reporter.js");
    await initErrorReporter(
      {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testguardkey@example.com/1",
        maxBreadcrumbs: 0,
        sampleRate: 1.0,
      },
      "guard-test",
    );
  });

  beforeEach(() => {
    mockFetch.mockClear();
    setEnv("OPENCLAW_NODE_NAME", undefined);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("capturePluginError still reports regular errors (non-UnconfiguredProviderError)", async () => {
    const { capturePluginError, flushErrorReporter } = await import("../services/error-reporter.js");

    const regularErr = new Error("Something unexpected broke");
    capturePluginError(regularErr, { operation: "test-regular-error" });

    // Wait for the fire-and-forget fetch to complete
    await flushErrorReporter(500);

    // Verify that fetch WAS called (guard did not suppress)
    expect(mockFetch).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("capturePluginError includes runtime node and agent tags for filtering", async () => {
    const { initErrorReporter, capturePluginError, flushErrorReporter } = await import("../services/error-reporter.js");

    setEnv("OPENCLAW_NODE_NAME", "Maeve");
    await initErrorReporter(
      {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://testguardkey@example.com/1",
        maxBreadcrumbs: 0,
        sampleRate: 1.0,
        botName: "Doris",
      },
      "guard-test",
      undefined,
      "agent-706",
    );

    capturePluginError(new Error("Node-tag verification failure"), { operation: "test-node-tag" });
    await flushErrorReporter(500);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, requestInit] = mockFetch.mock.calls[0];
    const payload = JSON.parse(String(requestInit?.body ?? "{}"));

    expect(payload.server_name).toBe("Maeve");
    expect(payload.tags?.node).toBe("Maeve");
    expect(payload.tags?.agent_id).toBe("agent-706");
    expect(payload.tags?.agent_name).toBe("Doris");
    expect(payload.tags?.bot_id).toBe("agent-706");
    expect(payload.tags?.bot_name).toBe("Doris");
  });

  it("capturePluginError suppresses UnconfiguredProviderError without calling fetch", async () => {
    const { capturePluginError, flushErrorReporter } = await import("../services/error-reporter.js");

    const err = Object.assign(new Error("Provider 'openrouter' is not configured"), {
      name: "UnconfiguredProviderError",
    });

    const result = capturePluginError(err, { operation: "test-suppression" });

    await flushErrorReporter(500);

    // Must return undefined
    expect(result).toBeUndefined();
    // Verify that fetch was NOT called (guard suppressed it)
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("capturePluginError suppresses transient network errors without calling fetch", async () => {
    const { capturePluginError, flushErrorReporter } = await import("../services/error-reporter.js");

    const result = capturePluginError(new Error("ECONNREFUSED http://localhost:11434"), {
      operation: "test-network-suppression",
    });

    await flushErrorReporter(500);

    expect(result).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("capturePluginError suppresses auth errors without calling fetch", async () => {
    const { capturePluginError, flushErrorReporter } = await import("../services/error-reporter.js");

    const result = capturePluginError(Object.assign(new Error("401 Unauthorized"), { status: 401 }), {
      operation: "test-auth-suppression",
    });

    await flushErrorReporter(500);

    expect(result).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("capturePluginError suppresses circuit-breaker-open errors without calling fetch", async () => {
    const { capturePluginError, flushErrorReporter } = await import("../services/error-reporter.js");

    const result = capturePluginError(new Error("Ollama circuit breaker open — retrying in 30s"), {
      operation: "test-circuit-breaker-suppression",
    });

    await flushErrorReporter(500);

    expect(result).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("applies 24h dedupe only to invalid_goal_registry_entry, not other fingerprinted warnings (#1988)", async () => {
    const { capturePluginError, flushErrorReporter, resetErrorDedupForTests } = await import(
      "../services/error-reporter.js"
    );
    const fp = ["test-chronic-scope", "unit-file.json"];
    const t0 = Date.now();

    resetErrorDedupForTests();
    vi.setSystemTime(t0);
    mockFetch.mockClear();
    capturePluginError(new Error("generic warning"), {
      operation: "goal_registry_scan",
      severity: "warning",
      fingerprint: fp,
    });
    await flushErrorReporter(500);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockClear();
    vi.setSystemTime(t0 + 90_000);
    capturePluginError(new Error("generic warning after 90s"), {
      operation: "goal_registry_scan",
      severity: "warning",
      fingerprint: fp,
    });
    await flushErrorReporter(500);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    resetErrorDedupForTests();
    vi.setSystemTime(t0);
    mockFetch.mockClear();
    capturePluginError(new Error("invalid goal entry"), {
      operation: "invalid_goal_registry_entry",
      severity: "warning",
      fingerprint: fp,
    });
    await flushErrorReporter(500);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockClear();
    vi.setSystemTime(t0 + 90_000);
    capturePluginError(new Error("invalid goal entry after 90s"), {
      operation: "invalid_goal_registry_entry",
      severity: "warning",
      fingerprint: fp,
    });
    await flushErrorReporter(500);
    expect(mockFetch).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
