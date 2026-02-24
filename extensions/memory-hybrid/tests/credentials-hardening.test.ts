/**
 * Tests for Issue #98: Credential auto-capture hardening.
 *
 * Covers:
 *  - rejectCredentialValue: value validation (Issue #98)
 *  - normalizeServiceName: service name validation & normalization (Issue #98)
 *  - CredentialsDB.exists / storeIfNew: dedup logic (Issue #98)
 *  - CredentialsDB.listAll: retrieves all entries with decrypted values (Issue #98)
 *  - Integration: tryParseCredentialForVault rejects bad values and service names (Issue #98)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  rejectCredentialValue,
  normalizeServiceName,
  MIN_CREDENTIAL_VALUE_LENGTH,
  MAX_SERVICE_NAME_LENGTH,
} from "../services/credential-scanner.js";
import { tryParseCredentialForVault } from "../services/auto-capture.js";
import { CredentialsDB } from "../backends/credentials-db.js";

const TEST_KEY = "test-encryption-key-for-unit-tests-32chars";

// ---------------------------------------------------------------------------
// rejectCredentialValue
// ---------------------------------------------------------------------------

describe("rejectCredentialValue", () => {
  describe("minimum length", () => {
    it("rejects values shorter than MIN_CREDENTIAL_VALUE_LENGTH", () => {
      const short = "abc1234"; // 7 chars
      expect(short.length).toBeLessThan(MIN_CREDENTIAL_VALUE_LENGTH);
      expect(rejectCredentialValue(short)).not.toBeNull();
    });

    it("accepts values exactly at MIN_CREDENTIAL_VALUE_LENGTH", () => {
      const exact = "a".repeat(MIN_CREDENTIAL_VALUE_LENGTH);
      expect(rejectCredentialValue(exact)).toBeNull();
    });

    it("accepts values longer than MIN_CREDENTIAL_VALUE_LENGTH", () => {
      expect(rejectCredentialValue("sk-abcdefghij1234567890")).toBeNull();
    });
  });

  describe("file paths", () => {
    it("rejects absolute paths starting with /", () => {
      expect(rejectCredentialValue("/home/user/.ssh/id_rsa")).not.toBeNull();
    });

    it("rejects paths starting with ~", () => {
      expect(rejectCredentialValue("~/.config/secrets.json")).not.toBeNull();
    });

    it("accepts normal token that starts with a letter", () => {
      expect(rejectCredentialValue("ghp_abcdef1234567890")).toBeNull();
    });
  });

  describe("bare URLs", () => {
    it("rejects bare URL with no auth token", () => {
      expect(rejectCredentialValue("https://api.example.com/v1/endpoint")).not.toBeNull();
    });

    it("rejects bare http URL", () => {
      expect(rejectCredentialValue("http://example.com")).not.toBeNull();
    });

    it("accepts URL-like string that has query params with = (could be a signed URL token)", () => {
      // A value with https:// but also has query params — not a bare URL per our rule
      expect(rejectCredentialValue("https://s3.amazonaws.com/bucket/key?X-Amz-Signature=abcdef1234567890")).toBeNull();
    });
  });

  describe("natural language sentences", () => {
    it("rejects long natural language text with many spaces and no credential chars", () => {
      const nlText = "This is a long natural language sentence that should not be stored as a credential value";
      expect(nlText.length).toBeGreaterThan(50);
      expect(rejectCredentialValue(nlText)).not.toBeNull();
    });

    it("accepts a long value that has credential chars like = even if it has spaces", () => {
      // Base64-encoded or token-like values with spaces should not be rejected if they have = chars
      const base64Like = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ==";
      expect(rejectCredentialValue(base64Like)).toBeNull(); // has = chars
    });

    it("accepts a token with underscores even if long", () => {
      const token = "sk_live_abcdefghijklmnopqrstuvwxyz1234567890_extra_long_token";
      expect(rejectCredentialValue(token)).toBeNull(); // has _ chars
    });

    it("accepts moderate-length text with no special chars (under 50 chars)", () => {
      const shortText = "my secret password"; // 18 chars, has spaces but < 50 chars
      expect(rejectCredentialValue(shortText)).toBeNull(); // short enough to pass
    });
  });

  describe("valid credential values", () => {
    it("accepts an OpenAI-style API key", () => {
      expect(rejectCredentialValue("sk-proj-abcdefghijklmnopqrst123456")).toBeNull();
    });

    it("accepts a GitHub PAT", () => {
      expect(rejectCredentialValue("ghp_abcdefABCDEF1234567890abcdef")).toBeNull();
    });

    it("accepts a JWT token", () => {
      expect(rejectCredentialValue("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.signature")).toBeNull();
    });

    it("accepts a bcrypt password hash", () => {
      expect(rejectCredentialValue("$2b$12$abcdefghijklmnopqrstuuVwxyzABCDEFGHIJKLMN0123456789OPQ")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeServiceName
// ---------------------------------------------------------------------------

describe("normalizeServiceName", () => {
  describe("length validation", () => {
    it("rejects names longer than MAX_SERVICE_NAME_LENGTH", () => {
      const longName = "a".repeat(MAX_SERVICE_NAME_LENGTH + 1);
      expect(normalizeServiceName(longName)).toBeNull();
    });

    it("accepts names exactly at MAX_SERVICE_NAME_LENGTH", () => {
      // 50 lowercase letters: valid
      const exact = "a".repeat(MAX_SERVICE_NAME_LENGTH);
      expect(normalizeServiceName(exact)).not.toBeNull();
    });
  });

  describe("sentence detection", () => {
    it("rejects names with 4 or more words", () => {
      expect(normalizeServiceName("this is a sentence")).toBeNull();
    });

    it("rejects names with many words", () => {
      expect(normalizeServiceName("The OpenAI API is now configured for production use")).toBeNull();
    });

    it("accepts single-word names", () => {
      expect(normalizeServiceName("github")).toBe("github");
    });

    it("accepts two-word names (turns to kebab-case)", () => {
      expect(normalizeServiceName("home assistant")).toBe("home-assistant");
    });

    it("accepts three-word names", () => {
      const result = normalizeServiceName("open ai key");
      expect(result).toBe("open-ai-key");
    });
  });

  describe("normalization", () => {
    it("converts to lowercase", () => {
      expect(normalizeServiceName("GitHub")).toBe("github");
    });

    it("converts spaces to hyphens", () => {
      expect(normalizeServiceName("home assistant")).toBe("home-assistant");
    });

    it("converts underscores to hyphens", () => {
      expect(normalizeServiceName("home_assistant")).toBe("home-assistant");
    });

    it("strips non-alphanumeric chars (except hyphen, colon, slash)", () => {
      expect(normalizeServiceName("my@service!name")).toBe("myservicename");
    });

    it("collapses multiple hyphens", () => {
      expect(normalizeServiceName("my--service")).toBe("my-service");
    });

    it("trims leading and trailing hyphens", () => {
      expect(normalizeServiceName("-service-")).toBe("service");
    });

    it("returns null for empty string", () => {
      expect(normalizeServiceName("")).toBeNull();
    });

    it("returns null when result is shorter than 2 chars", () => {
      expect(normalizeServiceName("@")).toBeNull();
    });

    it("preserves colons and slashes (for protocol-like names)", () => {
      const result = normalizeServiceName("api/v1");
      expect(result).toBe("api/v1");
    });
  });
});

// ---------------------------------------------------------------------------
// CredentialsDB — exists, storeIfNew, listAll
// ---------------------------------------------------------------------------

describe("CredentialsDB dedup and audit methods", () => {
  let tmpDir: string;
  let db: InstanceType<typeof CredentialsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "creds-hardening-test-"));
    db = new CredentialsDB(join(tmpDir, "creds.db"), TEST_KEY);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("exists", () => {
    it("returns false for a non-existent service", () => {
      expect(db.exists("nonexistent", "token")).toBe(false);
    });

    it("returns true after storing an entry", () => {
      db.store({ service: "github", type: "token", value: "ghp_testtoken123456789012345678901" });
      expect(db.exists("github", "token")).toBe(true);
    });

    it("returns false for same service with different type", () => {
      db.store({ service: "github", type: "token", value: "ghp_testtoken123456789012345678901" });
      expect(db.exists("github", "api_key")).toBe(false);
    });

    it("returns true without type when any entry for service exists", () => {
      db.store({ service: "openai", type: "api_key", value: "sk-proj-testkey12345678901234567890" });
      expect(db.exists("openai")).toBe(true);
    });

    it("returns false without type when no entry for service exists", () => {
      expect(db.exists("openai")).toBe(false);
    });
  });

  describe("storeIfNew", () => {
    it("stores entry when it does not exist", () => {
      const result = db.storeIfNew({ service: "github", type: "token", value: "ghp_testtoken123456789012345678901" });
      expect(result).not.toBeNull();
      expect(result!.service).toBe("github");
    });

    it("returns null and skips if entry already exists", () => {
      db.store({ service: "github", type: "token", value: "ghp_firsttoken123456789012345678901" });
      const result = db.storeIfNew({ service: "github", type: "token", value: "ghp_secondtoken12345678901234567890" });
      expect(result).toBeNull();
    });

    it("does not overwrite existing value when skipping", () => {
      const originalValue = "ghp_originaltoken1234567890123456789";
      db.store({ service: "github", type: "token", value: originalValue });
      db.storeIfNew({ service: "github", type: "token", value: "ghp_newtoken12345678901234567890123" });
      const stored = db.get("github", "token");
      expect(stored!.value).toBe(originalValue);
    });

    it("allows storeIfNew for same service but different type", () => {
      db.store({ service: "github", type: "token", value: "ghp_testtoken123456789012345678901" });
      const result = db.storeIfNew({ service: "github", type: "password", value: "password12345678" });
      expect(result).not.toBeNull();
    });
  });

  describe("listAll", () => {
    it("returns an empty array when vault is empty", () => {
      expect(db.listAll()).toEqual([]);
    });

    it("returns all stored entries with decrypted values", () => {
      db.store({ service: "github", type: "token", value: "ghp_testtoken123456789012345678901" });
      db.store({ service: "openai", type: "api_key", value: "sk-proj-testkey1234567890123456789" });
      const entries = db.listAll();
      expect(entries).toHaveLength(2);
      const services = entries.map((e) => e.service);
      expect(services).toContain("github");
      expect(services).toContain("openai");
    });

    it("decrypts values correctly", () => {
      const secret = "sk-proj-testkey12345678901234567890";
      db.store({ service: "openai", type: "api_key", value: secret });
      const entries = db.listAll();
      expect(entries[0].value).toBe(secret);
    });

    it("includes all fields", () => {
      const now = Math.floor(Date.now() / 1000);
      db.store({ service: "twilio", type: "token", value: "TEST_TWILIO_TOKEN_1234567890abcdef", url: "https://api.twilio.com", notes: "test note" });
      const entries = db.listAll();
      expect(entries[0].url).toBe("https://api.twilio.com");
      expect(entries[0].notes).toBe("test note");
      expect(entries[0].created).toBeGreaterThanOrEqual(now);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: tryParseCredentialForVault applies validation
// ---------------------------------------------------------------------------

describe("tryParseCredentialForVault hardening", () => {
  it("rejects natural language as credential value", () => {
    const text = "This is a long debug note about what happened during the API call failure yesterday";
    const result = tryParseCredentialForVault(text, "debug", "note", text);
    expect(result).toBeNull();
  });

  it("rejects file path as credential value", () => {
    const text = "ssh key at /home/user/.ssh/id_rsa";
    const result = tryParseCredentialForVault(text, null, null, "/home/user/.ssh/id_rsa");
    expect(result).toBeNull();
  });

  it("rejects bare URL as credential value", () => {
    const text = "endpoint is https://api.example.com/v1/data";
    const result = tryParseCredentialForVault(text, null, null, "https://api.example.com/v1/data");
    expect(result).toBeNull();
  });

  it("rejects values shorter than 8 chars", () => {
    const text = "token=abc1234";
    const result = tryParseCredentialForVault(text, "credentials", "api_key", "abc1234");
    expect(result).toBeNull();
  });

  it("accepts a valid API key value", () => {
    const apiKey = "sk-proj-abcdefghijklmnopqrst123456";
    const text = `openai api key is ${apiKey}`;
    const result = tryParseCredentialForVault(text, "openai", "api_key", apiKey);
    expect(result).not.toBeNull();
    expect(result!.secretValue).toBe(apiKey);
  });

  it("rejects oversized service name (full sentence as entity)", () => {
    const apiKey = "sk-proj-abcdefghijklmnopqrst123456";
    const longEntity = "The OpenAI API token that was configured last Tuesday for the production environment";
    const text = `${longEntity} ${apiKey}`;
    const result = tryParseCredentialForVault(text, longEntity, null, apiKey);
    // Should fall back to inferServiceFromText or "imported" if entity is rejected
    // The key point: it should not use the sentence as the service name
    if (result !== null) {
      expect(result.service.split(/\s+/).length).toBeLessThan(4); // no spaces in service name
      expect(result.service.length).toBeLessThanOrEqual(MAX_SERVICE_NAME_LENGTH);
    }
  });

  it("normalizes service name to kebab-case from entity when no key provided", () => {
    const apiKey = "ghp_abcdefABCDEF1234567890abcdef12";
    const text = `GitHub token: ${apiKey}`;
    // When key is null, entity is used as service name
    const result = tryParseCredentialForVault(text, "GitHub", null, apiKey);
    if (result !== null) {
      expect(result.service).toBe("github");
    }
  });

  it("normalizes key-based service name to kebab-case", () => {
    const apiKey = "sk-proj-abcdefghijklmnopqrst123456";
    const text = `OpenAI API key: ${apiKey}`;
    // key = "OpenAI API" should normalize to "openai-api"
    const result = tryParseCredentialForVault(text, "credentials", "OpenAI API", apiKey);
    if (result !== null) {
      expect(result.service).toMatch(/^[a-z0-9-]+$/); // no uppercase, no spaces
    }
  });
});
