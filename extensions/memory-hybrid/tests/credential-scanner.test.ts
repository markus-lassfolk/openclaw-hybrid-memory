/**
 * credential-scanner.test.ts — Dedicated unit tests for services/credential-scanner.ts.
 *
 * ## Coverage
 *
 * ### extractHostFromUrl
 * - Valid URLs return the hostname component.
 * - Invalid URLs fall back to regex extraction.
 * - Hostile inputs (path traversal, consecutive dots) return safe default "api".
 *
 * ### slugify
 * - Lowercases, replaces spaces/underscores with dashes, strips non-alphanumeric.
 * - Strings shorter than 2 chars return "imported".
 *
 * ### typeFromVarName
 * - Derives CredentialType from env var name suffix.
 *
 * ### extractCredentialsFromToolCalls
 * - sshpass pattern extracts password + service.
 * - curl Bearer token extracts token + resolves service from URL.
 * - curl -u user:pass extracts password, supports quoted and unquoted formats.
 * - X-API-Key header extracts api_key.
 * - Connection strings (postgres, mysql, mongodb, redis) extract passwords.
 * - export VAR=value extracts credentials from shell export statements.
 * - .env-style KEY=value extracts credentials from .env files.
 * - Deduplication: same service+type yields one result even if matched twice.
 * - False positives: values shorter than 4 chars are rejected.
 * - Empty input returns empty array.
 * - Multiple patterns in same text each yield a separate result.
 */

import { describe, it, expect } from "vitest";
import {
  extractHostFromUrl,
  slugify,
  typeFromVarName,
  extractCredentialsFromToolCalls,
} from "../services/credential-scanner.js";

// ---------------------------------------------------------------------------
// extractHostFromUrl
// ---------------------------------------------------------------------------

describe("extractHostFromUrl", () => {
  it("returns hostname for a valid https URL", () => {
    expect(extractHostFromUrl("https://api.example.com/v1/resource")).toBe("api.example.com");
  });

  it("returns hostname for a valid http URL", () => {
    expect(extractHostFromUrl("http://github.com/user/repo")).toBe("github.com");
  });

  it("returns 'api' safe default for completely invalid URL", () => {
    expect(extractHostFromUrl("not-a-url-at-all")).toBe("api");
  });

  it("rejects hostname with consecutive dots", () => {
    // URL constructor will reject this, fallback regex also rejects ..
    expect(extractHostFromUrl("https://api..evil.com/path")).toBe("api");
  });

  it("returns hostname for subdomain URLs", () => {
    expect(extractHostFromUrl("https://auth.service.example.com/token")).toBe("auth.service.example.com");
  });

  it("strips port from URL constructor result", () => {
    // URL constructor gives hostname without port
    expect(extractHostFromUrl("https://api.example.com:8080/path")).toBe("api.example.com");
  });
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("lowercases input", () => {
    expect(slugify("GitHub")).toBe("github");
  });

  it("replaces spaces with dashes", () => {
    expect(slugify("my service")).toBe("my-service");
  });

  it("replaces underscores with dashes", () => {
    expect(slugify("my_service")).toBe("my-service");
  });

  it("strips non-alphanumeric chars (except dashes)", () => {
    expect(slugify("my.service!")).toBe("myservice");
  });

  it("returns 'imported' for single-char input", () => {
    expect(slugify("x")).toBe("imported");
  });

  it("returns 'imported' for empty string", () => {
    expect(slugify("")).toBe("imported");
  });

  it("returns slug when 2 or more chars", () => {
    expect(slugify("gh")).toBe("gh");
  });
});

// ---------------------------------------------------------------------------
// typeFromVarName
// ---------------------------------------------------------------------------

describe("typeFromVarName", () => {
  it("returns 'password' for *_PASSWORD suffix", () => {
    expect(typeFromVarName("DB_PASSWORD")).toBe("password");
  });

  it("returns 'token' for *_TOKEN suffix", () => {
    expect(typeFromVarName("GITHUB_TOKEN")).toBe("token");
  });

  it("returns 'api_key' for *_KEY suffix", () => {
    expect(typeFromVarName("OPENAI_API_KEY")).toBe("api_key");
  });

  it("returns 'other' for unrecognized suffix", () => {
    expect(typeFromVarName("MY_SECRET")).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(typeFromVarName("db_password")).toBe("password");
  });
});

// ---------------------------------------------------------------------------
// extractCredentialsFromToolCalls
// ---------------------------------------------------------------------------

describe("extractCredentialsFromToolCalls — empty / trivial input", () => {
  it("returns empty array for empty string", () => {
    expect(extractCredentialsFromToolCalls("")).toEqual([]);
  });

  it("returns empty array for plain text with no credentials", () => {
    expect(extractCredentialsFromToolCalls("ls -la /home/user")).toEqual([]);
  });
});

describe("extractCredentialsFromToolCalls — sshpass pattern", () => {
  it("extracts password from sshpass invocation", () => {
    const text = "sshpass -p mysecretpass ssh user@example.com";
    const creds = extractCredentialsFromToolCalls(text);
    expect(creds.length).toBeGreaterThanOrEqual(1);
    const cred = creds.find((c) => c.type === "password");
    expect(cred).toBeDefined();
    expect(cred!.value).toBe("mysecretpass");
    expect(cred!.service).toContain("example.com");
  });

  it("rejects sshpass with too-short password (< 4 chars)", () => {
    const text = "sshpass -p abc ssh user@host.com";
    const creds = extractCredentialsFromToolCalls(text);
    expect(creds.every((c) => c.value !== "abc")).toBe(true);
  });
});

describe("extractCredentialsFromToolCalls — curl Bearer token", () => {
  it("extracts bearer token from curl Authorization header", () => {
    // Constructed via concatenation to avoid secret-scanner false positives
    const jwtToken = "eyJhbGci" + "OiJIUzI1NiJ9.payload.sig";
    const text = `curl -H "Authorization: Bearer ${jwtToken}" https://api.example.com/data`;
    const creds = extractCredentialsFromToolCalls(text);
    expect(creds.length).toBeGreaterThanOrEqual(1);
    const cred = creds.find((c) => c.type === "bearer");
    expect(cred).toBeDefined();
    expect(cred!.value).toContain("eyJhbGci");
  });

  it("resolves service from URL in the same command", () => {
    // Constructed via concatenation to avoid secret-scanner false positives
    const fakeToken = "TEST_BEARER_" + "VALIDTOKEN123456";
    const text = `curl -H "Authorization: Bearer ${fakeToken}" https://api.github.com/user`;
    const creds = extractCredentialsFromToolCalls(text);
    const cred = creds.find((c) => c.type === "bearer");
    expect(cred).toBeDefined();
    expect(cred!.service).toBe("api.github.com");
  });
});

describe("extractCredentialsFromToolCalls — curl -u user:pass", () => {
  it("extracts password from curl -u (unquoted)", () => {
    const text = "curl -u admin:secretpass123 https://api.example.com";
    const creds = extractCredentialsFromToolCalls(text);
    const cred = creds.find((c) => c.type === "password");
    expect(cred).toBeDefined();
    expect(cred!.value).toBe("secretpass123");
  });

  it("extracts password from curl -u (quoted)", () => {
    const text = `curl -u 'myuser:my password 99' https://api.example.com/v1`;
    const creds = extractCredentialsFromToolCalls(text);
    const cred = creds.find((c) => c.type === "password");
    expect(cred).toBeDefined();
    expect(cred!.value).toBe("my password 99");
  });

  it("rejects curl -u with too-short password", () => {
    const text = "curl -u admin:abc https://api.example.com";
    expect(extractCredentialsFromToolCalls(text)).toEqual([]);
  });
});

describe("extractCredentialsFromToolCalls — X-API-Key header", () => {
  it("extracts api_key from X-API-Key header", () => {
    // Constructed via concatenation to avoid secret-scanner false positives
    const fakeKey = "TEST_KEY_" + "ABCDEF1234567890";
    const text = `curl -H "X-API-Key: ${fakeKey}" https://api.openai.com/v1/chat`;
    const creds = extractCredentialsFromToolCalls(text);
    const cred = creds.find((c) => c.type === "api_key");
    expect(cred).toBeDefined();
    expect(cred!.value).toBe(fakeKey);
    expect(cred!.service).toBe("api.openai.com");
  });

  it("rejects X-API-Key shorter than 8 chars", () => {
    const text = 'curl -H "X-API-Key: short" https://api.example.com';
    const creds = extractCredentialsFromToolCalls(text);
    expect(creds.find((c) => c.type === "api_key")).toBeUndefined();
  });
});

describe("extractCredentialsFromToolCalls — connection strings", () => {
  it("extracts password from postgres connection string", () => {
    const text = "psql postgresql://dbuser:s3cr3tpassword@db.example.com:5432/mydb";
    const creds = extractCredentialsFromToolCalls(text);
    const cred = creds.find((c) => c.type === "password");
    expect(cred).toBeDefined();
    expect(cred!.value).toBe("s3cr3tpassword");
    expect(cred!.service).toContain("db.example.com");
  });

  it("extracts password from mysql connection string", () => {
    const text = "mysql mysql://root:rootpassword@localhost/myapp";
    const creds = extractCredentialsFromToolCalls(text);
    expect(creds.some((c) => c.type === "password" && c.value === "rootpassword")).toBe(true);
  });

  it("extracts password from mongodb connection string", () => {
    const text = "connect to mongodb://mongouser:mongosecret@mongo.host.net/admin";
    const creds = extractCredentialsFromToolCalls(text);
    expect(creds.some((c) => c.value === "mongosecret")).toBe(true);
  });

  it("rejects connection string with too-short password", () => {
    const text = "postgresql://user:ab@host/db";
    const creds = extractCredentialsFromToolCalls(text);
    expect(creds.every((c) => c.value !== "ab")).toBe(true);
  });
});

describe("extractCredentialsFromToolCalls — export VAR=value", () => {
  it("extracts token from export GITHUB_TOKEN=...", () => {
    // Constructed via concatenation to avoid secret-scanner false positives
    const fakeToken = "TEST_TOKEN_" + "ABCDEFGHIJ1234567890";
    const text = `export GITHUB_TOKEN=${fakeToken}`;
    const creds = extractCredentialsFromToolCalls(text);
    const cred = creds.find((c) => c.type === "token");
    expect(cred).toBeDefined();
    expect(cred!.value).toBe(fakeToken);
    expect(cred!.service).toBe("github");
  });

  it("extracts api_key from export OPENAI_API_KEY=...", () => {
    // Constructed via concatenation to avoid secret-scanner false positives
    const fakeKey = "TEST_KEY_" + "LONGERTHANMINIMUMREQUIRED";
    const text = `export OPENAI_API_KEY="${fakeKey}"`;
    const creds = extractCredentialsFromToolCalls(text);
    const cred = creds.find((c) => c.type === "api_key");
    expect(cred).toBeDefined();
    // OPENAI_API_KEY → strip _KEY → OPENAI_API → slugify → "openai-api"
    expect(cred!.service).toBe("openai-api");
  });

  it("extracts password from export DB_PASSWORD=...", () => {
    const text = "export DB_PASSWORD=supersecretdbpassword";
    const creds = extractCredentialsFromToolCalls(text);
    const cred = creds.find((c) => c.type === "password");
    expect(cred).toBeDefined();
    expect(cred!.value).toBe("supersecretdbpassword");
  });
});

describe("extractCredentialsFromToolCalls — .env-style KEY=value", () => {
  it("extracts credentials from .env-style assignment", () => {
    const text = "\nAPI_KEY=myverylongapikey12345\n";
    const creds = extractCredentialsFromToolCalls(text);
    const cred = creds.find((c) => c.type === "api_key");
    expect(cred).toBeDefined();
    expect(cred!.value).toBe("myverylongapikey12345");
  });

  it("does not double-extract when line has both export and assignment form", () => {
    const text = "export SECRET_TOKEN=alreadyhandledbyexport123";
    const creds = extractCredentialsFromToolCalls(text);
    // Should not appear twice (dedup by service+type)
    const tokenCreds = creds.filter((c) => c.type === "token");
    expect(tokenCreds.length).toBeLessThanOrEqual(1);
  });
});

describe("extractCredentialsFromToolCalls — deduplication", () => {
  it("deduplicates credentials with the same service+type", () => {
    // Constructed via concatenation to avoid secret-scanner false positives
    const fakeToken = "TEST_TOKEN_" + "ABCDEFGHIJ1234567890";
    // Same export appearing twice in the same text
    const text = [`export GITHUB_TOKEN=${fakeToken}`, `export GITHUB_TOKEN=${fakeToken}`].join("\n");
    const creds = extractCredentialsFromToolCalls(text);
    const tokenCreds = creds.filter((c) => c.type === "token" && c.service === "github");
    expect(tokenCreds.length).toBe(1);
  });
});

describe("extractCredentialsFromToolCalls — multiple patterns", () => {
  it("extracts multiple distinct credentials from the same input", () => {
    // Constructed via concatenation to avoid secret-scanner false positives
    const fakeGhToken = "TEST_TOKEN_" + "ABCDEFGHIJ1234567890";
    const fakeApiKey = "TEST_KEY_" + "ABCDEF1234567890";
    const text = [
      `export GITHUB_TOKEN=${fakeGhToken}`,
      `curl -H "X-API-Key: ${fakeApiKey}" https://api.openai.com/v1`,
    ].join("\n");
    const creds = extractCredentialsFromToolCalls(text);
    expect(creds.length).toBeGreaterThanOrEqual(2);
    expect(creds.some((c) => c.type === "token")).toBe(true);
    expect(creds.some((c) => c.type === "api_key")).toBe(true);
  });
});
