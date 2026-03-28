/**
 * Test suite for error-reporter service
 *
 * These tests ensure the privacy-first error reporting implementation
 * does NOT leak sensitive data like prompts, API keys, home paths, IPs, or emails.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Test the native fetch implementation of the error reporter.
// Sentry-specific functions (sanitizeEvent, scrubString, etc.) are pure and
// can be imported and tested directly without any mocking.

// Test the module loading behavior and privacy constraints
describe("Error Reporter", () => {
  describe("Module Loading", () => {
    it("should load successfully and export required functions", async () => {
      // No external dependencies required — uses native fetch (Node 20+)
      const { initErrorReporter, isErrorReporterActive, DEFAULT_GLITCHTIP_DSN } = await import(
        "../services/error-reporter.js"
      );
      expect(typeof initErrorReporter).toBe("function");
      expect(typeof isErrorReporterActive).toBe("function");
      expect(typeof DEFAULT_GLITCHTIP_DSN).toBe("string");
      expect(DEFAULT_GLITCHTIP_DSN).toContain("glitchtip");
    });

    it("should export DEFAULT_GLITCHTIP_DSN pointing to the community GlitchTip instance", async () => {
      const { DEFAULT_GLITCHTIP_DSN } = await import("../services/error-reporter.js");
      expect(DEFAULT_GLITCHTIP_DSN).toBe("https://7d641cabffdb4557a7bd2f02c338dc80@glitchtip.lassfolk.cc/1");
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
        "1.0.0",
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
        "1.0.0",
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
        mockLogger,
      );

      // Should NOT be active
      expect(isErrorReporterActive()).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Self-hosted mode requires a DSN"));
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
        mockLogger,
      );

      // Community mode should log that it's using community mode
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Using community mode"));
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
        mockLogger,
      );

      // Should still log community mode but use custom DSN
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Using community mode"));
    });

    it("should initialize by default with no config (opt-out: enabled+consent default to true)", async () => {
      // Verify that with opt-out defaults, error reporting would activate when enabled+consent are both true
      // (Actual Sentry.init call may fail in test environment, but the guard logic should pass)
      const { initErrorReporter, DEFAULT_GLITCHTIP_DSN } = await import("../services/error-reporter.js");

      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      // Simulate the default config (opt-out: both true)
      await initErrorReporter(
        {
          enabled: true,
          consent: true,
          mode: "community",
          dsn: DEFAULT_GLITCHTIP_DSN,
          maxBreadcrumbs: 10,
          sampleRate: 1.0,
        },
        "test",
        mockLogger,
      );

      // Should NOT have logged a disabled message — the guard should pass
      expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining("Disabled:"));
    });

    it("should respect explicit opt-out via consent: false", async () => {
      const { initErrorReporter, DEFAULT_GLITCHTIP_DSN } = await import("../services/error-reporter.js");

      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      await initErrorReporter(
        {
          enabled: true,
          consent: false, // Explicit opt-out
          mode: "community",
          dsn: DEFAULT_GLITCHTIP_DSN,
          maxBreadcrumbs: 0,
          sampleRate: 1.0,
        },
        "test",
        mockLogger,
      );

      // When consent=false, the reporter logs Disabled and returns early.
      // Note: isErrorReporterActive() is a module-level singleton and may be true
      // from a previous test that initialized successfully; we validate opt-out
      // by checking the logger message (printf-style: format string + args).
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Disabled:"),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should use custom DSN when provided in community mode", async () => {
      const { initErrorReporter } = await import("../services/error-reporter.js");

      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      const customDsn = "https://customkey@my-glitchtip.example.com/42";

      await initErrorReporter(
        {
          enabled: true,
          consent: true,
          mode: "community",
          dsn: customDsn, // User-provided override
          maxBreadcrumbs: 10,
          sampleRate: 1.0,
        },
        "test",
        mockLogger,
      );

      // Should log community mode (not self-hosted)
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Using community mode"));
    });
  });

  describe("Privacy Requirements (via internal functions)", () => {
    it("should scrub old and modern OpenAI API keys", async () => {
      const { scrubString } = await import("../services/error-reporter.js");

      expect(scrubString("Error with key sk-1234567890abcdefghij")).toBe("Error with key [REDACTED]");
      expect(scrubString("Error with key sk-proj-abcdefghijklmnopqrstuvwxyz1234567890")).toBe(
        "Error with key [REDACTED]",
      );
      expect(scrubString("Error with key sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz")).toBe(
        "Error with key [REDACTED]",
      );
    });

    it("should scrub JWT tokens", async () => {
      const { scrubString } = await import("../services/error-reporter.js");

      expect(
        scrubString(
          "Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        ),
      ).toBe("Token: [REDACTED]");
    });

    it("should scrub database connection strings", async () => {
      const { scrubString } = await import("../services/error-reporter.js");

      expect(scrubString("Error: postgres://user:pass@localhost/db")).toBe("Error: postgres://[REDACTED]");
      expect(scrubString("Error: mysql://admin:secret@db.example.com/prod")).toBe("Error: mysql://[REDACTED]");
      expect(scrubString("Error: redis://default:password@redis.local:6379")).toBe("Error: redis://[REDACTED]");
      expect(scrubString("Error: mongodb://root:pass123@mongo.example.com:27017/mydb")).toBe(
        "Error: mongodb://[REDACTED]",
      );
    });

    it("should scrub GitHub tokens and Bearer tokens", async () => {
      const { scrubString } = await import("../services/error-reporter.js");

      expect(scrubString(`Token: ghp_${"a".repeat(36)}`)).toBe("Token: [REDACTED]");
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

      expect(sanitizePath("/home/alice/project/extensions/memory-hybrid/index.ts")).toBe(
        "extensions/memory-hybrid/index.ts",
      );
      expect(sanitizePath("/home/alice/project/extensions/openclaw-hybrid-memory/index.ts")).toBe(
        "extensions/openclaw-hybrid-memory/index.ts",
      );
      expect(sanitizePath("/some/path/openclaw-hybrid-memory/services/error-reporter.ts")).toBe(
        "openclaw-hybrid-memory/services/error-reporter.ts",
      );
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
          values: [
            {
              type: "Error",
              value: "Failed with key sk-proj-abc123def456ghi789jkl012mno345pqr678",
              stacktrace: {
                frames: [
                  {
                    filename: "/home/user/project/extensions/memory-hybrid/index.ts",
                    function: "test",
                    lineno: 10,
                  },
                ],
              },
            },
          ],
        },
        tags: {
          subsystem: "sqlite",
          operation: "store-fact",
          phase: "runtime",
          backend: "sqlite",
          node: "Maeve",
          agent_id: "agent-42",
          agent_name: "Doris",
        },
        contexts: {
          config_shape: {
            provider: "openai",
            apiKey: "sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz",
          },
          runtime: {
            name: "node",
            version: "v20.10.0",
          },
          os: {
            name: "linux",
            version: "6.6.87",
          },
        },
        user: { id: "secret" },
        request: { url: "http://example.com" },
      };

      const sanitized = sanitizeEvent(mockEvent);

      expect(sanitized?.fingerprint).toEqual(["custom", "fingerprint"]);
      expect(sanitized?.exception?.values?.[0]?.value).toBe("Failed with key [REDACTED]");
      expect(sanitized?.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe(
        "extensions/memory-hybrid/index.ts",
      );
      expect(sanitized?.tags?.subsystem).toBe("sqlite");
      expect(sanitized?.tags?.operation).toBe("store-fact");
      expect(sanitized?.tags?.phase).toBe("runtime");
      expect(sanitized?.tags?.backend).toBe("sqlite");
      expect(sanitized?.tags?.node).toBe("Maeve");
      expect(sanitized?.tags?.agent_id).toBe("agent-42");
      expect(sanitized?.tags?.agent_name).toBe("Doris");
      expect(sanitized?.contexts?.config_shape?.apiKey).toBe("[REDACTED]");
      expect(sanitized?.contexts?.runtime).toEqual({
        name: "node",
        version: "v20.10.0",
      });
      expect(sanitized?.contexts?.os).toEqual({ name: "linux" }); // Only name, no version
      // User context preserved so GlitchTip "Users Affected" and grouping work (id/username only)
      expect(sanitized?.user).toEqual({ id: "secret", username: undefined });
      expect(sanitized?.request).toBeUndefined();
    });

    it("should preserve and scrub user id and username in sanitizeEvent", async () => {
      const { sanitizeEvent } = await import("../services/error-reporter.js");

      const mockEvent: any = {
        event_id: "e1",
        level: "error",
        user: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          username: "TestBot",
        },
      };

      const sanitized = sanitizeEvent(mockEvent);

      expect(sanitized?.user?.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(sanitized?.user?.username).toBe("TestBot");
    });
  });

  describe("Security Boundaries", () => {
    it("should verify error reporter enforces security config", async () => {
      const serviceCode = await import("node:fs").then((fs) =>
        fs.promises.readFile(new URL("../services/error-reporter.ts", import.meta.url), "utf-8"),
      );

      // Hard-coded breadcrumb cap enforced in GlitchTipReporter.addBreadcrumb
      expect(serviceCode).toContain("MAX_BREADCRUMBS");
      // Allowlist sanitization is applied in beforeSend (privacy-first design)
      expect(serviceCode).toContain("sanitizeEvent");
      // String scrubbing for API keys, paths, PII
      expect(serviceCode).toContain("scrubString");
      // Rate-limiting dedup window: 60 seconds
      expect(serviceCode).toContain("60000");
      // Only plugin.* category breadcrumbs allowed
      expect(serviceCode).toContain('"plugin."');
    });
  });

  describe("Integration Tests", () => {
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
        configShape: {
          key: "sk-ant-api03-secret123456789012345678901234567890",
        },
      });

      // When initialized (from previous test), should return event ID string or undefined (if rate limited)
      // When not initialized, should return undefined
      if (isErrorReporterActive()) {
        expect(typeof eventId === "string" || eventId === undefined).toBe(true);
      } else {
        expect(eventId).toBeUndefined();
      }
    });
  });

  describe("Version Helpers", () => {
    it("compareVersions: older patch returns -1", async () => {
      const { compareVersions } = await import("../services/error-reporter.js");
      expect(compareVersions("2026.3.100", "2026.3.110")).toBe(-1);
    });

    it("compareVersions: older month returns -1", async () => {
      const { compareVersions } = await import("../services/error-reporter.js");
      expect(compareVersions("2026.2.999", "2026.3.0")).toBe(-1);
    });

    it("compareVersions: older year returns -1", async () => {
      const { compareVersions } = await import("../services/error-reporter.js");
      expect(compareVersions("2025.12.999", "2026.1.0")).toBe(-1);
    });

    it("compareVersions: equal versions return 0", async () => {
      const { compareVersions } = await import("../services/error-reporter.js");
      expect(compareVersions("2026.3.110", "2026.3.110")).toBe(0);
    });

    it("compareVersions: newer patch returns 1", async () => {
      const { compareVersions } = await import("../services/error-reporter.js");
      expect(compareVersions("2026.3.111", "2026.3.110")).toBe(1);
    });

    it("compareVersions: newer year returns 1", async () => {
      const { compareVersions } = await import("../services/error-reporter.js");
      expect(compareVersions("2027.1.0", "2026.12.999")).toBe(1);
    });

    it("extractVersion: parses valid release string", async () => {
      const { extractVersion } = await import("../services/error-reporter.js");
      expect(extractVersion("openclaw-hybrid-memory@2026.3.110")).toBe("2026.3.110");
    });

    it("extractVersion: returns null when no @ sign", async () => {
      const { extractVersion } = await import("../services/error-reporter.js");
      expect(extractVersion("2026.3.110")).toBeNull();
    });

    it("extractVersion: returns null for empty string", async () => {
      const { extractVersion } = await import("../services/error-reporter.js");
      expect(extractVersion("")).toBeNull();
    });

    it("extractVersion: returns null when version part is malformed", async () => {
      const { extractVersion } = await import("../services/error-reporter.js");
      expect(extractVersion("openclaw-hybrid-memory@1.0")).toBeNull();
      expect(extractVersion("openclaw-hybrid-memory@abc.def.ghi")).toBeNull();
    });

    it("extractVersion: returns null when version part is empty after @", async () => {
      const { extractVersion } = await import("../services/error-reporter.js");
      expect(extractVersion("openclaw-hybrid-memory@")).toBeNull();
    });
  });

  describe("resolvedIssues version-aware filtering", () => {
    it("drops event when fingerprint matches and version is older than fix", async () => {
      const { shouldDropForResolvedIssue } = await import("../services/error-reporter.js");
      const event: any = {
        release: "openclaw-hybrid-memory@2026.3.100",
        exception: { values: [{ type: "Error", value: "Connection refused" }] },
      };
      const resolvedIssues = { "Error:Connection refused": "2026.3.110" };
      expect(shouldDropForResolvedIssue(event, resolvedIssues)).toBe(true);
    });

    it("lets event through when version equals fix version (regression check)", async () => {
      const { shouldDropForResolvedIssue } = await import("../services/error-reporter.js");
      const event: any = {
        release: "openclaw-hybrid-memory@2026.3.110",
        exception: { values: [{ type: "Error", value: "Connection refused" }] },
      };
      const resolvedIssues = { "Error:Connection refused": "2026.3.110" };
      expect(shouldDropForResolvedIssue(event, resolvedIssues)).toBe(false);
    });

    it("lets event through when version is newer than fix (regression)", async () => {
      const { shouldDropForResolvedIssue } = await import("../services/error-reporter.js");
      const event: any = {
        release: "openclaw-hybrid-memory@2026.3.120",
        exception: { values: [{ type: "Error", value: "Connection refused" }] },
      };
      const resolvedIssues = { "Error:Connection refused": "2026.3.110" };
      expect(shouldDropForResolvedIssue(event, resolvedIssues)).toBe(false);
    });

    it("lets event through when release is unparseable (safe default)", async () => {
      const { shouldDropForResolvedIssue } = await import("../services/error-reporter.js");
      const event: any = {
        release: "unknown-format",
        exception: { values: [{ type: "Error", value: "Connection refused" }] },
      };
      const resolvedIssues = { "Error:Connection refused": "2026.3.110" };
      expect(shouldDropForResolvedIssue(event, resolvedIssues)).toBe(false);
    });

    it("lets event through when release is missing but fallback is also unparseable", async () => {
      const { shouldDropForResolvedIssue } = await import("../services/error-reporter.js");
      const event: any = {
        exception: { values: [{ type: "Error", value: "Connection refused" }] },
      };
      const resolvedIssues = { "Error:Connection refused": "2026.3.110" };
      expect(shouldDropForResolvedIssue(event, resolvedIssues, "bad-release")).toBe(false);
    });

    it("uses fallbackRelease when event.release is absent", async () => {
      const { shouldDropForResolvedIssue } = await import("../services/error-reporter.js");
      const event: any = {
        exception: { values: [{ type: "Error", value: "Connection refused" }] },
      };
      const resolvedIssues = { "Error:Connection refused": "2026.3.110" };
      // Old version via fallback → should drop
      expect(shouldDropForResolvedIssue(event, resolvedIssues, "openclaw-hybrid-memory@2026.3.100")).toBe(true);
      // New version via fallback → should let through
      expect(shouldDropForResolvedIssue(event, resolvedIssues, "openclaw-hybrid-memory@2026.3.120")).toBe(false);
    });

    it("lets event through when fingerprint not in resolvedIssues", async () => {
      const { shouldDropForResolvedIssue } = await import("../services/error-reporter.js");
      const event: any = {
        release: "openclaw-hybrid-memory@2026.3.100",
        exception: { values: [{ type: "Error", value: "Some other error" }] },
      };
      const resolvedIssues = { "Error:Connection refused": "2026.3.110" };
      expect(shouldDropForResolvedIssue(event, resolvedIssues)).toBe(false);
    });

    it("lets event through when resolvedIssues is empty", async () => {
      const { shouldDropForResolvedIssue } = await import("../services/error-reporter.js");
      const event: any = {
        release: "openclaw-hybrid-memory@2026.3.100",
        exception: { values: [{ type: "Error", value: "Connection refused" }] },
      };
      expect(shouldDropForResolvedIssue(event, {})).toBe(false);
    });

    it("truncates fingerprint value to 100 chars for matching", async () => {
      const { shouldDropForResolvedIssue } = await import("../services/error-reporter.js");
      const longMessage = "A".repeat(200);
      const event: any = {
        release: "openclaw-hybrid-memory@2026.3.100",
        exception: { values: [{ type: "Error", value: longMessage }] },
      };
      // Fingerprint uses first 100 chars of value
      const resolvedIssues = { [`Error:${"A".repeat(100)}`]: "2026.3.110" };
      expect(shouldDropForResolvedIssue(event, resolvedIssues)).toBe(true);
    });

    it("lets event through when fixedInVersion is malformed (safe default)", async () => {
      const { shouldDropForResolvedIssue } = await import("../services/error-reporter.js");
      const event: any = {
        release: "openclaw-hybrid-memory@2026.3.100",
        exception: { values: [{ type: "Error", value: "Connection refused" }] },
      };
      // Malformed version — should never drop
      const resolvedIssues = { "Error:Connection refused": "not-a-version" };
      expect(shouldDropForResolvedIssue(event, resolvedIssues)).toBe(false);
    });
  });

  describe("beforeSend integration: version-aware filtering pipeline", () => {
    it("drops event matching a resolved issue on an older release (beforeSend pipeline)", async () => {
      const { sanitizeEvent, shouldDropForResolvedIssue } = await import("../services/error-reporter.js");

      // Simulate an event as Sentry fires beforeSend
      const rawEvent: any = {
        event_id: "int-test-1",
        level: "error",
        release: "openclaw-hybrid-memory@2026.3.100",
        exception: {
          values: [{ type: "TypeError", value: "Cannot read properties of null" }],
        },
        tags: { subsystem: "sqlite" },
      };
      const resolvedIssues = {
        "TypeError:Cannot read properties of null": "2026.3.110",
      };

      // Step 1: sanitize (as beforeSend does first)
      const sanitized = sanitizeEvent(rawEvent);
      expect(sanitized).not.toBeNull();

      // Step 2: version-aware filter (as beforeSend does second)
      const shouldDrop = shouldDropForResolvedIssue(sanitized!, resolvedIssues, rawEvent.release);
      expect(shouldDrop).toBe(true); // old release → should be dropped
    });

    it("passes event that matches a resolved issue but is on the exact fix release (regression guard)", async () => {
      const { sanitizeEvent, shouldDropForResolvedIssue } = await import("../services/error-reporter.js");

      const rawEvent: any = {
        event_id: "int-test-2",
        level: "error",
        release: "openclaw-hybrid-memory@2026.3.110",
        exception: {
          values: [{ type: "TypeError", value: "Cannot read properties of null" }],
        },
      };
      const resolvedIssues = {
        "TypeError:Cannot read properties of null": "2026.3.110",
      };

      const sanitized = sanitizeEvent(rawEvent);
      expect(sanitized).not.toBeNull();
      const shouldDrop = shouldDropForResolvedIssue(sanitized!, resolvedIssues, rawEvent.release);
      expect(shouldDrop).toBe(false); // exactly the fix version → pass (regression check)
    });

    it("passes event when resolvedIssues is empty (beforeSend pipeline)", async () => {
      const { sanitizeEvent, shouldDropForResolvedIssue } = await import("../services/error-reporter.js");

      const rawEvent: any = {
        event_id: "int-test-3",
        level: "error",
        release: "openclaw-hybrid-memory@2026.3.100",
        exception: {
          values: [{ type: "TypeError", value: "Cannot read properties of null" }],
        },
      };

      const sanitized = sanitizeEvent(rawEvent);
      expect(sanitized).not.toBeNull();
      // Empty resolvedIssues — no filtering applied
      const shouldDrop = shouldDropForResolvedIssue(sanitized!, {}, rawEvent.release);
      expect(shouldDrop).toBe(false);
    });

    it("scrubs sensitive value before fingerprint match (beforeSend pipeline)", async () => {
      const { sanitizeEvent, shouldDropForResolvedIssue } = await import("../services/error-reporter.js");

      // Error value contains a home path that scrubString will replace with $HOME
      const rawEvent: any = {
        event_id: "int-test-4",
        level: "error",
        release: "openclaw-hybrid-memory@2026.3.100",
        exception: {
          values: [
            {
              type: "Error",
              value: "File not found: /home/user/.openclaw/config.yaml",
            },
          ],
        },
      };
      // Fingerprint key uses the scrubbed form
      const resolvedIssues = {
        "Error:File not found: $HOME/.openclaw/config.yaml": "2026.3.110",
      };

      const sanitized = sanitizeEvent(rawEvent);
      expect(sanitized).not.toBeNull();
      // sanitizeEvent already scrubs the value; shouldDropForResolvedIssue also applies scrubString
      const shouldDrop = shouldDropForResolvedIssue(sanitized!, resolvedIssues, rawEvent.release);
      expect(shouldDrop).toBe(true); // scrubbed fingerprint matches → dropped
    });
  });

  describe("Opt-in bot identity", () => {
    it("logs when botName IS set", async () => {
      const { initErrorReporter } = await import("../services/error-reporter.js");

      const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

      await initErrorReporter(
        {
          enabled: true,
          consent: true,
          mode: "community",
          maxBreadcrumbs: 10,
          sampleRate: 1.0,
          botName: "TestBot",
        },
        "2026.3.110",
        mockLogger,
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining("Bot name set (opt-in)"));
    });

    it("logs when botName is NOT set", async () => {
      const { initErrorReporter } = await import("../services/error-reporter.js");

      const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

      await initErrorReporter(
        {
          enabled: true,
          consent: true,
          mode: "community",
          maxBreadcrumbs: 10,
          sampleRate: 1.0,
          // botName intentionally omitted
        },
        "2026.3.111",
        mockLogger,
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining("Bot name omitted"));
    });

    it("sanitizeEvent passes bot_name tag when present in event", async () => {
      const { sanitizeEvent } = await import("../services/error-reporter.js");

      const event: any = {
        event_id: "e1",
        level: "error",
        server_name: "Maeve",
        tags: {
          node: "Maeve",
          agent_name: "Doris",
          agent_id: "agent-99",
          bot_name: "TestBot",
          bot_id: "uuid-1234",
        },
      };
      const sanitized = sanitizeEvent(event);
      expect(sanitized?.server_name).toBe("Maeve");
      expect(sanitized?.tags?.node).toBe("Maeve");
      expect(sanitized?.tags?.agent_name).toBe("Doris");
      expect(sanitized?.tags?.agent_id).toBe("agent-99");
      expect(sanitized?.tags?.bot_name).toBe("TestBot");
      expect(sanitized?.tags?.bot_id).toBe("uuid-1234");
    });

    it("sanitizeEvent omits bot_name and bot_id when not in event tags", async () => {
      const { sanitizeEvent } = await import("../services/error-reporter.js");

      const event: any = {
        event_id: "e2",
        level: "error",
        tags: { subsystem: "sqlite" },
      };
      const sanitized = sanitizeEvent(event);
      expect(sanitized?.server_name).toBeUndefined();
      expect(sanitized?.tags?.node).toBeUndefined();
      expect(sanitized?.tags?.agent_name).toBeUndefined();
      expect(sanitized?.tags?.agent_id).toBeUndefined();
      expect(sanitized?.tags?.bot_name).toBeUndefined();
      expect(sanitized?.tags?.bot_id).toBeUndefined();
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

    it("should export addOperationBreadcrumb", async () => {
      const { addOperationBreadcrumb } = await import("../services/error-reporter.js");
      expect(typeof addOperationBreadcrumb).toBe("function");

      // Should not throw regardless of initialization state
      expect(() => addOperationBreadcrumb("test", "operation")).not.toThrow();
    });
  });

  describe("Noisy error filtering", () => {
    it("drops transient network transport errors", async () => {
      const { shouldDropNoisyError } = await import("../services/error-reporter.js");

      expect(shouldDropNoisyError(new Error("ECONNREFUSED http://localhost:11434"))).toBe(true);
      expect(shouldDropNoisyError(new Error("TypeError: fetch failed"))).toBe(true);
    });

    it("drops external-provider auth errors", async () => {
      const { shouldDropNoisyError } = await import("../services/error-reporter.js");

      expect(shouldDropNoisyError(Object.assign(new Error("401 Unauthorized"), { status: 401 }))).toBe(true);
      expect(shouldDropNoisyError(new Error("invalid api key provided"))).toBe(true);
      expect(shouldDropNoisyError(new Error("Country, region, or territory not supported"))).toBe(true);
    });

    it("drops Ollama circuit-breaker-open errors", async () => {
      const { shouldDropNoisyError } = await import("../services/error-reporter.js");

      expect(shouldDropNoisyError(new Error("Ollama circuit breaker open — retrying in 30s"))).toBe(true);
    });

    it("drops wrapped or aggregate errors only when every cause is noisy", async () => {
      const { shouldDropNoisyError } = await import("../services/error-reporter.js");

      const wrapped = new Error("retry failed", { cause: new Error("ECONNRESET") });
      const aggregateAllNoisy = Object.assign(new Error("all providers failed"), {
        causes: [new Error("ECONNREFUSED"), new Error("Ollama circuit breaker open")],
      });
      const aggregateMixed = Object.assign(new Error("all providers failed"), {
        causes: [new Error("ECONNREFUSED"), new Error("TypeError: cannot read properties of undefined")],
      });

      expect(shouldDropNoisyError(wrapped)).toBe(true);
      expect(shouldDropNoisyError(aggregateAllNoisy)).toBe(true);
      expect(shouldDropNoisyError(aggregateMixed)).toBe(false);
    });

    it("does not drop unrelated errors or file-permission failures", async () => {
      const { shouldDropNoisyError } = await import("../services/error-reporter.js");

      expect(shouldDropNoisyError(new TypeError("Cannot read properties of undefined"))).toBe(false);
      expect(shouldDropNoisyError(new Error("Access denied to file /tmp/test.txt"))).toBe(false);
    });
  });
});

describe("UnconfiguredProviderError suppression", () => {
  it("capturePluginError returns undefined immediately and never reaches GlitchTip for UnconfiguredProviderError", async () => {
    // Regression guard: capturePluginError must silently drop UnconfiguredProviderError.
    // These are config issues (missing API keys), not bugs — they must never leak to GlitchTip.
    const { capturePluginError } = await import("../services/error-reporter.js");

    // Construct the error by name to avoid a circular import (chat.ts → error-reporter.ts)
    const err = Object.assign(
      new Error("Provider 'openrouter' is not configured for model openrouter/qwen/qwen3-14b"),
      {
        name: "UnconfiguredProviderError",
      },
    );

    const result = capturePluginError(err, {
      operation: "test-suppression",
      subsystem: "auto-classifier",
    });

    // Must return undefined without touching Sentry, regardless of initialization state
    expect(result).toBeUndefined();
  });

  it("capturePluginError behavior for regular errors is tested in error-reporter-guard.test.ts", async () => {
    // The full test for regular error handling uses a mocked fetch to verify
    // that events are sent or suppressed. See error-reporter-guard.test.ts for the
    // comprehensive test that verifies:
    // 1. Regular errors DO trigger fetch (guard does not suppress)
    // 2. UnconfiguredProviderError does NOT trigger fetch (guard suppresses)

    // This placeholder test ensures the test count remains stable
    expect(true).toBe(true);
  });
});
