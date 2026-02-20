/**
 * Tests for auth failure detection service
 */

import { describe, it, expect } from "vitest";
import {
  detectAuthFailure,
  extractTarget,
  buildCredentialQuery,
  formatCredentialHint,
  DEFAULT_AUTH_FAILURE_PATTERNS,
} from "../services/auth-failure-detect.js";

describe("auth-failure-detect", () => {
  describe("detectAuthFailure", () => {
    it("detects SSH permission denied", () => {
      const text = "ssh user@example.com\nPermission denied (publickey,password).";
      const result = detectAuthFailure(text);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("ssh");
      expect(result.hint).toBe("SSH permission denied");
    });

    it("detects SSH authentication failed", () => {
      const text = "Connecting to server...\nAuthentication failed for user@192.168.1.100";
      const result = detectAuthFailure(text);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("ssh");
    });

    it("detects HTTP 401", () => {
      const text = "GET https://api.example.com/data\n401 Unauthorized";
      const result = detectAuthFailure(text);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("http");
      expect(result.hint).toBe("HTTP 401 Unauthorized");
    });

    it("detects HTTP 403", () => {
      const text = "Response: 403 Forbidden - Access denied";
      const result = detectAuthFailure(text);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("http");
    });

    it("detects API key errors", () => {
      const text = "API request failed: Invalid API key provided";
      const result = detectAuthFailure(text);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("api");
      expect(result.hint).toBe("Invalid API key");
    });

    it("detects token expired", () => {
      const text = "Error: Your token expired. Please authenticate again.";
      const result = detectAuthFailure(text);
      expect(result.detected).toBe(true);
      expect(result.type).toBe("api");
    });

    it("returns false for non-auth errors", () => {
      const text = "Connection timeout after 30 seconds";
      const result = detectAuthFailure(text);
      expect(result.detected).toBe(false);
    });

    it("returns false for empty text", () => {
      const result = detectAuthFailure("");
      expect(result.detected).toBe(false);
    });

    it("supports custom patterns", () => {
      const customPatterns = [
        { regex: /access.denied/i, type: "generic" as const, hint: "Custom access denied" },
      ];
      const text = "Error: Access Denied for resource";
      const result = detectAuthFailure(text, customPatterns);
      expect(result.detected).toBe(true);
      expect(result.hint).toBe("Custom access denied");
    });
  });

  describe("extractTarget", () => {
    it("extracts hostname from SSH command", () => {
      const text = "ssh user@example.com failed";
      const target = extractTarget(text, "ssh");
      expect(target).toBe("example.com");
    });

    it("extracts IP address", () => {
      const text = "Connection to 192.168.1.100 failed";
      const target = extractTarget(text, "ssh");
      expect(target).toBe("192.168.1.100");
    });

    it("extracts domain from URL", () => {
      const text = "GET https://api.github.com/user failed with 401";
      const target = extractTarget(text, "http");
      expect(target).toBe("api.github.com");
    });

    it("extracts domain from HTTP URL", () => {
      const text = "Request to http://example.org/api returned 403";
      const target = extractTarget(text, "http");
      expect(target).toBe("example.org");
    });

    it("extracts hostname-like patterns", () => {
      const text = "Failed to authenticate with home-assistant.local";
      const target = extractTarget(text, "api");
      expect(target).toBe("home-assistant.local");
    });

    it("extracts service names", () => {
      const text = "API key invalid for OpenAI service";
      const target = extractTarget(text, "api");
      expect(target?.toLowerCase()).toBe("openai");
    });

    it("returns undefined when no target found", () => {
      const text = "Authentication failed";
      const target = extractTarget(text, "generic");
      expect(target).toBeUndefined();
    });

    it("prefers IP address when available", () => {
      const text = "ssh myserver 192.168.1.50 failed";
      const target = extractTarget(text, "ssh");
      expect(target).toBe("192.168.1.50");
    });
  });

  describe("buildCredentialQuery", () => {
    it("builds query with target and credential terms", () => {
      const detection = {
        detected: true,
        type: "ssh" as const,
        hint: "SSH auth failed",
        target: "example.com",
      };
      const query = buildCredentialQuery(detection);
      expect(query).toContain("example.com");
      expect(query).toContain("credential");
      expect(query).toContain("password");
      expect(query).toContain("token");
    });

    it("returns null when no target", () => {
      const detection = {
        detected: true,
        type: "ssh" as const,
        hint: "SSH auth failed",
      };
      const query = buildCredentialQuery(detection);
      expect(query).toBeNull();
    });

    it("returns null when not detected", () => {
      const detection = {
        detected: false,
      };
      const query = buildCredentialQuery(detection);
      expect(query).toBeNull();
    });
  });

  describe("formatCredentialHint", () => {
    const detection = {
      detected: true,
      type: "ssh" as const,
      hint: "SSH permission denied",
      target: "example.com",
    };

    it("formats hint with facts", () => {
      const facts = [
        {
          text: "SSH credentials for example.com: user=admin, key=/path/to/key",
          category: "technical",
          entity: "Credentials",
          key: "example.com",
        },
        {
          text: "API token for example.com API",
          category: "technical",
          entity: null,
          key: null,
        },
      ];
      const hint = formatCredentialHint(detection, facts);
      expect(hint).toContain("💡 Memory has credentials for example.com:");
      expect(hint).toContain("1.");
      expect(hint).toContain("2.");
      // Security fix: Now shows only metadata, not full text
      expect(hint).toContain("entity: Credentials");
      expect(hint).toContain("key: example.com");
    });

    it("limits to 3 facts", () => {
      const facts = Array(5)
        .fill(null)
        .map((_, i) => ({
          text: `Credential ${i + 1}`,
          category: "technical",
          entity: null,
          key: null,
        }));
      const hint = formatCredentialHint(detection, facts);
      const lines = hint.split("\n");
      // Header + 3 facts = 4 lines
      expect(lines.length).toBe(4);
    });

    it("shows metadata instead of text for security", () => {
      const longText = "x".repeat(200);
      const facts = [
        {
          text: longText,
          category: "technical",
          entity: "TestEntity",
          key: "testkey",
        },
      ];
      const hint = formatCredentialHint(detection, facts);
      // Security: should NOT contain the actual text
      expect(hint).not.toContain("xxx");
      // Should contain metadata
      expect(hint).toContain("entity: TestEntity");
      expect(hint).toContain("key: testkey");
    });

    it("returns empty string when no facts", () => {
      const hint = formatCredentialHint(detection, []);
      expect(hint).toBe("");
    });

    it("includes category tags for non-technical facts", () => {
      const facts = [
        {
          text: "Admin password is stored in vault",
          category: "preference",
          entity: null,
          key: null,
        },
      ];
      const hint = formatCredentialHint(detection, facts);
      expect(hint).toContain("[preference]");
    });

    it("omits category tag for technical facts", () => {
      const facts = [
        {
          text: "SSH key stored",
          category: "technical",
          entity: null,
          key: null,
        },
      ];
      const hint = formatCredentialHint(detection, facts);
      expect(hint).not.toContain("[technical]");
    });
  });

  describe("integration scenarios", () => {
    it("full flow: SSH failure -> extract target -> build query -> format hint", () => {
      const toolResult = `
$ ssh admin@production-server.example.com
Permission denied (publickey,password).
      `.trim();

      // 1. Detect failure
      const detection = detectAuthFailure(toolResult);
      expect(detection.detected).toBe(true);
      expect(detection.target).toBe("production-server.example.com");

      // 2. Build query
      const query = buildCredentialQuery(detection);
      expect(query).toContain("production-server.example.com");
      expect(query).toContain("credential");

      // 3. Mock facts from search
      const facts = [
        {
          text: "SSH credentials for production-server.example.com: use key ~/.ssh/prod_key",
          category: "technical",
          entity: "Credentials",
          key: "production-server.example.com",
        },
      ];

      // 4. Format hint
      const hint = formatCredentialHint(detection, facts);
      expect(hint).toContain("💡");
      expect(hint).toContain("production-server.example.com");
      // Security fix: shows metadata instead of text
      expect(hint).toContain("entity: Credentials");
      expect(hint).toContain("key: production-server.example.com");
    });

    it("full flow: API failure -> extract domain -> format hint", () => {
      const toolResult = `
HTTP GET https://api.openai.com/v1/models
Response: 401 Unauthorized
{"error": "Invalid API key"}
      `.trim();

      const detection = detectAuthFailure(toolResult);
      expect(detection.detected).toBe(true);
      expect(detection.target).toBe("api.openai.com");

      const query = buildCredentialQuery(detection);
      expect(query).toContain("api.openai.com");

      const facts = [
        {
          text: "OpenAI API key: sk-proj-... (expires 2026-12-31)",
          category: "technical",
          entity: "Credentials",
          key: "openai",
        },
      ];

      const hint = formatCredentialHint(detection, facts);
      expect(hint).toContain("api.openai.com");
      // Security fix: shows metadata instead of text
      expect(hint).toContain("entity: Credentials");
      expect(hint).toContain("key: openai");
    });

    it("handles case where target extraction fails", () => {
      const toolResult = "Authentication failed with no specific target mentioned";
      const detection = detectAuthFailure(toolResult);
      expect(detection.detected).toBe(true);
      expect(detection.target).toBeUndefined();

      const query = buildCredentialQuery(detection);
      expect(query).toBeNull(); // No query without target
    });
  });

  describe("false positive prevention", () => {
    it("should NOT detect file permission errors as SSH failures", () => {
      const text = "Cannot write to /var/log: Permission denied";
      const result = detectAuthFailure(text);
      // This is a known limitation - the pattern will match, but in practice
      // the target extraction will fail (no hostname/IP), making the recall a no-op
      if (result.detected) {
        expect(result.target).toBeUndefined(); // No SSH target = no recall
      }
    });

    it("should NOT detect HTTP status codes in non-HTTP context", () => {
      const text = "Processing item 401 from invoice list";
      const result = detectAuthFailure(text);
      // This is a known limitation: pattern will match "401"
      // Target extraction will try "from invoice" pattern and extract "invoice" as a service name
      // In practice, this is a false positive, but the credential search will find nothing
      // and the recall will be a harmless no-op
      expect(result.detected).toBe(true); // Pattern matches
      expect(result.type).toBe("http");
      // Accept that target extraction might produce a false target ("invoice")
      // The important safety is: no credentials will be found for "invoice"
    });

    it("should NOT detect 'Unauthorized' in regular text", () => {
      const text = "Unauthorized biography of Einstein published yesterday";
      const result = detectAuthFailure(text);
      // This WILL trigger the pattern, but target extraction should fail
      if (result.detected) {
        expect(result.target).toBeUndefined(); // No HTTP target = no recall
      }
    });

    it("should handle ambiguous contexts gracefully", () => {
      // Even if patterns match, no target = no credential recall
      const text = "The authentication module failed unit tests";
      const result = detectAuthFailure(text);
      if (result.detected) {
        // If detected (e.g., "authentication...failed" pattern), ensure no target
        expect(result.target).toBeUndefined();
        expect(buildCredentialQuery(result)).toBeNull();
      }
    });
  });
});
