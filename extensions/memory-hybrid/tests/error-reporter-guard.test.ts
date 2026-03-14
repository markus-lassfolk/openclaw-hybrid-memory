/**
 * Test suite specifically for UnconfiguredProviderError guard behavior
 * This file uses vi.mock() at the top level to properly mock Sentry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Sentry at the module level BEFORE any imports
const mockCaptureException = vi.fn().mockReturnValue("mock-event-id");
const mockWithScope = vi.fn((callback) => {
  const mockScope = {
    setTag: vi.fn(),
    setContext: vi.fn(),
  };
  callback(mockScope);
});
const mockInit = vi.fn();
const mockSetTag = vi.fn();
const mockAddBreadcrumb = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(true);

vi.mock("@sentry/node", () => ({
  init: mockInit,
  captureException: mockCaptureException,
  withScope: mockWithScope,
  setTag: mockSetTag,
  addBreadcrumb: mockAddBreadcrumb,
  flush: mockFlush,
}));

describe("UnconfiguredProviderError guard with mocked Sentry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("capturePluginError still reports regular errors (non-UnconfiguredProviderError)", async () => {
    const { initErrorReporter, capturePluginError } = await import("../services/error-reporter.js");

    // Initialize the reporter to enable error capture
    await initErrorReporter(
      {
        enabled: true,
        consent: true,
        mode: "community",
        dsn: "https://test@example.com/1",
        maxBreadcrumbs: 0,
        sampleRate: 1.0,
      },
      "test",
    );

    // Verify init was called
    expect(mockInit).toHaveBeenCalled();

    // Clear mocks to focus on capturePluginError behavior
    vi.clearAllMocks();

    const regularErr = new Error("Something unexpected broke");
    capturePluginError(regularErr, { operation: "test-regular-error" });

    // Verify that captureException WAS called (guard did not suppress)
    expect(mockCaptureException).toHaveBeenCalledWith(regularErr);
    expect(mockWithScope).toHaveBeenCalled();
  });

  it("capturePluginError suppresses UnconfiguredProviderError without calling Sentry", async () => {
    const { capturePluginError } = await import("../services/error-reporter.js");

    // Clear mocks from previous test
    vi.clearAllMocks();

    // Construct UnconfiguredProviderError
    const err = Object.assign(new Error("Provider 'openrouter' is not configured"), {
      name: "UnconfiguredProviderError",
    });

    const result = capturePluginError(err, { operation: "test-suppression" });

    // Must return undefined
    expect(result).toBeUndefined();

    // Verify that captureException was NOT called (guard suppressed it)
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockWithScope).not.toHaveBeenCalled();
  });
});
