/**
 * Unit tests for credential value and service name validation (Issue #98).
 */

import { describe, it, expect } from "vitest";
import { tryParseCredentialForVault } from "../services/auto-capture.js";
import {
  validateCredentialValue,
  validateAndNormalizeServiceName,
  auditCredentialValue,
  auditServiceName,
  normalizeServiceForDedup,
  shouldSkipCredentialStore,
  CREDENTIAL_SERVICE_MAX_LENGTH,
  MIN_CREDENTIAL_VALUE_LENGTH,
  MAX_SERVICE_NAME_LENGTH,
  type CredentialsDbLike,
} from "../services/credential-validation.js";

describe("exported constants", () => {
  it("MIN_CREDENTIAL_VALUE_LENGTH equals 8", () => {
    expect(MIN_CREDENTIAL_VALUE_LENGTH).toBe(8);
  });

  it("MAX_SERVICE_NAME_LENGTH equals CREDENTIAL_SERVICE_MAX_LENGTH", () => {
    expect(MAX_SERVICE_NAME_LENGTH).toBe(CREDENTIAL_SERVICE_MAX_LENGTH);
    expect(MAX_SERVICE_NAME_LENGTH).toBe(50);
  });
});

describe("validateCredentialValue", () => {
  it("accepts JWT-like value when hasPatternMatch", () => {
    expect(validateCredentialValue("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx.yyy", "bearer", true)).toEqual({ ok: true });
  });

  it("accepts sk- key when hasPatternMatch", () => {
    expect(validateCredentialValue("sk-proj-abc123def456ghi789", "api_key", true)).toEqual({ ok: true });
  });

  // P2: natural language check must run even when hasPatternMatch=false
  it("rejects natural language when no pattern match", () => {
    expect(validateCredentialValue("requires explicit login via the gateway", "other", false)).toEqual({
      ok: false,
      reason: "natural_language",
    });
  });

  // P2: passphrase extracted by a scanner pattern should still be accepted (hasPatternMatch=true skips NL check)
  it("accepts multi-word passphrase when hasPatternMatch is true (scanner extracted it directly)", () => {
    expect(validateCredentialValue("my secret key with spaces 12345", "api_key", true)).toEqual({ ok: true });
  });

  // Path detection — absolute paths
  it("rejects path-like value when no pattern match", () => {
    expect(validateCredentialValue("/root/.config/systemd/user/ope", "other", false)).toEqual({
      ok: false,
      reason: "path",
    });
  });

  // Part 2.1: tilde-home paths
  it("rejects tilde-home path when no pattern match", () => {
    expect(validateCredentialValue("~/.config/token", "other", false)).toEqual({
      ok: false,
      reason: "path",
    });
  });

  it("rejects value too short for other when no pattern match", () => {
    expect(validateCredentialValue("short", "other", false)).toEqual({ ok: false, reason: "value_too_short_for_other" });
  });

  it("rejects empty value", () => {
    expect(validateCredentialValue("", "api_key", true)).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects value shorter than 8 chars", () => {
    expect(validateCredentialValue("abc1234", "api_key", true)).toEqual({ ok: false, reason: "value_too_short" });
  });
});

describe("validateAndNormalizeServiceName", () => {
  it("preserves hostname with dots", () => {
    expect(validateAndNormalizeServiceName("api.example.com")).toBe("api.example.com");
  });

  it("preserves URL-style service", () => {
    expect(validateAndNormalizeServiceName("postgres://host/db")).toBe("postgres://host/db");
  });

  it("normalizes and applies map", () => {
    expect(validateAndNormalizeServiceName("anthropic_api_key")).toBe("anthropic");
  });

  it("rejects service name too long", () => {
    const long = "a".repeat(CREDENTIAL_SERVICE_MAX_LENGTH + 1);
    expect(validateAndNormalizeServiceName(long)).toBeNull();
  });

  it("rejects sentence-like slug", () => {
    expect(validateAndNormalizeServiceName("be-root-or-plugin-is-blocked-5-kill-gateway")).toBeNull();
  });

  it("accepts short slug", () => {
    expect(validateAndNormalizeServiceName("github")).toBe("github");
  });
});

describe("auditCredentialValue", () => {
  it("flags natural language", () => {
    expect(auditCredentialValue("the token is required for login", "other")).toContain("natural_language");
  });

  it("flags path", () => {
    expect(auditCredentialValue("/home/user/.env", "other")).toContain("path");
  });
});

describe("auditServiceName", () => {
  it("flags long service name", () => {
    expect(auditServiceName("a".repeat(51))).toContain("service_too_long");
  });
});

describe("normalizeServiceForDedup", () => {
  it("returns canonical name from map", () => {
    expect(normalizeServiceForDedup("glitchtip_api_token")).toBe("glitchtip");
  });

  it("returns slug when not in map", () => {
    expect(normalizeServiceForDedup("custom-service")).toBe("custom-service");
  });

  // P3: dots must be preserved so hostname dedup matches stored service names
  it("preserves dots for hostname-style services", () => {
    expect(normalizeServiceForDedup("api.example.com")).toBe("api.example.com");
  });

  it("preserves :// for URL-style services", () => {
    expect(normalizeServiceForDedup("postgres://host/db")).toBe("postgres://host/db");
  });

  it("groups hostname variants that differ only in case", () => {
    // Both should produce the same lowercase canonical form
    expect(normalizeServiceForDedup("API.Example.COM")).toBe("api.example.com");
  });
});

describe("auditCredentialValue — tilde path", () => {
  it("flags tilde-home path", () => {
    expect(auditCredentialValue("~/.ssh/id_rsa", "other")).toContain("path");
  });
});

// P2 regression: narrative value must be rejected even when the text also contains
// a recognisable credential pattern (e.g. sk-...).
describe("tryParseCredentialForVault — P2 hasPatternMatch bypass", () => {
  it("rejects narrative value even when pattern is present elsewhere in text", () => {
    // The text has a real sk- key, so extractCredentialMatch would succeed.
    // But the explicit `value` param is narrative — it must still be rejected.
    const text = "The login token is sk-abc123def456xyz789. It requires explicit login via the gateway";
    const result = tryParseCredentialForVault(
      text,
      "credentials",     // entity
      "gateway-auth",    // key
      "requires explicit login via the gateway", // value — narrative text
    );
    expect(result).toBeNull();
  });

  it("accepts value that genuinely came from a pattern match (no explicit value param)", () => {
    // No `value` param → secretValue comes from extractCredentialMatch (sk- regex).
    // The regex requires 20+ alphanumeric chars after "sk-", so use a compact key.
    const text = "My API key: sk-abc123def456ghi789jkl012";
    const result = tryParseCredentialForVault(text, "openai", null, null);
    expect(result).not.toBeNull();
    expect(result?.service).toBe("openai");
  });
});

describe("shouldSkipCredentialStore", () => {
  it("returns true when same service+type+value exists", () => {
    const db: CredentialsDbLike = {
      get: (service: string, type?: "token" | "password" | "api_key" | "ssh" | "bearer" | "other") =>
        service === "api" && type === "api_key" ? { value: "same-secret" } : null,
    };
    expect(shouldSkipCredentialStore(db, { service: "api", type: "api_key", value: "same-secret" })).toBe(true);
  });

  it("returns false when value differs", () => {
    const db: CredentialsDbLike = {
      get: () => ({ value: "old-secret" }),
    };
    expect(shouldSkipCredentialStore(db, { service: "api", type: "api_key", value: "new-secret" })).toBe(false);
  });

  it("returns false when no existing entry", () => {
    const db: CredentialsDbLike = { get: () => null };
    expect(shouldSkipCredentialStore(db, { service: "api", type: "api_key", value: "secret" })).toBe(false);
  });
});
