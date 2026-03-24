/**
 * Test suite specifically for UnconfiguredProviderError guard behavior.
 * Uses vi.stubGlobal to mock native fetch so we can verify whether events
 * are sent or suppressed without making real HTTP calls.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

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
    delete process.env.OPENCLAW_NODE_NAME;
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

    process.env.OPENCLAW_NODE_NAME = "Maeve";
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
});
