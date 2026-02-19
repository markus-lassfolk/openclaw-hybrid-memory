/**
 * Credentials Store (opt-in, encrypted)
 * Secure credential storage with AES-256-GCM encryption and scrypt KDF.
 */

import Database from "better-sqlite3";
import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CredentialType } from "../config.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "../utils/constants.js";

const CRED_IV_LEN = 12;
const CRED_AUTH_TAG_LEN = 16;
const CRED_ALGO = "aes-256-gcm";
const CRED_KDF_VERSION = 2; // v1 = SHA-256 (legacy), v2 = scrypt

/** Derive encryption key using scrypt (v2) or SHA-256 (v1 for backward compatibility). */
function deriveKey(password: string, salt: Buffer, version: number = CRED_KDF_VERSION): Buffer {
  if (version === 1) {
    // Legacy SHA-256 KDF (weak, kept for backward compatibility)
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

export class CredentialsDB {
  private db: Database.Database;
  private readonly dbPath: string;
  private key: Buffer;
  private kdfVersion: number;
  private salt: Buffer;
  // SECURITY NOTE: Raw password is stored only for lazy migration from legacy SHA-256 to scrypt.
  // Migration is triggered on first successful get() to verify the password is correct before re-encrypting.
  // After migration completes, this field remains set but is no longer used (could be cleared in future optimization).
  // Alternative approaches (e.g., prompting user for password again during migration) would break unattended operation.
  private password: string;

  constructor(dbPath: string, encryptionKey: string) {
    this.dbPath = dbPath;
    this.password = encryptionKey;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.applyPragmas();
    
    // Create vault_meta table for KDF version and salt
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_meta (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      )
    `);
    
    this.db.exec(`
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
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_credentials_service ON credentials(service)
    `);
    
    // Initialize or load KDF version and salt
    // TEST COVERAGE NEEDED: This security-critical migration logic should be covered by tests:
    // 1. New vault: verify vault_meta is written and credentials are decryptable across instances
    // 2. Legacy vault (no vault_meta): verify migration to scrypt on first get() and subsequent decryptability
    // 3. Crash resilience: verify transaction rollback prevents partial migration
    const versionRow = this.db.prepare("SELECT value FROM vault_meta WHERE key = 'kdf_version'").get() as { value: Buffer } | undefined;
    const saltRow = this.db.prepare("SELECT value FROM vault_meta WHERE key = 'salt'").get() as { value: Buffer } | undefined;
    
    if (!versionRow || !saltRow) {
      // New vault or legacy vault without metadata
      const hasCredentials = (this.db.prepare("SELECT COUNT(*) as count FROM credentials").get() as { count: number }).count > 0;
      
      if (hasCredentials) {
        // Legacy vault with SHA-256 KDF - mark for migration
        this.kdfVersion = 1;
        this.salt = Buffer.alloc(0); // SHA-256 doesn't use salt
        this.key = deriveKey(encryptionKey, this.salt, 1);
        // Migration will happen on first successful get()
      } else {
        // New vault - use scrypt
        this.kdfVersion = CRED_KDF_VERSION;
        this.salt = randomBytes(32);
        this.key = deriveKey(encryptionKey, this.salt, this.kdfVersion);
        this.db.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('kdf_version', ?)").run(Buffer.from([this.kdfVersion]));
        this.db.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('salt', ?)").run(this.salt);
      }
    } else {
      // Existing vault with metadata
      this.kdfVersion = versionRow.value[0];
      this.salt = saltRow.value;
      this.key = deriveKey(encryptionKey, this.salt, this.kdfVersion);
    }
  }

  private applyPragmas(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  }

  /** Get the live DB handle, reopening if closed after a SIGUSR1 restart. */
  private get liveDb(): Database.Database {
    if (!this.db.open) {
      this.db = new Database(this.dbPath);
      this.applyPragmas();
    }
    return this.db;
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
    const encrypted = encryptValue(entry.value, this.key);
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
      .run(
        entry.service,
        entry.type,
        encrypted,
        entry.url ?? null,
        entry.notes ?? null,
        now,
        now,
        entry.expires ?? null,
      );
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
      ? (this.liveDb.prepare("SELECT * FROM credentials WHERE service = ? AND type = ?").get(service, type) as Record<string, unknown> | undefined)
      : (this.liveDb.prepare("SELECT * FROM credentials WHERE service = ? ORDER BY updated DESC LIMIT 1").get(service) as Record<string, unknown> | undefined);
    if (!row) return null;
    const buf = row.value as Buffer;
    const value = decryptValue(buf, this.key);
    
    // Trigger migration if this is a legacy vault (successful decryption proves correct password)
    if (this.kdfVersion === 1) {
      this.migrateLegacyVault();
    }
    
    return {
      service: row.service as string,
      type: (row.type as string) as CredentialType,
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
    // Fetch all credentials (will be decrypted with old key)
    const rows = this.liveDb.prepare("SELECT * FROM credentials").all() as Array<Record<string, unknown>>;
    
    // Generate new salt and derive new key with scrypt
    this.salt = randomBytes(32);
    const newKey = deriveKey(this.password, this.salt, CRED_KDF_VERSION);
    
    // Wrap all mutations in a transaction to prevent partial migration
    const migrate = this.liveDb.transaction(() => {
      // Re-encrypt all credentials with new key
      const updateStmt = this.liveDb.prepare("UPDATE credentials SET value = ? WHERE service = ? AND type = ?");
      for (const row of rows) {
        const oldBuf = row.value as Buffer;
        const plaintext = decryptValue(oldBuf, this.key); // Decrypt with old key
        const newEncrypted = encryptValue(plaintext, newKey); // Encrypt with new key
        updateStmt.run(newEncrypted, row.service, row.type);
      }
      
      // Update metadata
      this.liveDb.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('kdf_version', ?)").run(Buffer.from([CRED_KDF_VERSION]));
      this.liveDb.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('salt', ?)").run(this.salt);
    });
    
    migrate();
    
    // Update instance state
    this.kdfVersion = CRED_KDF_VERSION;
    this.key = newKey;
  }

  list(): Array<{ service: string; type: string; url: string | null; expires: number | null }> {
    const rows = this.liveDb.prepare("SELECT service, type, url, expires FROM credentials ORDER BY service, type").all() as Array<{
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

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

// Export encryption primitives for testing
export { deriveKey, encryptValue, decryptValue };
