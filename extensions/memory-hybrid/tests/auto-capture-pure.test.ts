/**
 * Unit tests for pure functions in services/auto-capture.ts (Issue #559).
 * Tests detectCredentialPatterns, extractCredentialMatch, inferServiceFromText,
 * isCredentialLike, and tryParseCredentialForVault without live API keys or DBs.
 */

import { describe, it, expect } from "vitest";
import {
  detectCredentialPatterns,
  extractCredentialMatch,
  inferServiceFromText,
  isCredentialLike,
  tryParseCredentialForVault,
  SENSITIVE_PATTERNS,
  VAULT_POINTER_PREFIX,
  type TryParseCredentialOptions,
} from "../services/auto-capture.js";
import { MAX_SERVICE_NAME_LENGTH } from "../services/credential-validation.js";

// Credential test fixtures — constructed dynamically to avoid secret-scanner false positives.
const GHP_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const GHO_TOKEN = "gho_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const SK_KEY = "sk-" + "abcdefghij1234567890ABCDE";
const SK_PROJ = "sk-proj-" + "abcdefghij1234567890ABCD";

// ---------------------------------------------------------------------------
// SENSITIVE_PATTERNS & VAULT_POINTER_PREFIX constants
// ---------------------------------------------------------------------------

describe("SENSITIVE_PATTERNS", () => {
  it("matches 'password' keyword", () => {
    expect(SENSITIVE_PATTERNS.some((r) => r.test("the password is secret"))).toBe(true);
  });

  it("matches 'api_key' variant", () => {
    expect(SENSITIVE_PATTERNS.some((r) => r.test("set the api_key value"))).toBe(true);
  });

  it("matches 'secret' keyword", () => {
    expect(SENSITIVE_PATTERNS.some((r) => r.test("the client secret here"))).toBe(true);
  });

  it("matches 'token is' phrase", () => {
    expect(SENSITIVE_PATTERNS.some((r) => r.test("the token is abc123def456"))).toBe(true);
  });

  it("matches AWS access key format AKIA...", () => {
    expect(SENSITIVE_PATTERNS.some((r) => r.test("AKIAIOSFODNN7EXAMPLE is the key"))).toBe(true);
  });

  it("matches private key header", () => {
    expect(SENSITIVE_PATTERNS.some((r) => r.test("-----BEGIN RSA PRIVATE KEY-----"))).toBe(true);
  });

  it("matches connection strings with embedded passwords", () => {
    expect(SENSITIVE_PATTERNS.some((r) => r.test("mongodb://user:pass@host/db"))).toBe(true);
  });

  it("does not match plain safe text", () => {
    expect(SENSITIVE_PATTERNS.some((r) => r.test("user prefers dark mode in the editor"))).toBe(false);
  });
});

describe("VAULT_POINTER_PREFIX", () => {
  it("equals 'vault:'", () => {
    expect(VAULT_POINTER_PREFIX).toBe("vault:");
  });
});

// ---------------------------------------------------------------------------
// detectCredentialPatterns
// ---------------------------------------------------------------------------

describe("detectCredentialPatterns", () => {
  it("detects Bearer JWT token", () => {
    const text =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const results = detectCredentialPatterns(text);
    expect(results.some((r) => r.type === "bearer")).toBe(true);
    expect(results.some((r) => r.hint.includes("JWT"))).toBe(true);
  });

  it("detects OpenAI-style sk- key", () => {
    // The pattern requires sk- followed by 20+ alphanumeric chars (no internal dashes)
    const text = `set SK_KEY=${SK_KEY}`;
    const results = detectCredentialPatterns(text);
    expect(results.some((r) => r.type === "api_key")).toBe(true);
    expect(results.some((r) => r.hint.includes("sk-"))).toBe(true);
  });

  it("detects GitHub personal access token (ghp_)", () => {
    const text = `export GITHUB_TOKEN=${GHP_TOKEN}`;
    const results = detectCredentialPatterns(text);
    expect(results.some((r) => r.type === "api_key")).toBe(true);
    expect(results.some((r) => r.hint.includes("GitHub"))).toBe(true);
  });

  it("detects GitHub OAuth token (gho_)", () => {
    const text = `token: ${GHO_TOKEN}`;
    const results = detectCredentialPatterns(text);
    expect(results.some((r) => r.type === "api_key")).toBe(true);
  });

  it("detects Slack token (xoxb-)", () => {
    // Constructed dynamically to avoid secret-scanner false positives on the test file itself.
    const slackToken = ["xoxb", "TEST000000001", "TEST000000002", "testfixture0001"].join("-");
    const text = `slack token is ${slackToken}`;
    const results = detectCredentialPatterns(text);
    expect(results.some((r) => r.type === "token")).toBe(true);
    expect(results.some((r) => r.hint.includes("Slack"))).toBe(true);
  });

  it("detects SSH connection string", () => {
    const text = "ssh root@192.168.1.1 deploy-server";
    const results = detectCredentialPatterns(text);
    expect(results.some((r) => r.type === "ssh")).toBe(true);
  });

  it("returns empty array for plain text with no credentials", () => {
    const results = detectCredentialPatterns("user prefers dark mode in VS Code");
    expect(results).toHaveLength(0);
  });

  it("does not return duplicate hints for repeated matches", () => {
    // Two JWT-like tokens in the same text — should only report once per hint
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc123";
    const text = `Bearer ${jwt} and also Bearer ${jwt}`;
    const results = detectCredentialPatterns(text);
    const jwtHints = results.filter((r) => r.hint.includes("JWT"));
    // Deduplication contract: each distinct hint is emitted at most once regardless of
    // how many times the same pattern appears in the input text.
    expect(jwtHints).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// extractCredentialMatch
// ---------------------------------------------------------------------------

describe("extractCredentialMatch", () => {
  it("extracts JWT from Bearer header, stripping the Bearer prefix", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = extractCredentialMatch(`Authorization: Bearer ${jwt}`);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("bearer");
    expect(result!.secretValue).toBe(jwt);
    expect(result!.secretValue.startsWith("Bearer")).toBe(false);
  });

  it("extracts sk- API key", () => {
    // The pattern requires sk- followed by 20+ alphanumeric chars (no internal dashes)
    const result = extractCredentialMatch(`export OPENAI_KEY=${SK_KEY}`);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("api_key");
    expect(result!.secretValue).toMatch(/^sk-/);
  });

  it("extracts GitHub personal access token", () => {
    const result = extractCredentialMatch(GHP_TOKEN);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("api_key");
    expect(result!.secretValue).toMatch(/^ghp_/);
  });

  it("returns null when no credential pattern found", () => {
    const result = extractCredentialMatch("this is just plain text with no secrets");
    expect(result).toBeNull();
  });

  it("returns null for very short matches (< 8 chars after stripping)", () => {
    // SSH pattern can match short strings; "ssh a b" = 7 chars, should be rejected by length guard
    const result = extractCredentialMatch("ssh a b");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// inferServiceFromText
// ---------------------------------------------------------------------------

describe("inferServiceFromText", () => {
  it("returns 'home-assistant' for Home Assistant text", () => {
    expect(inferServiceFromText("my home assistant token for local ha")).toBe("home-assistant");
  });

  it("returns 'home-assistant' for hass keyword", () => {
    expect(inferServiceFromText("hass long-lived token here")).toBe("home-assistant");
  });

  it("returns 'github' for GitHub token text", () => {
    expect(inferServiceFromText("my github personal access token ghp_abc")).toBe("github");
  });

  it("returns 'github' for ghp_ pattern", () => {
    expect(inferServiceFromText(GHP_TOKEN)).toBe("github");
  });

  it("returns 'openai' for sk-proj prefix text", () => {
    expect(inferServiceFromText("openai api key is sk-proj-xxx")).toBe("openai");
  });

  it("returns 'slack' for xoxb- token", () => {
    const slackToken = "xoxb-" + "TEST000000001";
    expect(inferServiceFromText(`${slackToken} is the slack bot token`)).toBe("slack");
  });

  it("returns 'unifi' for ubiquiti/unifi text", () => {
    expect(inferServiceFromText("unifi controller api token")).toBe("unifi");
  });

  it("returns 'twilio' for twilio text", () => {
    expect(inferServiceFromText("twilio auth token for SMS service")).toBe("twilio");
  });

  it("returns 'duckdns' for duckdns text", () => {
    expect(inferServiceFromText("duckdns token for dynamic DNS")).toBe("duckdns");
  });

  it("returns 'imported' for unrecognised service text", () => {
    expect(inferServiceFromText("some random service token value")).toBe("imported");
  });
});

// ---------------------------------------------------------------------------
// isCredentialLike
// ---------------------------------------------------------------------------

describe("isCredentialLike", () => {
  it("returns true when entity equals 'credentials'", () => {
    expect(isCredentialLike("some text", "credentials", null, null)).toBe(true);
  });

  it("returns true when key contains 'api_key'", () => {
    expect(isCredentialLike("some text", null, "api_key", null)).toBe(true);
  });

  it("returns true when key contains 'token'", () => {
    expect(isCredentialLike("some text", null, "my_token", null)).toBe(true);
  });

  it("returns true when entity contains 'secret'", () => {
    expect(isCredentialLike("some text", "client_secret", null, null)).toBe(true);
  });

  it("returns true when value starts with eyJ (JWT)", () => {
    expect(isCredentialLike("some text", null, null, "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc")).toBe(true);
  });

  it("returns true when value starts with sk-", () => {
    expect(isCredentialLike("text", null, null, SK_PROJ)).toBe(true);
  });

  it("returns true when value starts with ghp_", () => {
    expect(isCredentialLike("text", null, null, GHP_TOKEN)).toBe(true);
  });

  it("returns true when text matches a credential pattern", () => {
    expect(isCredentialLike("use Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123 for auth", null, null, null)).toBe(
      true,
    );
  });

  it("returns true when text matches a sensitive pattern (password)", () => {
    expect(isCredentialLike("the password is hunter2", null, null, null)).toBe(true);
  });

  it("returns false for plain non-credential text", () => {
    expect(isCredentialLike("the user prefers dark mode in VS Code", null, null, null)).toBe(false);
  });

  it("returns false when value is too short (< 8 chars)", () => {
    // "sk-abc" (6 chars) fails the sk- credential pattern (requires 20+ alphanum after prefix)
    // and also fails the value length guard (< 8 chars), so isCredentialLike returns false.
    expect(isCredentialLike("plain text", null, null, "sk-abc")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tryParseCredentialForVault
// ---------------------------------------------------------------------------

describe("tryParseCredentialForVault", () => {
  const VALID_JWT =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  it("returns null for non-credential text", () => {
    expect(tryParseCredentialForVault("user prefers dark mode", null, null, null)).toBeNull();
  });

  it("parses a Bearer JWT token from text", () => {
    const result = tryParseCredentialForVault(`Authorization: Bearer ${VALID_JWT}`, null, null, null);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("bearer");
    expect(result!.secretValue).toBe(VALID_JWT);
  });

  it("uses entity+key as service when entity is 'credentials'", () => {
    const result = tryParseCredentialForVault(`Bearer ${VALID_JWT}`, "credentials", "home-assistant", null);
    expect(result).not.toBeNull();
    expect(result!.service).toBe("home-assistant");
  });

  it("falls back to key as service when entity is not 'credentials'", () => {
    const result = tryParseCredentialForVault(`Bearer ${VALID_JWT}`, "myapp", "myapp-token", null);
    expect(result).not.toBeNull();
    expect(result!.service).toBe("myapp-token");
  });

  it("falls back to entity as service when no key provided", () => {
    const result = tryParseCredentialForVault(`Bearer ${VALID_JWT}`, "github", null, null);
    expect(result).not.toBeNull();
    expect(result!.service).toBe("github");
  });

  it("infers service from text when no entity/key given", () => {
    const result = tryParseCredentialForVault(`github personal access token ${GHP_TOKEN}`, null, null, null);
    expect(result).not.toBeNull();
    expect(result!.service).toBe("github");
  });

  it("returns null with requirePatternMatch=true when no regex match found", () => {
    // value is credential-like but text has no pattern match
    // When requirePatternMatch=true and there's no regex match in text, returns null
    const opts: TryParseCredentialOptions = { requirePatternMatch: true };
    const result = tryParseCredentialForVault("plain text no pattern", "credentials", "myservice", SK_PROJ, opts);
    expect(result).toBeNull();
  });

  it("includes notes field containing original text when text is short enough", () => {
    const text = `github token: ${GHP_TOKEN}`;
    const result = tryParseCredentialForVault(text, null, null, null);
    expect(result).not.toBeNull();
    expect(result!.notes).toBe(text);
  });

  it("returns null when service name is invalid (too long / invalid chars)", () => {
    const longService = "a".repeat(MAX_SERVICE_NAME_LENGTH + 10);
    const result = tryParseCredentialForVault(`Bearer ${VALID_JWT}`, longService, null, null);
    expect(result).toBeNull();
  });
});
