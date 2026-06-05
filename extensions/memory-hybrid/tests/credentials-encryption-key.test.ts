import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hybridConfigSchema } from "../config.js";
import {
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
