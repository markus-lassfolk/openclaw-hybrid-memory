/**
 * Test suite for error-reporter service
 * 
 * These tests ensure the privacy-first error reporting implementation
 * does NOT leak sensitive data like prompts, API keys, home paths, IPs, or emails.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// We can't directly import the service functions since they depend on Sentry,
// which is an optional dependency. Instead, we'll test the sanitization logic
// by exporting it separately or by mocking Sentry.

// For now, we'll test the module loading behavior and privacy constraints
describe("Error Reporter", () => {
  describe("Module Loading", () => {
    it("should gracefully handle missing @sentry/node dependency", async () => {
      // This test verifies that the module doesn't crash when @sentry/node is not installed
      // In a real scenario, we'd mock require() to throw, but for now we just verify import works
      const { initErrorReporter, isErrorReporterActive } = await import("../services/error-reporter.js");
      expect(typeof initErrorReporter).toBe("function");
      expect(typeof isErrorReporterActive).toBe("function");
    });
  });

  describe("Configuration Validation", () => {
    it("should not initialize without consent", async () => {
      const { initErrorReporter, isErrorReporterActive } = await import("../services/error-reporter.js");
      
      // Try to init without consent
      await initErrorReporter(
        {
          enabled: true,
          dsn: "https://fake@example.com/1",
          consent: false, // NO CONSENT
          maxBreadcrumbs: 0,
          sampleRate: 1.0,
        },
        "1.0.0"
      );
      
      // Should NOT be active
      expect(isErrorReporterActive()).toBe(false);
    });

    it("should not initialize when disabled", async () => {
      const { initErrorReporter, isErrorReporterActive } = await import("../services/error-reporter.js");
      
      await initErrorReporter(
        {
          enabled: false, // DISABLED
          dsn: "https://fake@example.com/1",
          consent: true,
          maxBreadcrumbs: 0,
          sampleRate: 1.0,
        },
        "1.0.0"
      );
      
      // Should NOT be active
      expect(isErrorReporterActive()).toBe(false);
    });

    it("should not initialize without DSN", async () => {
      const { initErrorReporter, isErrorReporterActive } = await import("../services/error-reporter.js");
      
      await initErrorReporter(
        {
          enabled: true,
          dsn: "", // NO DSN
          consent: true,
          maxBreadcrumbs: 0,
          sampleRate: 1.0,
        },
        "1.0.0"
      );
      
      // Should NOT be active
      expect(isErrorReporterActive()).toBe(false);
    });
  });

  describe("Privacy Requirements (via internal functions)", () => {
    it("should scrub old and modern OpenAI API keys", async () => {
      const { scrubString } = await import("../services/error-reporter.js");
      
      expect(scrubString("Error with key sk-1234567890abcdefghij")).toBe("Error with key [REDACTED]");
      expect(scrubString("Error with key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")).toBe("Error with key [REDACTED]");
      expect(scrubString("Error with key sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz")).toBe("Error with key [REDACTED]");
    });

    it("should scrub GitHub tokens and Bearer tokens", async () => {
      const { scrubString } = await import("../services/error-reporter.js");
      
      expect(scrubString("Token: ghp_" + "a".repeat(36))).toBe("Token: [REDACTED]");
      expect(scrubString("Authorization: Bearer abc123.def456.ghi789")).toBe("Authorization: [REDACTED]");
    });

    it("should scrub home paths and PII", async () => {
      const { scrubString } = await import("../services/error-reporter.js");
      
      expect(scrubString("File at /home/alice/file.txt")).toBe("File at $HOME/file.txt");
      expect(scrubString("File at /Users/bob/file.txt")).toBe("File at $HOME/file.txt");
      expect(scrubString("Email: user@example.com")).toBe("Email: [EMAIL]");
      expect(scrubString("IP: 192.168.1.1")).toBe("IP: [IP]");
    });

    it("should sanitize file paths", async () => {
      const { sanitizePath } = await import("../services/error-reporter.js");
      
      expect(sanitizePath("/home/alice/project/extensions/memory-hybrid/index.ts")).toBe("extensions/memory-hybrid/index.ts");
      expect(sanitizePath("/home/bob/other.ts")).toBe("$HOME/other.ts");
      expect(sanitizePath("/Users/charlie/file.ts")).toBe("$HOME/file.ts");
    });

    it("should sanitize events using allowlist and scrub config_shape values", async () => {
      const { sanitizeEvent } = await import("../services/error-reporter.js");
      
      const mockEvent: any = {
        event_id: "123",
        timestamp: 1234567890,
        level: "error",
        exception: {
          values: [{
            type: "Error",
            value: "Failed with key sk-proj-abc123def456ghi789jkl012mno345pqr678",
            stacktrace: {
              frames: [{
                filename: "/home/user/project/extensions/memory-hybrid/index.ts",
                function: "test",
                lineno: 10,
              }]
            }
          }]
        },
        contexts: {
          config_shape: {
            provider: "openai",
            apiKey: "sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz"
          }
        },
        user: { id: "secret" },
        request: { url: "http://example.com" },
      };
      
      const sanitized = sanitizeEvent(mockEvent);
      
      expect(sanitized?.exception?.values?.[0]?.value).toBe("Failed with key [REDACTED]");
      expect(sanitized?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe("extensions/memory-hybrid/index.ts");
      expect(sanitized?.contexts?.config_shape?.apiKey).toBe("[REDACTED]");
      expect(sanitized?.user).toBeUndefined();
      expect(sanitized?.request).toBeUndefined();
    });
  });

  describe("Security Boundaries", () => {
    it("should verify initErrorReporter enforces security config", async () => {
      const serviceCode = await import("fs").then(fs => 
        fs.promises.readFile(new URL("../services/error-reporter.ts", import.meta.url), "utf-8")
      );
      
      expect(serviceCode).toContain("maxBreadcrumbs: 0");
      expect(serviceCode).toContain("sendDefaultPii: false");
      expect(serviceCode).toContain("autoSessionTracking: false");
      expect(serviceCode).toContain("integrations: []");
      expect(serviceCode).toContain("beforeBreadcrumb()");
      expect(serviceCode).toContain("return null");
    });
  });

  describe("Integration Tests (if @sentry/node is installed)", () => {
    it("should verify capturePluginError accepts safe context", async () => {
      const { capturePluginError, isErrorReporterActive } = await import("../services/error-reporter.js");
      
      const testError = new Error("Test error with sk-proj-sensitive123456789012345678901234567890");
      
      capturePluginError(testError, {
        operation: "test",
        subsystem: "test",
        configShape: { key: "sk-ant-api03-secret123456789012345678901234567890" }
      });
      
      expect(isErrorReporterActive()).toBe(false);
    });
  });
});

// Helper to check if @sentry/node is installed
async function checkSentryInstalled(): Promise<boolean> {
  try {
    await import("@sentry/node");
    return true;
  } catch {
    return false;
  }
}
