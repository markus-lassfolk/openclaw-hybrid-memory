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
  it("returns a 32-byte Buffer (scrypt v2)", () => {
    const salt = Buffer.from("test-salt-32-bytes-long-enough!!");
    const key = deriveKey("password", salt, 2);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });

  it("same password and salt produces same key", () => {
    const salt = Buffer.from("test-salt-32-bytes-long-enough!!");
    const k1 = deriveKey("test123", salt, 2);
    const k2 = deriveKey("test123", salt, 2);
    expect(k1.equals(k2)).toBe(true);
  });

  it("different passwords produce different keys", () => {
    const salt = Buffer.from("test-salt-32-bytes-long-enough!!");
    const k1 = deriveKey("alpha", salt, 2);
    const k2 = deriveKey("beta", salt, 2);
    expect(k1.equals(k2)).toBe(false);
  });

  it("v1 (SHA-256) still works for backward compatibility", () => {
    const salt = Buffer.alloc(0); // v1 doesn't use salt
    const key = deriveKey("password", salt, 1);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
  });
});

describe("encryptValue / decryptValue", () => {
  const salt = Buffer.from("test-salt-32-bytes-long-enough!!");
  const key = deriveKey("test-key", salt, 2);

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
    const wrongKey = deriveKey("wrong-password", salt, 2);
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

// ---------------------------------------------------------------------------
// Plaintext vault (no encryption key)
// ---------------------------------------------------------------------------

describe("CredentialsDB plaintext vault", () => {
  it("stores and retrieves values without encryption when key is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-plain-"));
    const dbPath = join(dir, "creds.db");
    const plainDb = new CredentialsDB(dbPath, "");
    plainDb.store({ service: "api", type: "api_key", value: "plain-secret" });
    const got = plainDb.get("api", "api_key");
    expect(got).not.toBeNull();
    expect(got!.value).toBe("plain-secret");
    plainDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when opening encrypted vault without key", () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-enc-"));
    const dbPath = join(dir, "creds.db");
    const encDb = new CredentialsDB(dbPath, TEST_ENCRYPTION_KEY);
    encDb.store({ service: "x", type: "token", value: "secret" });
    encDb.close();
    expect(() => new CredentialsDB(dbPath, "")).toThrow(/vault was created with encryption/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("list() works in plaintext mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-plain-list-"));
    const dbPath = join(dir, "creds.db");
    const plainDb = new CredentialsDB(dbPath, "");
    plainDb.store({ service: "service1", type: "api_key", value: "val1" });
    plainDb.store({ service: "service2", type: "token", value: "val2" });
    const list = plainDb.list();
    expect(list.length).toBe(2);
    expect(list.map((l) => l.service)).toContain("service1");
    expect(list.map((l) => l.service)).toContain("service2");
    plainDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("delete() works in plaintext mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-plain-del-"));
    const dbPath = join(dir, "creds.db");
    const plainDb = new CredentialsDB(dbPath, "");
    plainDb.store({ service: "delme", type: "api_key", value: "secret" });
    expect(plainDb.delete("delme", "api_key")).toBe(true);
    expect(plainDb.get("delme", "api_key")).toBeNull();
    plainDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trip: create plaintext vault, close, reopen plaintext, verify data intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-round-"));
    const dbPath = join(dir, "creds.db");
    const db1 = new CredentialsDB(dbPath, "");
    db1.store({ service: "persist", type: "password", value: "my-password-123" });
    db1.close();
    const db2 = new CredentialsDB(dbPath, "");
    const got = db2.get("persist", "password");
    expect(got).not.toBeNull();
    expect(got!.value).toBe("my-password-123");
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("plaintext vault (kdf_version=0) opened with a valid key: key is ignored with warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-plain-with-key-"));
    const dbPath = join(dir, "creds.db");
    // Create plaintext vault
    const plainDb = new CredentialsDB(dbPath, "");
    plainDb.store({ service: "test", type: "api_key", value: "plain-value" });
    plainDb.close();
    // Capture warning during construction
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    // Reopen with a valid key (should handle gracefully and warn)
    const db2 = new CredentialsDB(dbPath, TEST_ENCRYPTION_KEY);
    console.warn = originalWarn;
    // Verify warning was issued
    expect(warnings.some((w) => w.includes("plaintext mode"))).toBe(true);
    // Verify data is still accessible in plaintext
    const got = db2.get("test", "api_key");
    expect(got).not.toBeNull();
    expect(got!.value).toBe("plain-value");
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Legacy encrypted vault (no vault_meta) + empty key
// ---------------------------------------------------------------------------

describe("CredentialsDB legacy vault mode mismatch", () => {
  it("legacy encrypted vault (has data, no vault_meta) + empty key must throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-legacy-"));
    const dbPath = join(dir, "creds.db");
    // Manually create a legacy encrypted vault (no vault_meta, but has encrypted data)
    const encDb = new CredentialsDB(dbPath, TEST_ENCRYPTION_KEY);
    encDb.store({ service: "legacy", type: "api_key", value: "encrypted-secret" });
    // Manually delete vault_meta to simulate legacy vault
    const db = encDb["db"]; // Access private db
    db.prepare("DELETE FROM vault_meta").run();
    encDb.close();
    // Try to open without key → must throw
    expect(() => new CredentialsDB(dbPath, "")).toThrow(/vault contains data/);
    rmSync(dir, { recursive: true, force: true });
  });
});
