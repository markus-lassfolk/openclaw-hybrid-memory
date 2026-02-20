import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _testing } from "../index.js";

const { CredentialsDB, deriveKey, encryptValue, decryptValue } = _testing;

const TEST_ENCRYPTION_KEY = "test-encryption-key-for-unit-tests-32chars";

let tmpDir: string;
let db: InstanceType<typeof CredentialsDB>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cred-db-test-"));
  db = new CredentialsDB(join(tmpDir, "creds.db"), TEST_ENCRYPTION_KEY);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Encryption primitives
// ---------------------------------------------------------------------------

describe("deriveKey", () => {
  it("returns a 32-byte Buffer (SHA-256)", () => {
    const salt = Buffer.alloc(32);
    const key = deriveKey("password", salt);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it("same password and salt produces same key", () => {
    const salt = Buffer.alloc(32);
    const k1 = deriveKey("test123", salt);
    const k2 = deriveKey("test123", salt);
    expect(k1.equals(k2)).toBe(true);
  });

  it("different passwords produce different keys", () => {
    const salt = Buffer.alloc(32);
    const k1 = deriveKey("alpha", salt);
    const k2 = deriveKey("beta", salt);
    expect(k1.equals(k2)).toBe(false);
  });
});

describe("encryptValue / decryptValue", () => {
  const salt = Buffer.alloc(32);
  const key = deriveKey("test-key", salt);

  it("round-trips plaintext through encrypt then decrypt", () => {
    const plaintext = "super-secret-api-key-12345";
    const encrypted = encryptValue(plaintext, key);
    const decrypted = decryptValue(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypted buffer differs from plaintext", () => {
    const plaintext = "my-token";
    const encrypted = encryptValue(plaintext, key);
    expect(encrypted.toString("utf8")).not.toBe(plaintext);
  });

  it("encrypting same text twice produces different ciphertext (random IV)", () => {
    const plaintext = "deterministic-test";
    const e1 = encryptValue(plaintext, key);
    const e2 = encryptValue(plaintext, key);
    expect(e1.equals(e2)).toBe(false);
  });

  it("fails to decrypt with wrong key", () => {
    const encrypted = encryptValue("secret", key);
    const wrongSalt = Buffer.alloc(32, 1);
    const wrongKey = deriveKey("wrong-password", wrongSalt);
    expect(() => decryptValue(encrypted, wrongKey)).toThrow();
  });

  it("handles empty string", () => {
    const encrypted = encryptValue("", key);
    expect(decryptValue(encrypted, key)).toBe("");
  });

  it("handles unicode text", () => {
    const text = "lösenord 密码 пароль";
    const encrypted = encryptValue(text, key);
    expect(decryptValue(encrypted, key)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// CredentialsDB.store & get
// ---------------------------------------------------------------------------

describe("CredentialsDB.store", () => {
  it("stores and returns redacted entry", () => {
    const result = db.store({
      service: "github",
      type: "api_key",
      value: "ghp_abcdef1234567890abcdef1234567890abcd",
    });
    expect(result.service).toBe("github");
    expect(result.type).toBe("api_key");
    expect(result.value).toBe("[redacted]");
    expect(result.created).toBeGreaterThan(0);
    expect(result.updated).toBeGreaterThan(0);
  });

  it("stores optional fields", () => {
    const result = db.store({
      service: "openai",
      type: "api_key",
      value: "sk-1234567890",
      url: "https://api.openai.com",
      notes: "Production key",
      expires: Math.floor(Date.now() / 1000) + 86400,
    });
    expect(result.url).toBe("https://api.openai.com");
    expect(result.notes).toBe("Production key");
    expect(result.expires).toBeGreaterThan(0);
  });
});

describe("CredentialsDB.get", () => {
  it("retrieves stored credential with decrypted value", () => {
    const secret = "sk-very-secret-key-123456";
    db.store({ service: "openai", type: "api_key", value: secret });

    const retrieved = db.get("openai", "api_key");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.service).toBe("openai");
    expect(retrieved!.type).toBe("api_key");
    expect(retrieved!.value).toBe(secret);
  });

  it("returns null for non-existent service", () => {
    expect(db.get("nonexistent")).toBeNull();
  });

  it("returns latest when type not specified", () => {
    db.store({ service: "github", type: "api_key", value: "key1" });
    db.store({ service: "github", type: "token", value: "token1" });

    const result = db.get("github");
    expect(result).not.toBeNull();
    expect(result!.service).toBe("github");
  });

  it("upserts on conflict (same service + type)", () => {
    db.store({ service: "openai", type: "api_key", value: "old-key" });
    db.store({ service: "openai", type: "api_key", value: "new-key" });

    const result = db.get("openai", "api_key");
    expect(result!.value).toBe("new-key");
  });
});

// ---------------------------------------------------------------------------
// CredentialsDB.list
// ---------------------------------------------------------------------------

describe("CredentialsDB.list", () => {
  it("returns empty array when no credentials", () => {
    expect(db.list()).toEqual([]);
  });

  it("lists all credentials without values", () => {
    db.store({ service: "github", type: "api_key", value: "secret1" });
    db.store({ service: "openai", type: "api_key", value: "secret2", url: "https://api.openai.com" });

    const list = db.list();
    expect(list.length).toBe(2);
    expect(list.every((item) => !("value" in item && typeof item.value === "string" && item.value.length > 10))).toBe(true);
    expect(list.map((l) => l.service)).toContain("github");
    expect(list.map((l) => l.service)).toContain("openai");
  });
});

// ---------------------------------------------------------------------------
// CredentialsDB.delete
// ---------------------------------------------------------------------------

describe("CredentialsDB.delete", () => {
  it("deletes specific service + type", () => {
    db.store({ service: "github", type: "api_key", value: "secret" });
    expect(db.delete("github", "api_key")).toBe(true);
    expect(db.get("github", "api_key")).toBeNull();
  });

  it("deletes all credentials for a service", () => {
    db.store({ service: "github", type: "api_key", value: "key" });
    db.store({ service: "github", type: "token", value: "tok" });
    expect(db.delete("github")).toBe(true);
    expect(db.list().length).toBe(0);
  });

  it("returns false for non-existent", () => {
    expect(db.delete("nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-instance decryption
// ---------------------------------------------------------------------------

describe("CredentialsDB cross-instance", () => {
  it("second instance with same key can decrypt", () => {
    const dbPath = join(tmpDir, "shared.db");
    const db1 = new CredentialsDB(dbPath, TEST_ENCRYPTION_KEY);
    db1.store({ service: "test", type: "api_key", value: "shared-secret" });
    db1.close();

    const db2 = new CredentialsDB(dbPath, TEST_ENCRYPTION_KEY);
    const result = db2.get("test", "api_key");
    expect(result!.value).toBe("shared-secret");
    db2.close();
  });

  it("second instance with different key cannot decrypt", () => {
    const dbPath = join(tmpDir, "wrongkey.db");
    const db1 = new CredentialsDB(dbPath, TEST_ENCRYPTION_KEY);
    db1.store({ service: "test", type: "api_key", value: "secret" });
    db1.close();

    const db2 = new CredentialsDB(dbPath, "different-key-that-is-long-enough");
    expect(() => db2.get("test", "api_key")).toThrow();
    db2.close();
  });
});
