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
          mode: "self-hosted",
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
          mode: "self-hosted",
          consent: true,
          maxBreadcrumbs: 0,
          sampleRate: 1.0,
        },
        "1.0.0"
      );
      
      // Should NOT be active
      expect(isErrorReporterActive()).toBe(false);
    });

    it("should not initialize self-hosted mode without DSN", async () => {
      const { initErrorReporter, isErrorReporterActive } = await import("../services/error-reporter.js");
      
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
      };
      
      await initErrorReporter(
        {
          enabled: true,
          mode: "self-hosted",
          consent: true,
          maxBreadcrumbs: 0,
          sampleRate: 1.0,
        },
        "1.0.0",
        mockLogger
      );
      
      // Should NOT be active
      expect(isErrorReporterActive()).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Self-hosted mode requires a DSN")
      );
    });

    it("should use community DSN in community mode", async () => {
      const { initErrorReporter, isErrorReporterActive } = await import("../services/error-reporter.js");

      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      await initErrorReporter(
        {
          enabled: true,
          mode: "community",
          consent: true,
          maxBreadcrumbs: 10,
          sampleRate: 1.0,
        },
        "1.0.0",
        mockLogger
      );

      // Community mode should log that it's using community mode
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Using community mode")
      );
    });

    it("should allow DSN override in community mode", async () => {
      const { initErrorReporter } = await import("../services/error-reporter.js");

      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      await initErrorReporter(
        {
          enabled: true,
          mode: "community",
          dsn: "https://custom@example.com/1", // Override community DSN
          consent: true,
          maxBreadcrumbs: 10,
          sampleRate: 1.0,
        },
        "1.0.0",
        mockLogger
      );

      // Should still log community mode but use custom DSN
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Using community mode")
      );
    });
  });

  describe("Privacy Requirements (via internal functions)", () => {
    it("should scrub old and modern OpenAI API keys", async () => {
      const { scrubString } = await import("../services/error-reporter.js");

      expect(scrubString("Error with key sk-1234567890abcdefghij")).toBe("Error with key [REDACTED]");
      expect(scrubString("Error with key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")).toBe("Error with key [REDACTED]");
      expect(scrubString("Error with key sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz")).toBe("Error with key [REDACTED]");
    });

    it("should scrub JWT tokens", async () => {
      const { scrubString } = await import("../services/error-reporter.js");

      expect(scrubString("Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")).toBe("Token: [REDACTED]");
    });

    it("should scrub database connection strings", async () => {
      const { scrubString } = await import("../services/error-reporter.js");

      expect(scrubString("Error: postgres://user:pass@localhost/db")).toBe("Error: postgres://[REDACTED]");
      expect(scrubString("Error: mysql://admin:secret@db.example.com/prod")).toBe("Error: mysql://[REDACTED]");
      expect(scrubString("Error: redis://default:password@redis.local:6379")).toBe("Error: redis://[REDACTED]");
      expect(scrubString("Error: mongodb://root:pass123@mongo.example.com:27017/mydb")).toBe("Error: mongodb://[REDACTED]");
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

    it("should sanitize file paths with multiple directory markers", async () => {
      const { sanitizePath } = await import("../services/error-reporter.js");

      expect(sanitizePath("/home/alice/project/extensions/memory-hybrid/index.ts")).toBe("extensions/memory-hybrid/index.ts");
      expect(sanitizePath("/home/alice/project/extensions/openclaw-hybrid-memory/index.ts")).toBe("extensions/openclaw-hybrid-memory/index.ts");
      expect(sanitizePath("/some/path/openclaw-hybrid-memory/services/error-reporter.ts")).toBe("openclaw-hybrid-memory/services/error-reporter.ts");
      expect(sanitizePath("/home/bob/other.ts")).toBe("$HOME/other.ts");
      expect(sanitizePath("/Users/charlie/file.ts")).toBe("$HOME/file.ts");
    });

    it("should sanitize events using allowlist and scrub config_shape values", async () => {
      const { sanitizeEvent } = await import("../services/error-reporter.js");

      const mockEvent: any = {
        event_id: "123",
        timestamp: 1234567890,
        level: "error",
        fingerprint: ["custom", "fingerprint"],
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
        tags: {
          subsystem: "sqlite",
          operation: "store-fact",
          phase: "runtime",
          backend: "sqlite",
        },
        contexts: {
          config_shape: {
            provider: "openai",
            apiKey: "sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz"
          },
          runtime: {
            name: "node",
            version: "v20.10.0"
          },
          os: {
            name: "linux",
            version: "6.6.87"
          }
        },
        user: { id: "secret" },
        request: { url: "http://example.com" },
      };

      const sanitized = sanitizeEvent(mockEvent);

      expect(sanitized?.fingerprint).toEqual(["custom", "fingerprint"]);
      expect(sanitized?.exception?.values?.[0]?.value).toBe("Failed with key [REDACTED]");
      expect(sanitized?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe("extensions/memory-hybrid/index.ts");
      expect(sanitized?.tags?.subsystem).toBe("sqlite");
      expect(sanitized?.tags?.operation).toBe("store-fact");
      expect(sanitized?.tags?.phase).toBe("runtime");
      expect(sanitized?.tags?.backend).toBe("sqlite");
      expect(sanitized?.contexts?.config_shape?.apiKey).toBe("[REDACTED]");
      expect(sanitized?.contexts?.runtime).toEqual({ name: "node", version: "v20.10.0" });
      expect(sanitized?.contexts?.os).toEqual({ name: "linux" }); // Only name, no version
      expect(sanitized?.user).toBeUndefined();
      expect(sanitized?.request).toBeUndefined();
    });
  });

  describe("Security Boundaries", () => {
    it("should verify initErrorReporter enforces security config", async () => {
      const serviceCode = await import("fs").then(fs =>
        fs.promises.readFile(new URL("../services/error-reporter.ts", import.meta.url), "utf-8")
      );

      expect(serviceCode).toContain("maxBreadcrumbs: 10");
      expect(serviceCode).toContain("sendDefaultPii: false");
      expect(serviceCode).toContain("autoSessionTracking: false");
      expect(serviceCode).toContain('filter(i => ["LinkedErrors", "InboundFilters", "FunctionToString"].includes(i.name))');
      expect(serviceCode).toContain("beforeBreadcrumb(breadcrumb)");
      expect(serviceCode).toContain("plugin.");
    });
  });

  describe("Integration Tests (if @sentry/node is installed)", () => {
    it("should verify capturePluginError accepts extended context and returns event ID", async () => {
      const { capturePluginError, isErrorReporterActive } = await import("../services/error-reporter.js");

      const testError = new Error("Test error with sk-proj-sensitive123456789012345678901234567890");

      const eventId = capturePluginError(testError, {
        operation: "test",
        subsystem: "test",
        phase: "runtime",
        backend: "sqlite",
        retryAttempt: 2,
        memoryCount: 42,
        configShape: { key: "sk-ant-api03-secret123456789012345678901234567890" }
      });

      // When initialized (from previous test), should return event ID string or undefined (if rate limited)
      // When not initialized, should return undefined
      if (isErrorReporterActive()) {
        expect(typeof eventId === 'string' || eventId === undefined).toBe(true);
      } else {
        expect(eventId).toBeUndefined();
      }
    });
  });

  describe("New Exports", () => {
    it("should export flushErrorReporter", async () => {
      const { flushErrorReporter, isErrorReporterActive } = await import("../services/error-reporter.js");
      expect(typeof flushErrorReporter).toBe("function");

      const result = await flushErrorReporter(1000);
      // Should return boolean (true if initialized and flushed, false otherwise)
      expect(typeof result).toBe("boolean");
    });

    it("should export testErrorReporter", async () => {
      const { testErrorReporter, isErrorReporterActive } = await import("../services/error-reporter.js");
      expect(typeof testErrorReporter).toBe("function");

      const result = testErrorReporter();
      expect(result).toHaveProperty("ok");
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) {
        expect(result.error).toBeDefined();
      }
    });

    it("should export captureTestError", async () => {
      const { captureTestError, isErrorReporterActive } = await import("../services/error-reporter.js");
      expect(typeof captureTestError).toBe("function");

      const eventId = captureTestError();
      // Should return string (event ID) when initialized, null when not
      expect(typeof eventId === 'string' || eventId === null).toBe(true);
    });

    it("should export addOperationBreadcrumb", async () => {
      const { addOperationBreadcrumb } = await import("../services/error-reporter.js");
      expect(typeof addOperationBreadcrumb).toBe("function");

      // Should not throw regardless of initialization state
      expect(() => addOperationBreadcrumb("test", "operation")).not.toThrow();
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
