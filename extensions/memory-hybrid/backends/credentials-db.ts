/**
 * Credentials Store (opt-in)
 * Optional AES-256-GCM encryption with scrypt KDF. When no encryption key is set,
 * values are stored in plaintext; the user may secure data by other means (e.g. filesystem permissions).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CredentialType } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { pluginLogger } from "../utils/logger.js";
import { createTransaction } from "../utils/sqlite-transaction.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";

/** node:sqlite returns BLOBs as Uint8Array; convert to Buffer for crypto ops. */
function toBuffer(val: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(val) ? val : Buffer.from(val);
}

const CRED_IV_LEN = 12;
const CRED_AUTH_TAG_LEN = 16;
const CRED_ALGO = "aes-256-gcm";
const CRED_KDF_VERSION = 2; // v1 = SHA-256 (legacy), v2 = scrypt
const CRED_KDF_PLAINTEXT = 0; // no encryption (user secures by other means)

/** Derive encryption key using scrypt.
 *  v1: legacy SHA-256 (kept for backward compatibility with existing encrypted vaults).
 *  v2: recommended scrypt parameters (N=16384, r=8, p=1).
 */
function deriveKey(password: string, salt: Buffer, version: number = CRED_KDF_VERSION): Buffer {
  if (version === 1) {
    // lgtm[js/insufficient-password-hash]
    // Legacy SHA-256 KDF (weak, kept for backward compatibility with existing encrypted vaults).
    // New vaults use v2 with scrypt. Existing v1 vaults encrypted with SHA-256 cannot be
    // decrypted with a different KDF, so we must preserve this for backward compatibility.
    return createHash("sha256").update(password, "utf8").digest();
  }
  // v2: scrypt with recommended parameters (N=16384, r=8, p=1)
  return scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

function encryptValue(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(CRED_IV_LEN);
  const cipher = createCipheriv(CRED_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptValue(buffer: Buffer, key: Buffer): string {
  const iv = buffer.subarray(0, CRED_IV_LEN);
  const authTag = buffer.subarray(CRED_IV_LEN, CRED_IV_LEN + CRED_AUTH_TAG_LEN);
  const encrypted = buffer.subarray(CRED_IV_LEN + CRED_AUTH_TAG_LEN);
  const decipher = createDecipheriv(CRED_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export type CredentialEntry = {
  service: string;
  type: CredentialType;
  value: string;
  url: string | null;
  notes: string | null;
  created: number;
  updated: number;
  expires: number | null;
};

export class CredentialsDB extends BaseSqliteStore {
  private readonly dbPath: string;
  private key!: Buffer;
  private kdfVersion!: number;
  private salt!: Buffer;
  /** When false, values are stored and read as plaintext (no encryption). */
  private readonly encrypted: boolean;
  // SECURITY NOTE: Raw password is stored only for lazy migration from legacy SHA-256 to scrypt.
  // Migration is triggered on first successful get() to verify the password is correct before re-encrypting.
  // After migration completes, this field is cleared to minimize exposure in memory.
  private password: string | null;

  constructor(dbPath: string, encryptionKey: string) {
    const encrypted = encryptionKey.length >= 16;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);
    this.dbPath = dbPath;
    this.encrypted = encrypted;

    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS vault_meta (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      )
    `);

    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        service TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        value BLOB NOT NULL,
        url TEXT,
        notes TEXT,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        expires INTEGER,
        PRIMARY KEY (service, type)
      )
    `);
    this.liveDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_credentials_service ON credentials(service)
    `);

    const versionRow = this.liveDb.prepare("SELECT value FROM vault_meta WHERE key = 'kdf_version'").get() as
      | { value: Uint8Array | Buffer }
      | undefined;
    const saltRow = this.liveDb.prepare("SELECT value FROM vault_meta WHERE key = 'salt'").get() as
      | { value: Uint8Array | Buffer }
      | undefined;

    if (!encrypted) {
      // Plaintext vault: no key derived
      this.kdfVersion = CRED_KDF_PLAINTEXT;
      this.salt = Buffer.alloc(0);
      this.key = Buffer.alloc(0);
      this.password = null;
      if (versionRow && versionRow.value != null && toBuffer(versionRow.value)[0] !== CRED_KDF_PLAINTEXT) {
        throw new Error(
          "Credentials vault was created with encryption. Set credentials.encryptionKey (or OPENCLAW_CRED_KEY) to open it, or use a new vault path for an unencrypted vault.",
        );
      }
      if (!versionRow) {
        // C1 FIX: Check if vault has encrypted data before marking as plaintext
        const hasCredentials =
          (this.liveDb.prepare("SELECT COUNT(*) as count FROM credentials").get() as { count: number }).count > 0;
        if (hasCredentials) {
          throw new Error(
            "Credentials vault contains data but no encryption metadata. This vault may have encrypted credentials. Provide credentials.encryptionKey to open it.",
          );
        }
        this.liveDb
          .prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('kdf_version', ?)")
          .run(Buffer.from([CRED_KDF_PLAINTEXT]));
      }
      return;
    }

    // Check if vault is plaintext first (before assuming legacy)
    if (versionRow && versionRow.value != null && toBuffer(versionRow.value)[0] === CRED_KDF_PLAINTEXT) {
      // C2 FIX: DB is plaintext, override this.encrypted regardless of key length
      (this as any).encrypted = false;
      this.kdfVersion = CRED_KDF_PLAINTEXT;
      this.salt = Buffer.alloc(0);
      this.key = Buffer.alloc(0);
      this.password = null;
      // Optionally warn that key is being ignored
      if (encryptionKey.length >= 16) {
        pluginLogger.warn(
          "Credentials vault is in plaintext mode (kdf_version=0). The provided encryption key is being ignored.",
        );
      }
      return;
    }

    if (!versionRow || !saltRow) {
      const hasCredentials =
        (this.liveDb.prepare("SELECT COUNT(*) as count FROM credentials").get() as { count: number }).count > 0;

      if (hasCredentials) {
        this.kdfVersion = 1;
        this.salt = Buffer.alloc(0);
        this.key = deriveKey(encryptionKey, this.salt, 1);
        this.password = encryptionKey;
      } else {
        this.kdfVersion = CRED_KDF_VERSION;
        this.salt = randomBytes(32);
        this.key = deriveKey(encryptionKey, this.salt, this.kdfVersion);
        this.password = null;
        this.liveDb
          .prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('kdf_version', ?)")
          .run(Buffer.from([this.kdfVersion]));
        this.liveDb.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('salt', ?)").run(this.salt);
      }
    } else {
      this.kdfVersion = versionRow.value != null ? toBuffer(versionRow.value)[0] : CRED_KDF_VERSION;
      this.salt = toBuffer(saltRow.value);
      this.key = deriveKey(encryptionKey, this.salt, this.kdfVersion);
      this.password = this.kdfVersion === 1 ? encryptionKey : null;
    }
  }

  protected getSubsystemName(): string {
    return "credentials";
  }

  store(entry: {
    service: string;
    type: CredentialType;
    value: string;
    url?: string;
    notes?: string;
    expires?: number | null;
  }): CredentialEntry {
    const now = Math.floor(Date.now() / 1000);
    const stored = this.encrypted ? encryptValue(entry.value, this.key) : Buffer.from(entry.value, "utf8");
    this.liveDb
      .prepare(
        `INSERT INTO credentials (service, type, value, url, notes, created, updated, expires)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service, type) DO UPDATE SET
           value = excluded.value,
           url = excluded.url,
           notes = excluded.notes,
           updated = excluded.updated,
           expires = excluded.expires`,
      )
      .run(entry.service, entry.type, stored, entry.url ?? null, entry.notes ?? null, now, now, entry.expires ?? null);
    return {
      service: entry.service,
      type: entry.type,
      value: "[redacted]",
      url: entry.url ?? null,
      notes: entry.notes ?? null,
      created: now,
      updated: now,
      expires: entry.expires ?? null,
    };
  }

  get(service: string, type?: CredentialType): CredentialEntry | null {
    const row = type
      ? (this.liveDb.prepare("SELECT * FROM credentials WHERE service = ? AND type = ?").get(service, type) as
          | Record<string, unknown>
          | undefined)
      : (this.liveDb
          .prepare("SELECT * FROM credentials WHERE service = ? ORDER BY updated DESC LIMIT 1")
          .get(service) as Record<string, unknown> | undefined);
    if (!row) return null;
    const buf = toBuffer(row.value as Uint8Array | Buffer);
    const value = this.encrypted ? decryptValue(buf, this.key) : buf.toString("utf8");

    if (this.kdfVersion === 1) {
      try {
        this.migrateLegacyVault();
      } catch (err) {
        capturePluginError(err as Error, {
          operation: "migrate-vault",
          severity: "info",
          subsystem: "credentials",
        });
        // Migration is best-effort; failure should not block credential retrieval
      }
    }

    return {
      service: row.service as string,
      type: row.type as string as CredentialType,
      value,
      url: (row.url as string) ?? null,
      notes: (row.notes as string) ?? null,
      created: row.created as number,
      updated: row.updated as number,
      expires: (row.expires as number) ?? null,
    };
  }

  /** Migrate legacy SHA-256 vault to scrypt. Called after first successful decryption. */
  private migrateLegacyVault(): void {
    if (!this.password) {
      throw new Error("Migration requires password");
    }

    // Fetch all credentials (will be decrypted with old key)
    const rows = this.liveDb.prepare("SELECT * FROM credentials").all() as Array<Record<string, unknown>>;

    // Generate new salt and derive new key with scrypt
    this.salt = randomBytes(32);
    const newKey = deriveKey(this.password, this.salt, CRED_KDF_VERSION);

    // Wrap all mutations in a transaction to prevent partial migration
    const migrate = createTransaction(this.liveDb, () => {
      // Re-encrypt all credentials with new key
      const updateStmt = this.liveDb.prepare("UPDATE credentials SET value = ? WHERE service = ? AND type = ?");
      for (const row of rows) {
        const oldBuf = toBuffer(row.value as Uint8Array | Buffer);
        const plaintext = decryptValue(oldBuf, this.key); // Decrypt with old key
        const newEncrypted = encryptValue(plaintext, newKey); // Encrypt with new key
        updateStmt.run(newEncrypted as unknown as Uint8Array, row.service as string, row.type as string);
      }

      // Update metadata
      this.liveDb
        .prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('kdf_version', ?)")
        .run(Buffer.from([CRED_KDF_VERSION]));
      this.liveDb.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('salt', ?)").run(this.salt);
    });

    migrate();

    // Update instance state
    this.kdfVersion = CRED_KDF_VERSION;
    this.key = newKey;
    this.password = null;
  }

  /**
   * Store only if no entry exists for this service+type.
   * Returns the stored entry on success, or null if an entry already existed (skipped).
   * Use this for auto-capture to avoid overwriting user-managed credentials.
   *
   * Uses a single `INSERT … ON CONFLICT(service, type) DO NOTHING` statement so the
   * check-and-insert is atomic — no TOCTOU race between concurrent writers.
   *
   * Also treats underscore ↔ hyphen variants as equivalent (e.g. `openai_api` and
   * `openai-api`) so that migration from the pre-normalisation naming convention does
   * not create duplicate vault entries on subsequent auto-capture runs.
   */
  storeIfNew(entry: {
    service: string;
    type: CredentialType;
    value: string;
    url?: string;
    notes?: string;
    expires?: number | null;
  }): CredentialEntry | null {
    // Check for a legacy cross-variant (underscore ↔ hyphen) before inserting so we
    // don't create a parallel entry alongside an existing differently-named one.
    const legacyVariant = entry.service.includes("_")
      ? entry.service.replace(/_/g, "-")
      : entry.service.replace(/-/g, "_");
    if (legacyVariant !== entry.service && this.exists(legacyVariant, entry.type)) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const stored = this.encrypted ? encryptValue(entry.value, this.key) : Buffer.from(entry.value, "utf8");
    const result = this.liveDb
      .prepare(
        `INSERT INTO credentials (service, type, value, url, notes, created, updated, expires)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service, type) DO NOTHING`,
      )
      .run(entry.service, entry.type, stored, entry.url ?? null, entry.notes ?? null, now, now, entry.expires ?? null);
    if (result.changes === 0) {
      // A credential already exists for this service+type; do not overwrite it.
      return null;
    }
    return {
      service: entry.service,
      type: entry.type,
      value: "[redacted]",
      url: entry.url ?? null,
      notes: entry.notes ?? null,
      created: now,
      updated: now,
      expires: entry.expires ?? null,
    };
  }

  /** Returns true if an entry already exists for the given service (and optional type). */
  exists(service: string, type?: CredentialType): boolean {
    if (type) {
      const row = this.liveDb
        .prepare("SELECT 1 FROM credentials WHERE service = ? AND type = ? LIMIT 1")
        .get(service, type);
      return !!row;
    }
    const row = this.liveDb.prepare("SELECT 1 FROM credentials WHERE service = ? LIMIT 1").get(service);
    return !!row;
  }

  /**
   * List all credentials with decrypted values.
   * Use sparingly (decrypts every value). Primarily for audit operations.
   */
  listAll(): CredentialEntry[] {
    const rows = this.liveDb.prepare("SELECT * FROM credentials ORDER BY service, type").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => {
      const buf = toBuffer(row.value as Uint8Array | Buffer);
      const value = this.encrypted ? decryptValue(buf, this.key) : buf.toString("utf8");
      return {
        service: row.service as string,
        type: row.type as string as CredentialType,
        value,
        url: (row.url as string) ?? null,
        notes: (row.notes as string) ?? null,
        created: row.created as number,
        updated: row.updated as number,
        expires: (row.expires as number) ?? null,
      };
    });
  }

  list(): Array<{ service: string; type: string; url: string | null; expires: number | null }> {
    const rows = this.liveDb
      .prepare("SELECT service, type, url, expires FROM credentials ORDER BY service, type")
      .all() as Array<{
      service: string;
      type: string;
      url: string | null;
      expires: number | null;
    }>;
    return rows;
  }

  delete(service: string, type?: CredentialType): boolean {
    if (type) {
      const r = this.liveDb.prepare("DELETE FROM credentials WHERE service = ? AND type = ?").run(service, type);
      return r.changes > 0;
    }
    const r = this.liveDb.prepare("DELETE FROM credentials WHERE service = ?").run(service);
    return r.changes > 0;
  }
}

// Export encryption primitives for testing
export { deriveKey, encryptValue, decryptValue };
