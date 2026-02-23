/**
 * Unit tests for credential value and service name validation (Issue #98).
 */

import { describe, it, expect } from "vitest";
import {
  validateCredentialValue,
  validateAndNormalizeServiceName,
  auditCredentialValue,
  auditServiceName,
  normalizeServiceForDedup,
  shouldSkipCredentialStore,
  CREDENTIAL_SERVICE_MAX_LENGTH,
  type CredentialsDbLike,
} from "../services/credential-validation.js";

describe("validateCredentialValue", () => {
  it("accepts JWT-like value when hasPatternMatch", () => {
    expect(validateCredentialValue("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx.yyy", "bearer", true)).toEqual({ ok: true });
  });

  it("accepts sk- key when hasPatternMatch", () => {
    expect(validateCredentialValue("sk-proj-abc123def456ghi789", "api_key", true)).toEqual({ ok: true });
  });

  it("rejects natural language when no pattern match", () => {
    expect(validateCredentialValue("requires explicit login via the gateway", "other", false)).toEqual({
      ok: false,
      reason: "natural_language",
    });
  });

  it("rejects path-like value when no pattern match", () => {
    expect(validateCredentialValue("/root/.config/systemd/user/ope", "other", false)).toEqual({
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
