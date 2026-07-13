import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import {
  parseCredentialsConfig,
  resolveCredentialsEncryptionKeyCandidates,
  resolveCredentialsEncryptionKeyForConfig,
} from "../config/parsers/core.js";
import { CredentialsDB } from "../backends/credentials-db.js";
import { getCredentialsEncryptionKeyRaw } from "../services/credentials-path.js";
import { pluginLogger } from "../utils/logger.js";

const require = createRequire(import.meta.url);
const hasNodeSqlite = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

const TEST_KEY = "test-encryption-key-for-unit-tests-32chars";

describe("resolveCredentialsEncryptionKeyCandidates", () => {
  let keyFile: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "cred-key-ref-"));
    keyFile = join(dir, "vault.key");
    writeFileSync(keyFile, `${TEST_KEY}\n`, "utf8");
  });

  afterEach(() => {
    rmSync(join(keyFile, ".."), { recursive: true, force: true });
  });

  it("prefers file contents over literal file: ref", () => {
    const ref = `file:${keyFile}`;
    expect(resolveCredentialsEncryptionKeyCandidates(ref)).toEqual([TEST_KEY, ref]);
  });

  it("resolves env: refs", () => {
    process.env.TEST_CRED_KEY_1884 = TEST_KEY;
    try {
      expect(resolveCredentialsEncryptionKeyCandidates("env:TEST_CRED_KEY_1884")).toEqual([TEST_KEY]);
    } finally {
      delete process.env.TEST_CRED_KEY_1884;
    }
  });

  it("resolveCredentialsEncryptionKeyForConfig rejects unreadable file: refs", () => {
    const missing = `file:${join(tmpdir(), "cred-key-missing", "vault.key")}`;
    expect(resolveCredentialsEncryptionKeyForConfig(missing)).toBe("");
    expect(resolveCredentialsEncryptionKeyCandidates(missing)).toEqual([""]);
  });
});

describe("parseCredentialsConfig: too-short key without explicit enabled", () => {
  it("warns and leaves the vault disabled when a short literal key is configured without enabled: true", () => {
    const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
    try {
      const result = parseCredentialsConfig({ credentials: { encryptionKey: "too-short" } });
      expect(result.enabled).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("shorter than 16 characters"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns and leaves the vault disabled when an unresolvable file: ref is configured without enabled: true", () => {
    const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
    try {
      const missing = `file:${join(tmpdir(), "cred-key-missing-no-enable", "vault.key")}`;
      const result = parseCredentialsConfig({ credentials: { encryptionKey: missing } });
      expect(result.enabled).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("could not be resolved to a usable key"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when credentials.enabled is explicitly false", () => {
    const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
    try {
      const result = parseCredentialsConfig({ credentials: { enabled: false, encryptionKey: "too-short" } });
      expect(result.enabled).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("parseCredentialsConfig file: SecretRef", () => {
  let keyFile: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "cred-key-parse-"));
    keyFile = join(dir, "vault.key");
    writeFileSync(keyFile, TEST_KEY, "utf8");
  });

  afterEach(() => {
    rmSync(join(keyFile, ".."), { recursive: true, force: true });
  });

  it("stores resolved file contents and preserves encryptionKeyRef", () => {
    const ref = `file:${keyFile}`;
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", apiKey: "sk-test-key-that-is-long-enough", model: "text-embedding-3-small" },
      credentials: { enabled: true, encryptionKey: ref },
    });
    expect(cfg.credentials.encryptionKey).toBe(TEST_KEY);
    expect(getCredentialsEncryptionKeyRaw(cfg)).toBe(ref);
    expect(resolveCredentialsEncryptionKeyForConfig(ref)).toBe(TEST_KEY);
  });
});

describe.skipIf(!hasNodeSqlite)("credentials vault key probe", () => {
  let tmpDir: string;
  let dbPath: string;
  let keyFile: string;
  const fileRef = () => `file:${keyFile}`;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cred-key-probe-"));
    dbPath = join(tmpDir, "credentials.db");
    keyFile = join(tmpDir, "vault.key");
    writeFileSync(keyFile, "unused-for-legacy-test", "utf8");
  });

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    const mod = await import("../services/credentials-encryption-key.js");
    mod._resetCredentialsEncryptionKeyWarningsForTests();
  });

  it("opens legacy vault encrypted with literal file: ref", async () => {
    const { resolveCredentialsVaultKeyMaterial } = await import("../services/credentials-encryption-key.js");
    const { createCredentialsDbForConfig } = await import("../services/credentials-bootstrap.js");

    const ref = fileRef();
    const legacyDb = createLegacyVaultEncryptedWithKey(dbPath, ref);
    legacyDb.close();

    const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
    const material = resolveCredentialsVaultKeyMaterial(ref, dbPath);
    expect(material).toBe(ref);

    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", apiKey: "sk-test-key-that-is-long-enough", model: "text-embedding-3-small" },
      credentials: { enabled: true, encryptionKey: ref },
    });

    const db = createCredentialsDbForConfig(cfg, join(tmpDir, "facts.db"));
    expect(db).not.toBeNull();
    expect(db!.get("legacy-service", "password")?.value).toBe("legacy-secret");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("legacy literal file: SecretRef"));
    db!.close();
  });

  it("warns for a legacy vault opened via literal file: ref when the key file is missing entirely (loop iteration 71 regression)", async () => {
    // The most common trigger case for this warning: no key file was ever configured, so the
    // vault was legacy-encrypted using the literal `file:/path` ref string itself as the
    // passphrase. resolveCredentialsEncryptionKeyCandidates() returns no file-derived candidate
    // here, so the literal ref ends up as candidates[0] — an index-based ("i > 0") warning check
    // would never fire for this case, even though it's exactly what the warning exists to catch.
    const { resolveCredentialsVaultKeyMaterial } = await import("../services/credentials-encryption-key.js");
    const { createCredentialsDbForConfig } = await import("../services/credentials-bootstrap.js");

    const missingKeyFile = join(tmpDir, "never-created.key");
    const ref = `file:${missingKeyFile}`;
    expect(existsSync(missingKeyFile)).toBe(false);

    const legacyDb = createLegacyVaultEncryptedWithKey(dbPath, ref);
    legacyDb.close();

    const warnSpy = vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
    const material = resolveCredentialsVaultKeyMaterial(ref, dbPath);
    expect(material).toBe(ref);

    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", apiKey: "sk-test-key-that-is-long-enough", model: "text-embedding-3-small" },
      credentials: { enabled: true, encryptionKey: ref },
    });

    const db = createCredentialsDbForConfig(cfg, join(tmpDir, "facts.db"));
    expect(db).not.toBeNull();
    expect(db!.get("legacy-service", "password")?.value).toBe("legacy-secret");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("legacy literal file: SecretRef"));
    db!.close();
  });

  it("getVaultStatus surfaces legacyLiteralFileKey + remediation when opened via the literal ref (#2099)", async () => {
    const { createCredentialsDbForConfig } = await import("../services/credentials-bootstrap.js");

    const ref = fileRef();
    const legacyDb = createLegacyVaultEncryptedWithKey(dbPath, ref);
    legacyDb.close();

    vi.spyOn(pluginLogger, "warn").mockImplementation(() => {});
    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", apiKey: "sk-test-key-that-is-long-enough", model: "text-embedding-3-small" },
      credentials: { enabled: true, encryptionKey: ref },
    });

    const db = createCredentialsDbForConfig(cfg, join(tmpDir, "facts.db"));
    expect(db).not.toBeNull();
    const status = db!.getVaultStatus();
    expect(status.legacyLiteralFileKey).toBe(true);
    expect(status.legacyLiteralFileKeyRemediation).toContain("credentials rekey-vault");
    db!.close();
  });

  it("getVaultStatus reports legacyLiteralFileKey false when opened via resolved file contents", async () => {
    const { createCredentialsDbForConfig } = await import("../services/credentials-bootstrap.js");

    writeFileSync(keyFile, TEST_KEY, "utf8");
    const ref = fileRef();
    const legacyDb = createLegacyVaultEncryptedWithKey(dbPath, TEST_KEY);
    legacyDb.close();

    const cfg = hybridConfigSchema.parse({
      embedding: { provider: "openai", apiKey: "sk-test-key-that-is-long-enough", model: "text-embedding-3-small" },
      credentials: { enabled: true, encryptionKey: ref },
    });

    const db = createCredentialsDbForConfig(cfg, join(tmpDir, "facts.db"));
    expect(db).not.toBeNull();
    const status = db!.getVaultStatus();
    expect(status.legacyLiteralFileKey).toBe(false);
    expect(status.legacyLiteralFileKeyRemediation).toBeNull();
    db!.close();
  });

  it("opens vault encrypted with file contents when file: ref is configured", async () => {
    const { probeCredentialsVaultKey, resolveCredentialsVaultKeyMaterial } = await import(
      "../services/credentials-encryption-key.js"
    );

    writeFileSync(keyFile, TEST_KEY, "utf8");
    const ref = fileRef();
    const vault = createLegacyVaultEncryptedWithKey(dbPath, TEST_KEY);
    vault.close();

    expect(resolveCredentialsVaultKeyMaterial(ref, dbPath)).toBe(TEST_KEY);
    expect(probeCredentialsVaultKey(dbPath, TEST_KEY)).toBe(true);
    expect(probeCredentialsVaultKey(dbPath, ref)).toBe(false);
  });

  it("returns empty key when no candidate opens an existing vault", async () => {
    const { resolveCredentialsVaultKeyMaterial } = await import("../services/credentials-encryption-key.js");
    const vault = createLegacyVaultEncryptedWithKey(dbPath, TEST_KEY);
    vault.close();

    expect(resolveCredentialsVaultKeyMaterial("wrong-key-material-not-vault-key", dbPath)).toBe("");
  });

  it("does not bootstrap a new vault with literal file: path when key file is missing", async () => {
    const { resolveCredentialsVaultKeyMaterial } = await import("../services/credentials-encryption-key.js");
    const missingKeyFile = join(tmpDir, "missing-vault.key");
    const ref = `file:${missingKeyFile}`;

    expect(existsSync(dbPath)).toBe(false);
    expect(resolveCredentialsVaultKeyMaterial(ref, dbPath)).toBe("");
  });
});

function createLegacyVaultEncryptedWithKey(dbPath: string, keyMaterial: string) {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new CredentialsDB(dbPath, keyMaterial);
  db.store({ service: "legacy-service", type: "password", value: "legacy-secret" });
  return db;
}
