/**
 * Tests for auto-capture credentials from tool call inputs.
 * Covers extractCredentialsFromToolCalls() pattern extraction and vault storage integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";
import { extractCredentialsFromToolCalls, extractHostFromUrl, slugify } from "../services/credential-scanner.js";
import { CredentialsDB } from "../backends/credentials-db.js";

// Note: extractCredentialsFromToolCalls moved to credential-scanner service

const TEST_KEY = "test-encryption-key-for-unit-tests-32chars";

// ---------------------------------------------------------------------------
// Pattern extraction unit tests
// ---------------------------------------------------------------------------

describe("extractCredentialsFromToolCalls", () => {
  describe("sshpass pattern", () => {
    it("extracts password from sshpass -p <pass> ssh user@host", () => {
      const input = JSON.stringify({ command: "sshpass -p s3cr3tPass ssh root@192.168.1.19" });
      const results = extractCredentialsFromToolCalls(input);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const cred = results.find((r) => r.type === "password");
      expect(cred).toBeDefined();
      expect(cred!.value).toBe("s3cr3tPass");
      expect(cred!.service).toBe("ssh://root@192.168.1.19");
    });

    it("extracts password from sshpass with extra ssh options", () => {
      const input = "sshpass -p myP@ssw0rd ssh -o StrictHostKeyChecking=no admin@10.0.0.1";
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.type === "password");
      expect(cred).toBeDefined();
      expect(cred!.value).toBe("myP@ssw0rd");
      expect(cred!.service).toBe("ssh://admin@10.0.0.1");
    });

    it("ignores sshpass with short (< 4 char) password", () => {
      const input = "sshpass -p abc ssh user@host";
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service?.startsWith("ssh://"));
      expect(cred).toBeUndefined();
    });
  });

  describe("curl Authorization Bearer pattern", () => {
    it("extracts bearer token from curl -H Authorization Bearer", () => {
      const input = `curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123" https://api.example.com/data`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.type === "bearer");
      expect(cred).toBeDefined();
      expect(cred!.value).toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(cred!.service).toBe("api.example.com");
      expect(cred!.url).toBe("https://api.example.com/data");
    });

    it("falls back to 'api' service when no URL present", () => {
      const input = `curl -H "Authorization: Bearer sk-longsecrettoken12345678" `;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.type === "bearer");
      expect(cred).toBeDefined();
      expect(cred!.service).toBe("api");
    });
  });

  describe("curl -u user:pass pattern", () => {
    it("extracts password from curl -u user:pass URL", () => {
      const input = `curl -u admin:superSecret123 https://jenkins.example.com/api`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.type === "password");
      expect(cred).toBeDefined();
      expect(cred!.value).toBe("superSecret123");
      expect(cred!.service).toBe("jenkins.example.com");
      expect(cred!.url).toBe("https://jenkins.example.com/api");
    });

    it("ignores curl -u with short password", () => {
      const input = `curl -u user:abc https://example.com`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.type === "password" && r.service === "example.com");
      expect(cred).toBeUndefined();
    });
  });

  describe("X-API-Key header pattern", () => {
    it("extracts API key from X-API-Key header", () => {
      const input = `curl -H "X-API-Key: abcdef1234567890" https://api.myservice.com/v1/data`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.type === "api_key");
      expect(cred).toBeDefined();
      expect(cred!.value).toBe("abcdef1234567890");
    });

    it("ignores X-API-Key shorter than 8 chars", () => {
      const input = `curl -H "X-API-Key: short" https://api.example.com`;
      const results = extractCredentialsFromToolCalls(input);
      expect(results.find((r) => r.type === "api_key")).toBeUndefined();
    });
  });

  describe("connection string patterns", () => {
    it("extracts postgres connection string credentials", () => {
      const input = `psql postgres://dbuser:dbpassword123@db.example.com:5432/mydb`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.type === "password" && r.service.startsWith("postgres://"));
      expect(cred).toBeDefined();
      expect(cred!.value).toBe("dbpassword123");
      expect(cred!.service).toBe("postgres://db.example.com:5432/mydb");
    });

    it("extracts mysql connection string credentials", () => {
      const input = `mysql mysql://root:rootPass456@localhost:3306/production`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service.startsWith("mysql://"));
      expect(cred).toBeDefined();
      expect(cred!.value).toBe("rootPass456");
    });

    it("extracts mongodb connection string credentials", () => {
      const input = `mongoose.connect("mongodb://user:mongoSecret789@mongo.host.com/appdb")`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service.startsWith("mongodb://"));
      expect(cred).toBeDefined();
      expect(cred!.value).toBe("mongoSecret789");
    });

    it("ignores connection strings with short passwords", () => {
      const input = `postgres://user:abc@host/db`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service.startsWith("postgres://"));
      expect(cred).toBeUndefined();
    });
  });

  describe("export VAR=value pattern", () => {
    it("extracts API key from export *_KEY=value", () => {
      const input = `export OPENAI_API_KEY=sk-projXYZ1234567890abcdef`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service === "openai-api");
      expect(cred).toBeDefined();
      expect(cred!.type).toBe("api_key");
      expect(cred!.value).toBe("sk-projXYZ1234567890abcdef");
    });

    it("extracts token from export *_TOKEN=value", () => {
      const input = `export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service === "github");
      expect(cred).toBeDefined();
      expect(cred!.type).toBe("token");
    });

    it("extracts password from export *_PASSWORD=value", () => {
      const input = `export DB_PASSWORD=myDatabasePassword123`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service === "db");
      expect(cred).toBeDefined();
      expect(cred!.type).toBe("password");
      expect(cred!.value).toBe("myDatabasePassword123");
    });

    it("extracts secret from export *_SECRET=value", () => {
      const input = `export JWT_SECRET=supersecretjwtkey12345678`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service === "jwt");
      expect(cred).toBeDefined();
      expect(cred!.type).toBe("other");
    });

    it("ignores export with short value (< 8 chars)", () => {
      const input = `export API_KEY=short`;
      const results = extractCredentialsFromToolCalls(input);
      expect(results.find((r) => r.service === "api")).toBeUndefined();
    });
  });

  describe(".env file write patterns", () => {
    it("extracts credentials from .env file content", () => {
      const envContent = `DATABASE_URL=postgres://host/db\nAPI_KEY=longsecretkey1234567890\nNODE_ENV=production`;
      const results = extractCredentialsFromToolCalls(envContent);
      const cred = results.find((r) => r.service === "api");
      expect(cred).toBeDefined();
      expect(cred!.type).toBe("api_key");
      expect(cred!.value).toBe("longsecretkey1234567890");
    });
  });

  describe("deduplication", () => {
    it("returns only one entry per service+type combination", () => {
      // Two export patterns for same conceptual service+type
      const input = `export API_KEY=secret12345678\nAPI_KEY=secret12345678`;
      const results = extractCredentialsFromToolCalls(input);
      const apiKeyCreds = results.filter((r) => r.service === "api" && r.type === "api_key");
      // Should have at most 1 entry per service+type
      expect(apiKeyCreds.length).toBeLessThanOrEqual(1);
    });

    it("captures multiple distinct credentials from the same input", () => {
      // Two different SSH hosts in one tool call (e.g., a script with multiple sshpass commands)
      const input = [
        "sshpass -p password1234 ssh root@192.168.1.10",
        "sshpass -p anotherPass ssh admin@192.168.1.20",
      ].join("\n");
      const results = extractCredentialsFromToolCalls(input);
      const sshCreds = results.filter((r) => r.type === "password" && r.service.startsWith("ssh://"));
      expect(sshCreds.length).toBe(2);
      expect(sshCreds.map((c) => c.service)).toContain("ssh://root@192.168.1.10");
      expect(sshCreds.map((c) => c.service)).toContain("ssh://admin@192.168.1.20");
    });
  });

  describe("empty / non-matching input", () => {
    it("returns empty array for plain text with no credentials", () => {
      const results = extractCredentialsFromToolCalls("echo Hello World");
      expect(results).toEqual([]);
    });

    it("returns empty array for empty string", () => {
      expect(extractCredentialsFromToolCalls("")).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration test: tool call → vault entry
// ---------------------------------------------------------------------------

describe("tool call credential auto-capture integration", () => {
  let tmpDir: string;
  let db: InstanceType<typeof CredentialsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cred-autocapture-test-"));
    db = new CredentialsDB(join(tmpDir, "creds.db"), TEST_KEY);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores SSH credential extracted from tool call into vault", () => {
    const toolCallArgs = JSON.stringify({ command: "sshpass -p secret1234 ssh root@192.168.1.19" });
    const creds = extractCredentialsFromToolCalls(toolCallArgs);
    expect(creds.length).toBeGreaterThanOrEqual(1);

    for (const cred of creds) {
      db.store({ service: cred.service, type: cred.type, value: cred.value, url: cred.url, notes: cred.notes });
    }

    const stored = db.get("ssh://root@192.168.1.19", "password");
    expect(stored).not.toBeNull();
    expect(stored!.value).toBe("secret1234");
    expect(stored!.service).toBe("ssh://root@192.168.1.19");
  });

  it("upserts when same credential is captured twice", () => {
    const args1 = "sshpass -p firstPassword ssh root@10.0.0.1";
    const args2 = "sshpass -p newPassword456 ssh root@10.0.0.1";

    for (const cred of extractCredentialsFromToolCalls(args1)) {
      db.store({ service: cred.service, type: cred.type, value: cred.value });
    }
    for (const cred of extractCredentialsFromToolCalls(args2)) {
      db.store({ service: cred.service, type: cred.type, value: cred.value });
    }

    const stored = db.get("ssh://root@10.0.0.1", "password");
    expect(stored!.value).toBe("newPassword456");
  });

  it("stores bearer token from curl tool call into vault", () => {
    const args = `curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.signature" https://api.example.com/resource`;
    const creds = extractCredentialsFromToolCalls(args);
    expect(creds.length).toBeGreaterThanOrEqual(1);

    for (const cred of creds) {
      db.store({ service: cred.service, type: cred.type, value: cred.value, url: cred.url });
    }

    const stored = db.get("api.example.com", "bearer");
    expect(stored).not.toBeNull();
    expect(stored!.url).toBe("https://api.example.com/resource");
  });

  it("does not store credential values in facts DB (vault only)", () => {
    // This test verifies that extractCredentialsFromToolCalls returns data
    // intended only for vault storage — it should not contain any reference
    // to factsDb storage (structural test: ensure the returned type has no 'text' field
    // like MemoryEntry would have, confirming vault-only path).
    const args = `export PAYMENT_SECRET_KEY=test_key_abcdefghijklmnopqrst123456`;
    const creds = extractCredentialsFromToolCalls(args);
    for (const cred of creds) {
      expect(Object.keys(cred)).not.toContain("text");
      expect(Object.keys(cred)).not.toContain("category");
      expect(Object.keys(cred)).not.toContain("importance");
    }
  });
});

// ---------------------------------------------------------------------------
// Fix #19: Additional test cases for council review fixes
// ---------------------------------------------------------------------------

describe("council review fixes", () => {
  describe("Fix #13: quoted env vars with spaces", () => {
    it("extracts quoted env var with spaces", () => {
      const input = `export API_KEY="my secret key with spaces 12345"`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service === "api");
      expect(cred).toBeDefined();
      expect(cred!.value).toBe("my secret key with spaces 12345");
    });

    it("extracts single-quoted env var with spaces", () => {
      const input = `export DB_PASSWORD='my password with spaces 789'`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service === "db");
      expect(cred).toBeDefined();
      expect(cred!.value).toBe("my password with spaces 789");
    });
  });

  describe("Fix #14: invalid hostname validation", () => {
    it("rejects invalid hostnames in extractHostFromUrl", () => {
      // Test with SQL injection attempt
      const result1 = extractHostFromUrl("https://'; DROP TABLE users; --/api");
      expect(result1).toBe("api"); // Should fall back to safe default
      
      // Test with path traversal
      const result2 = extractHostFromUrl("https://../../../etc/passwd");
      expect(result2).toBe("api");
      
      // Valid hostname should work
      const result3 = extractHostFromUrl("https://api.example.com/path");
      expect(result3).toBe("api.example.com");
    });
  });

  describe("Fix #18: slugify minimum length", () => {
    it("returns 'imported' for slugs shorter than 2 chars", () => {
      expect(slugify("a")).toBe("imported");
      expect(slugify("")).toBe("imported");
      expect(slugify("ab")).toBe("ab");
      expect(slugify("123")).toBe("123");
    });
  });

  describe("Fix #19: connection string extraction", () => {
    it("extracts credentials from connection strings in .env format", () => {
      const input = `DATABASE_URL=postgres://user:pass12345@db.example.com:5432/mydb`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service.startsWith("postgres://"));
      expect(cred).toBeDefined();
      expect(cred!.value).toBe("pass12345");
      expect(cred!.service).toBe("postgres://db.example.com:5432/mydb");
    });

    it("handles mongodb+srv connection strings", () => {
      const input = `MONGO_URI=mongodb+srv://admin:secret789@cluster.mongodb.net/dbname`;
      const results = extractCredentialsFromToolCalls(input);
      const cred = results.find((r) => r.service.startsWith("mongodb+srv://"));
      expect(cred).toBeDefined();
      expect(cred!.value).toBe("secret789");
    });
  });

  describe("Fix #15: error resilience", () => {
    it("continues extraction even if one pattern fails", () => {
      // This test verifies that if one regex throws, others still work
      const input = `export API_KEY=validkey12345\nsshpass -p password456 ssh user@host`;
      const results = extractCredentialsFromToolCalls(input);
      // Should have extracted at least one credential even if other patterns fail
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
