/**
 * Credentials Store (opt-in)
 * Optional AES-256-GCM encryption with scrypt KDF. When no encryption key is set,
 * values are stored in plaintext; the user may secure data by other means (e.g. filesystem permissions).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CredentialType } from "../config.js";
import { CREDENTIAL_TYPES } from "../config.js";
import {
  ENDPOINT_ONLY_CREDENTIAL_VALUE,
  planLegacyUrlCredentialMigration,
} from "../services/credential-type-migration.js";
import { assertValidCredentialRow, assertValidCredentialType } from "../services/credential-validation.js";
import { capturePluginError } from "../services/error-reporter.js";
import { pluginLogger } from "../utils/logger.js";
import { SECONDS_PER_DAY } from "../utils/constants.js";
import { tryRestrictSqliteDbFileMode } from "../utils/sqlite-file-perms.js";
import { createTransaction } from "../utils/sqlite-transaction.js";
import { BaseSqliteStore } from "./base-sqlite-store.js";

/** Default retention window for a replaced credential's historical revision (issue #2104). */
const DEFAULT_REVISION_TTL_DAYS = 30;

/** node:sqlite returns BLOBs as Uint8Array; convert to Buffer for crypto ops. */
function toBuffer(val: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(val) ? val : Buffer.from(val);
}

const CRED_IV_LEN = 12;
const CRED_AUTH_TAG_LEN = 16;
const CRED_ALGO = "aes-256-gcm";
const CRED_KDF_VERSION = 2; // v1 = SHA-256 (legacy), v2 = scrypt
const CRED_KDF_PLAINTEXT = 0; // no encryption (user secures by other means)

/** Log once per vault path: legacy v1 KDF is weak; opening triggers migration to scrypt when possible. */
const _v1KdfWarnedPaths = new Set<string>();

/** Log once per vault path: key is configured but vault is plaintext (kdf_version=0). */
const _plaintextKeyIgnoredWarnedPaths = new Set<string>();

/** v1 only: legacy SHA-256 KDF (weak). Existing vaults cannot be decrypted with another KDF. */
function deriveKeyV1Legacy(password: string): Buffer {
  // codeql[js/insufficient-password-hash]
  // Legacy v1 on-disk format only; new vaults use deriveKeyV2 (scrypt). Changing this breaks existing vaults.
  return createHash("sha256").update(password, "utf8").digest();
}

/** v2: scrypt (N=16384, r=8, p=1). */
function deriveKeyV2(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

/** Dispatch v1 (legacy) vs v2 (scrypt). Prefer deriveKeyV2 for new material when version is known. */
function deriveKey(password: string, salt: Buffer, version: number = CRED_KDF_VERSION): Buffer {
  if (version === 1) {
    // codeql[js/insufficient-password-hash]
    // Password only flows to the intentional legacy KDF above; v2 uses scrypt.
    return deriveKeyV1Legacy(password);
  }
  return deriveKeyV2(password, salt);
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

/** Metadata for a historical credential revision — never carries the decrypted value (issue #2104). */
export type CredentialRevisionMeta = {
  id: string;
  service: string;
  type: CredentialType;
  url: string | null;
  notes: string | null;
  /** `created` of the credential row this revision was replaced from (preserved across restores). */
  created: number;
  /** The replaced credential's own business-logic expiry, if any (distinct from `expiresAt`). */
  credExpires: number | null;
  /** When this revision was written (i.e. when the credential it replaced was overwritten). */
  replacedAt: number;
  /** Retention TTL for this revision; null means it never expires (only true while pinned). */
  expiresAt: number | null;
  /** Non-null (a timestamp) means the revision is pinned and exempt from expiry. */
  pinnedAt: number | null;
  /** Session/agent identifier that triggered the replacement, when available. */
  replacedBy: string | null;
};

export type CredentialRevisionEntry = CredentialRevisionMeta & { value: string };

export type CredentialRevisionAuditAction = "retrieve" | "restore" | "purge" | "purge_all" | "pin" | "unpin";

export type CredentialRevisionAuditEvent = {
  id: string;
  ts: number;
  service: string;
  type: CredentialType;
  revisionId: string;
  action: CredentialRevisionAuditAction;
  actor: string | null;
};

export class CredentialsDB extends BaseSqliteStore {
  private readonly dbPath: string;
  private key!: Buffer;
  private kdfVersion!: number;
  private salt!: Buffer;
  /** When false, values are stored and read as plaintext (no encryption). Mutable when DB metadata overrides key length heuristics. */
  private storesEncryptedValues: boolean;
  /** True when a 16+ character encryption key was provided to the constructor. */
  private readonly configuredKeyPresent: boolean;
  /** True when the vault was opened using the legacy literal `file:/path` ref as the passphrase
   * itself, rather than resolved file contents (#2099). Surfaced via getVaultStatus(). */
  private readonly legacyLiteralFileKey: boolean;
  private legacyTypesMigrated = false;
  // SECURITY NOTE: Raw password is stored only for lazy migration from legacy SHA-256 to scrypt.
  // Migration is triggered on first successful get() to verify the password is correct before re-encrypting.
  // After migration completes, this field is cleared to minimize exposure in memory.
  private password: string | null;

  constructor(dbPath: string, encryptionKey: string, legacyLiteralFileKey = false) {
    const keyLooksEncrypted = encryptionKey.length >= 16;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    super(db);
    this.dbPath = dbPath;
    this.configuredKeyPresent = keyLooksEncrypted;
    this.legacyLiteralFileKey = legacyLiteralFileKey;
    tryRestrictSqliteDbFileMode(dbPath);
    this.storesEncryptedValues = keyLooksEncrypted;

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
    this.ensureRevisionsSchema();

    const versionRow = this.liveDb.prepare("SELECT value FROM vault_meta WHERE key = 'kdf_version'").get() as
      | { value: Uint8Array | Buffer }
      | undefined;
    const saltRow = this.liveDb.prepare("SELECT value FROM vault_meta WHERE key = 'salt'").get() as
      | { value: Uint8Array | Buffer }
      | undefined;

    if (!keyLooksEncrypted) {
      // Plaintext vault: no key derived
      this.kdfVersion = CRED_KDF_PLAINTEXT;
      this.salt = Buffer.alloc(0);
      this.key = Buffer.alloc(0);
      this.password = null;
      if (versionRow && versionRow.value != null && toBuffer(versionRow.value)[0] !== CRED_KDF_PLAINTEXT) {
        db.close();
        throw new Error(
          "Credentials vault was created with encryption. Set credentials.encryptionKey (or OPENCLAW_CRED_KEY) to open it, or use a new vault path for an unencrypted vault.",
        );
      }
      if (!versionRow) {
        // C1 FIX: Check if vault has encrypted data before marking as plaintext
        const hasCredentials =
          (this.liveDb.prepare("SELECT COUNT(*) as count FROM credentials").get() as { count: number }).count > 0;
        if (hasCredentials) {
          db.close();
          throw new Error(
            "Credentials vault contains data but no encryption metadata. This vault may have encrypted credentials. Provide credentials.encryptionKey to open it.",
          );
        }
        this.liveDb
          .prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('kdf_version', ?)")
          .run(Buffer.from([CRED_KDF_PLAINTEXT]));
      }
      this.maybeMigrateLegacyCredentialTypes();
      return;
    }

    // Check if vault is plaintext first (before assuming legacy)
    if (versionRow && versionRow.value != null && toBuffer(versionRow.value)[0] === CRED_KDF_PLAINTEXT) {
      // DB metadata says plaintext — never treat as encrypted regardless of key length (Issue #835).
      this.storesEncryptedValues = false;
      this.kdfVersion = CRED_KDF_PLAINTEXT;
      this.salt = Buffer.alloc(0);
      this.key = Buffer.alloc(0);
      this.password = null;
      // Optionally warn that key is being ignored (once per process per path)
      if (encryptionKey.length >= 16 && !_plaintextKeyIgnoredWarnedPaths.has(dbPath)) {
        _plaintextKeyIgnoredWarnedPaths.add(dbPath);
        pluginLogger.warn(
          "Credentials vault is in plaintext mode (kdf_version=0). The configured encryption key is being ignored. " +
            "To encrypt the existing vault at rest, run: openclaw hybrid-mem credentials encrypt-vault --backup --verify --yes",
        );
      }
      this.maybeMigrateLegacyCredentialTypes();
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

    if (this.storesEncryptedValues && this.kdfVersion === 1 && !_v1KdfWarnedPaths.has(dbPath)) {
      _v1KdfWarnedPaths.add(dbPath);
      pluginLogger.warn(
        "memory-hybrid: credentials vault uses legacy key derivation (v1 / SHA-256). This is weak against offline attacks. " +
          "The vault will migrate to scrypt (v2) automatically after the next successful unlock. " +
          "Set a strong OPENCLAW_CRED_KEY and restart, or rotate secrets after migration.",
      );
    }
    this.maybeMigrateLegacyCredentialTypes();
  }

  /** Historical-revision tables (issue #2104). Idempotent; safe to call on every open. */
  private ensureRevisionsSchema(): void {
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS credential_revisions (
        id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        value BLOB NOT NULL,
        url TEXT,
        notes TEXT,
        created INTEGER NOT NULL,
        cred_expires INTEGER,
        replaced_at INTEGER NOT NULL,
        expires_at INTEGER,
        pinned_at INTEGER,
        replaced_by TEXT
      )
    `);
    this.liveDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_credential_revisions_service_type ON credential_revisions(service, type)
    `);
    this.liveDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_credential_revisions_expires
      ON credential_revisions(expires_at) WHERE expires_at IS NOT NULL
    `);
    this.liveDb.exec(`
      CREATE TABLE IF NOT EXISTS credential_revision_audit (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        service TEXT NOT NULL,
        type TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT
      )
    `);
    this.liveDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_credential_revision_audit_service_type
      ON credential_revision_audit(service, type)
    `);
  }

  /** Migrate invalid legacy credential types (e.g. type=url) to supported schema. Idempotent. */
  private maybeMigrateLegacyCredentialTypes(): void {
    if (this.legacyTypesMigrated) return;
    try {
      this.migrateLegacyCredentialTypes();
      this.legacyTypesMigrated = true;
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "credentials",
        operation: "migrate-legacy-credential-types",
        severity: "warning",
      });
    }
  }

  private decryptStoredValue(buf: Uint8Array | Buffer): string {
    const buffer = toBuffer(buf);
    return this.storesEncryptedValues ? decryptValue(buffer, this.key) : buffer.toString("utf8");
  }

  private migrateLegacyCredentialTypes(): void {
    const invalidRows = this.liveDb
      .prepare(
        `SELECT service, type FROM credentials
         WHERE type NOT IN (${CREDENTIAL_TYPES.map(() => "?").join(", ")})`,
      )
      .all(...CREDENTIAL_TYPES) as Array<{ service: string; type: string }>;
    if (invalidRows.length === 0) return;

    const migrate = createTransaction(
      this.liveDb,
      () => {
        for (const service of [...new Set(invalidRows.map((r) => r.service))]) {
          const serviceRows = this.liveDb.prepare("SELECT * FROM credentials WHERE service = ?").all(service) as Array<
            Record<string, unknown>
          >;
          const typesPresent = new Set(serviceRows.map((r) => String(r.type)));

          for (const row of serviceRows) {
            const legacyType = String(row.type);
            if (legacyType !== "url") continue;

            const decryptedValue = this.decryptStoredValue(row.value as Uint8Array | Buffer);
            const plan = planLegacyUrlCredentialMigration({
              service,
              decryptedValue,
              existingUrl: (row.url as string | null) ?? null,
              existingNotes: (row.notes as string | null) ?? null,
              siblingTypesPresent: typesPresent,
            });

            if (plan.action === "noop" || !plan.endpointUrl) {
              this.liveDb.prepare("DELETE FROM credentials WHERE service = ? AND type = ?").run(service, legacyType);
              typesPresent.delete(legacyType);
              continue;
            }

            const now = Math.floor(Date.now() / 1000);

            if (plan.action === "merge_into_sibling" && plan.siblingType) {
              const updateResult = this.liveDb
                .prepare(
                  "UPDATE credentials SET url = ?, updated = ? WHERE service = ? AND type = ? AND (url IS NULL OR url = '')",
                )
                .run(plan.endpointUrl, now, service, plan.siblingType);
              if (updateResult.changes === 0) {
                const targetRow = this.liveDb
                  .prepare("SELECT notes FROM credentials WHERE service = ? AND type = ?")
                  .get(service, plan.siblingType) as { notes: string | null } | undefined;
                const existingNotes = targetRow?.notes?.trim() || "";
                const legacyEndpointNote = `[Legacy endpoint: ${plan.endpointUrl}]`;
                const updatedNotes = existingNotes ? `${existingNotes} ${legacyEndpointNote}` : legacyEndpointNote;
                this.liveDb
                  .prepare("UPDATE credentials SET notes = ?, updated = ? WHERE service = ? AND type = ?")
                  .run(updatedNotes, now, service, plan.siblingType);
              }
              this.liveDb.prepare("DELETE FROM credentials WHERE service = ? AND type = ?").run(service, legacyType);
              typesPresent.delete(legacyType);
              continue;
            }

            if (plan.action === "merge_into_other") {
              const updateResult = this.liveDb
                .prepare(
                  "UPDATE credentials SET url = ?, updated = ? WHERE service = ? AND type = 'other' AND (url IS NULL OR url = '')",
                )
                .run(plan.endpointUrl, now, service);
              if (updateResult.changes === 0) {
                const targetRow = this.liveDb
                  .prepare("SELECT notes FROM credentials WHERE service = ? AND type = 'other'")
                  .get(service) as { notes: string | null } | undefined;
                const existingNotes = targetRow?.notes?.trim() || "";
                const legacyEndpointNote = `[Legacy endpoint: ${plan.endpointUrl}]`;
                const updatedNotes = existingNotes ? `${existingNotes} ${legacyEndpointNote}` : legacyEndpointNote;
                this.liveDb
                  .prepare("UPDATE credentials SET notes = ?, updated = ? WHERE service = ? AND type = 'other'")
                  .run(updatedNotes, now, service);
              }
              this.liveDb.prepare("DELETE FROM credentials WHERE service = ? AND type = ?").run(service, legacyType);
              typesPresent.delete(legacyType);
              continue;
            }

            if (plan.action === "convert_to_other") {
              const stored = this.storesEncryptedValues
                ? (encryptValue(ENDPOINT_ONLY_CREDENTIAL_VALUE, this.key) as unknown as Uint8Array)
                : new Uint8Array(Buffer.from(ENDPOINT_ONLY_CREDENTIAL_VALUE, "utf8"));
              this.liveDb.prepare("DELETE FROM credentials WHERE service = ? AND type = ?").run(service, legacyType);
              this.liveDb
                .prepare(
                  `INSERT INTO credentials (service, type, value, url, notes, created, updated, expires)
                 VALUES (?, 'other', ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  service,
                  stored,
                  plan.endpointUrl,
                  plan.notes ?? null,
                  (row.created as number) ?? now,
                  now,
                  (row.expires as number | null) ?? null,
                );
              typesPresent.delete(legacyType);
              typesPresent.add("other");
            }
          }
        }

        // Drop any remaining unsupported types that were not handled above ("url" is the only
        // known legacy type with a defined migration path — anything else has no safe
        // transformation and is dropped here rather than left permanently unreadable via
        // assertValidCredentialType()).
        const droppedRows = this.liveDb
          .prepare(`SELECT service, type FROM credentials WHERE type NOT IN (${CREDENTIAL_TYPES.map(() => "?").join(", ")})`)
          .all(...CREDENTIAL_TYPES) as Array<{ service: string; type: string }>;
        this.liveDb
          .prepare(`DELETE FROM credentials WHERE type NOT IN (${CREDENTIAL_TYPES.map(() => "?").join(", ")})`)
          .run(...CREDENTIAL_TYPES);
        if (droppedRows.length > 0) {
          pluginLogger.warn(
            `memory-hybrid: dropped ${droppedRows.length} credential row(s) with an unrecognized type that has no known migration path: ` +
              droppedRows.map((r) => `${r.service} (type="${r.type}")`).join(", "),
          );
        }
      },
      "IMMEDIATE",
    );

    migrate();
    pluginLogger.info?.(
      `memory-hybrid: migrated ${invalidRows.length} legacy credential row(s) with invalid type field`,
    );
  }

  protected getSubsystemName(): string {
    return "credentials";
  }

  getVaultStatus(): {
    dbPath: string;
    kdfVersion: number;
    encryptedAtRest: boolean;
    configuredKeyPresent: boolean;
    keyIgnored: boolean;
    migrationRequired: boolean;
    entryCount: number;
    /** #2099: true when the vault was opened using the legacy literal `file:/path` passphrase. */
    legacyLiteralFileKey: boolean;
    /** #2099: present only when legacyLiteralFileKey is true — the exact remediation command. */
    legacyLiteralFileKeyRemediation: string | null;
  } {
    const encryptedAtRest = this.kdfVersion !== CRED_KDF_PLAINTEXT;
    const keyIgnored = this.kdfVersion === CRED_KDF_PLAINTEXT && this.configuredKeyPresent;
    const migrationRequired = keyIgnored;
    const entryCount = (this.liveDb.prepare("SELECT COUNT(*) as count FROM credentials").get() as { count: number })
      .count;
    return {
      dbPath: this.dbPath,
      kdfVersion: this.kdfVersion,
      encryptedAtRest,
      configuredKeyPresent: this.configuredKeyPresent,
      keyIgnored,
      migrationRequired,
      entryCount,
      legacyLiteralFileKey: this.legacyLiteralFileKey,
      legacyLiteralFileKeyRemediation: this.legacyLiteralFileKey
        ? "Store the desired passphrase in the file referenced by credentials.encryptionKey, then run: openclaw hybrid-mem credentials rekey-vault --backup --verify --yes"
        : null,
    };
  }

  /**
   * Encrypt an existing plaintext vault in place.
   * Requires a 16+ character encryption key. Safe and idempotent:
   * - Throws if vault is already encrypted
   * - Performs an in-DB transaction so it cannot partially convert rows
   */
  enableEncryptionAtRest(encryptionKey: string): { migrated: number; kdfVersion: number } {
    const keyLooksEncrypted = encryptionKey.length >= 16;
    if (!keyLooksEncrypted) {
      throw new Error(
        "Encryption key is missing or too short. Set credentials.encryptionKey (16+ chars) or OPENCLAW_CRED_KEY before encrypting the vault.",
      );
    }
    if (this.kdfVersion !== CRED_KDF_PLAINTEXT) {
      throw new Error(`Credentials vault is already encrypted (kdf_version=${this.kdfVersion}).`);
    }

    const newSalt = randomBytes(32);
    const newKdfVersion = CRED_KDF_VERSION;
    const newKey = deriveKey(encryptionKey, newSalt, newKdfVersion);

    let migratedCount = 0;
    const migrate = createTransaction(
      this.liveDb,
      () => {
        const rows = this.liveDb.prepare("SELECT service, type, value FROM credentials").all() as Array<{
          service: string;
          type: string;
          value: Uint8Array | Buffer;
        }>;
        migratedCount = rows.length;
        const updateStmt = this.liveDb.prepare("UPDATE credentials SET value = ? WHERE service = ? AND type = ?");
        for (const r of rows) {
          const plaintext = toBuffer(r.value).toString("utf8");
          const encrypted = encryptValue(plaintext, newKey);
          updateStmt.run(encrypted as unknown as Uint8Array, r.service, r.type);
        }
        // Revisions carry the same ciphertext protection as current values (issue #2104) — without
        // this they would silently stay on the old (plaintext) key after this method returns.
        this.reencryptAllRevisions(newKey);
        this.liveDb
          .prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('kdf_version', ?)")
          .run(Buffer.from([newKdfVersion]));
        this.liveDb.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('salt', ?)").run(newSalt);
      },
      "IMMEDIATE",
    );

    migrate();

    this.kdfVersion = newKdfVersion;
    this.salt = newSalt;
    this.key = newKey;
    this.password = null;
    this.storesEncryptedValues = true;

    return { migrated: migratedCount, kdfVersion: this.kdfVersion };
  }

  /**
   * Re-encrypt every `credential_revisions.value` with `newKey`, decrypting with the CURRENT
   * (pre-migration) key/mode. Must run inside the same transaction as the main `credentials`
   * re-encryption, and before `this.key`/`this.storesEncryptedValues` are updated to the new values.
   */
  private reencryptAllRevisions(newKey: Buffer): number {
    const rows = this.liveDb.prepare("SELECT id, value FROM credential_revisions").all() as Array<{
      id: string;
      value: Uint8Array | Buffer;
    }>;
    const updateStmt = this.liveDb.prepare("UPDATE credential_revisions SET value = ? WHERE id = ?");
    for (const r of rows) {
      const plaintext = this.decryptStoredValue(r.value);
      const encrypted = encryptValue(plaintext, newKey);
      updateStmt.run(encrypted as unknown as Uint8Array, r.id);
    }
    return rows.length;
  }

  /**
   * Safe vault encryption with optional backup and post-encryption verification.
   *
   * Steps:
   * 1. If `backupPath` is set, create a consistent copy of the current plaintext DB via VACUUM INTO.
   * 2. Encrypt the vault in-place via `enableEncryptionAtRest`.
   * 3. If `verify` is true, attempt to decrypt every entry to confirm data integrity.
   *    On failure, throws with the backup path so the operator can restore manually.
   *
   * Safety: does NOT auto-restore on verify failure — the in-place operation may have
   * already committed. The caller should inspect `backupPath` and restore if needed.
   */
  encryptVaultSafe(
    encryptionKey: string,
    opts: { backupPath?: string; verify?: boolean } = {},
  ): { migrated: number; kdfVersion: number; backupPath?: string; verified?: boolean } {
    const { backupPath, verify } = opts;

    const keyLooksEncrypted = encryptionKey.length >= 16;
    if (!keyLooksEncrypted) {
      throw new Error(
        "Encryption key is missing or too short. Set credentials.encryptionKey (16+ chars) or OPENCLAW_CRED_KEY before encrypting the vault.",
      );
    }
    if (this.kdfVersion !== CRED_KDF_PLAINTEXT) {
      throw new Error(`Credentials vault is already encrypted (kdf_version=${this.kdfVersion}).`);
    }

    const newSalt = randomBytes(32);
    const newKdfVersion = CRED_KDF_VERSION;
    const newKey = deriveKey(encryptionKey, newSalt, newKdfVersion);

    let migratedCount = 0;

    // Perform backup and encryption in a single IMMEDIATE transaction to prevent
    // writes between backup snapshot and encryption. This fixes the race condition
    // where VACUUM INTO would snapshot at T1, then new rows could be written at T2,
    // then encryption would start at T3, resulting in encrypted rows missing from backup.

    // Preserve existing backup during retry by renaming it temporarily
    let oldBackupPath: string | undefined;
    if (backupPath) {
      mkdirSync(dirname(backupPath), { recursive: true });
      try {
        // Check if old backup exists and rename it temporarily
        if (existsSync(backupPath)) {
          oldBackupPath = `${backupPath}.old.${Date.now()}`;
          renameSync(backupPath, oldBackupPath);
        }
      } catch {
        // If rename fails, proceed anyway (file might not exist)
      }
    }

    const migrateWithBackup = createTransaction(
      this.liveDb,
      () => {
        if (backupPath) {
          // Create backup database and copy all data within this transaction
          const backupDb = new DatabaseSync(backupPath);
          try {
            // Copy schema
            backupDb.exec(`
              CREATE TABLE vault_meta (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL
              )
            `);
            backupDb.exec(`
              CREATE TABLE credentials (
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
            backupDb.exec(`
              CREATE INDEX idx_credentials_service ON credentials(service)
            `);

            // Copy vault_meta
            const metaRows = this.liveDb.prepare("SELECT key, value FROM vault_meta").all() as Array<{
              key: string;
              value: Uint8Array | Buffer;
            }>;
            const insertMeta = backupDb.prepare("INSERT INTO vault_meta (key, value) VALUES (?, ?)");
            for (const row of metaRows) {
              insertMeta.run(row.key, row.value);
            }

            // Copy credentials
            const credRows = this.liveDb.prepare("SELECT * FROM credentials").all() as Array<Record<string, unknown>>;
            migratedCount = credRows.length;
            const insertCred = backupDb.prepare(
              "INSERT INTO credentials (service, type, value, url, notes, created, updated, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            );
            for (const row of credRows) {
              insertCred.run(
                row.service as string,
                row.type as string,
                row.value as string,
                row.url as string | null,
                row.notes as string | null,
                row.created as number,
                row.updated as number,
                row.expires as number | null,
              );
            }

            backupDb.close();
            tryRestrictSqliteDbFileMode(backupPath);
          } catch (err) {
            backupDb.close();
            throw err;
          }
        } else {
          // No backup, just count rows
          const rows = this.liveDb.prepare("SELECT service, type FROM credentials").all() as Array<{
            service: string;
            type: string;
          }>;
          migratedCount = rows.length;
        }

        // Now encrypt within the same transaction
        const rows = this.liveDb.prepare("SELECT service, type, value FROM credentials").all() as Array<{
          service: string;
          type: string;
          value: Uint8Array | Buffer;
        }>;
        const updateStmt = this.liveDb.prepare("UPDATE credentials SET value = ? WHERE service = ? AND type = ?");
        for (const r of rows) {
          const plaintext = toBuffer(r.value).toString("utf8");
          const encrypted = encryptValue(plaintext, newKey);
          updateStmt.run(encrypted as unknown as Uint8Array, r.service, r.type);
        }
        // Revisions carry the same ciphertext protection as current values (issue #2104). The
        // pre-encryption backup above intentionally does not snapshot credential_revisions — it
        // exists to roll back current credential values, not full revision history.
        this.reencryptAllRevisions(newKey);
        this.liveDb
          .prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('kdf_version', ?)")
          .run(Buffer.from([newKdfVersion]));
        this.liveDb.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('salt', ?)").run(newSalt);
      },
      "IMMEDIATE",
    );

    let migrationSucceeded = false;
    try {
      migrateWithBackup();
      migrationSucceeded = true;

      this.kdfVersion = newKdfVersion;
      this.salt = newSalt;
      this.key = newKey;
      this.password = null;
      this.storesEncryptedValues = true;

      const result = { migrated: migratedCount, kdfVersion: this.kdfVersion };

      let verified: boolean | undefined;
      if (verify) {
        try {
          const entries = this.listAll();
          // Verify that all encrypted entries were successfully decrypted
          if (entries.length !== result.migrated) {
            throw new Error(
              `Verification failed: only ${entries.length} of ${result.migrated} entries could be decrypted`,
            );
          }
          for (const e of entries) {
            const verifiedEntry = this.get(e.service, e.type as CredentialType);
            if (!verifiedEntry) {
              throw new Error(`Verification failed: missing credential ${e.service}/${e.type}`);
            }
          }
          verified = true;
        } catch (err) {
          const backupNote = backupPath ? ` Plaintext backup is at: ${backupPath}` : "";
          throw new Error(
            `Vault encrypted but post-encryption verification failed: ${err instanceof Error ? err.message : String(err)}.${backupNote}`,
          );
        }
      }

      // Success: delete the old backup if it exists
      if (oldBackupPath) {
        try {
          unlinkSync(oldBackupPath);
        } catch {
          // Best effort cleanup; don't fail on cleanup errors
        }
      }

      return {
        ...result,
        ...(backupPath !== undefined ? { backupPath } : {}),
        ...(verified !== undefined ? { verified } : {}),
      };
    } catch (err) {
      // After successful migration, keep the new backup (at backupPath) that matches the encrypted state.
      // Only restore the old backup if migration itself failed.
      if (oldBackupPath && backupPath && !migrationSucceeded) {
        try {
          if (existsSync(backupPath)) {
            unlinkSync(backupPath);
          }
          renameSync(oldBackupPath, backupPath);
        } catch {
          // If restore fails, leave both files (old backup is preserved with .old suffix)
        }
      }
      throw err;
    }
  }

  /**
   * Re-encrypt an already-encrypted vault with new key material.
   * Used to migrate off legacy literal `file:/path` passphrases to file-content semantics.
   */
  rekeyVaultSafe(
    newEncryptionKey: string,
    opts: { backupPath?: string; verify?: boolean } = {},
  ): { rekeyed: number; kdfVersion: number; backupPath?: string; verified?: boolean } {
    const { backupPath, verify } = opts;

    if (newEncryptionKey.length < 16) {
      throw new Error(
        "New encryption key is missing or too short. Set credentials.encryptionKey (16+ chars) or OPENCLAW_CRED_KEY.",
      );
    }
    if (this.kdfVersion === CRED_KDF_PLAINTEXT) {
      throw new Error("Cannot rekey a plaintext vault. Run encrypt-vault first.");
    }

    const { entries: decryptedEntries, skippedCount } = this.listAllWithSkipped();
    if (skippedCount > 0) {
      // Aborting before the transaction starts (nothing has been mutated yet) is deliberate:
      // rekeying only re-encrypts rows present in plaintextRows, then unconditionally bumps
      // vault_meta's kdf_version/salt to the new key. Any row that failed to decrypt with the
      // CURRENT key would silently stay on old ciphertext while the vault believes everything
      // now uses the new key/salt — permanently undecryptable, with no error ever surfaced.
      throw new Error(
        `Rekey aborted: ${skippedCount} of ${skippedCount + decryptedEntries.length} credential row(s) could not be decrypted with the current key. Fix or remove those rows before rekeying — proceeding would silently leave them on the old key while the vault records the new one.`,
      );
    }
    // Same guard for historical revisions (issue #2104) — a revision that can't be decrypted with
    // the current key would otherwise silently stay on the old key while vault_meta records the new one.
    const revisionRowsPreflight = this.liveDb.prepare("SELECT value FROM credential_revisions").all() as Array<{
      value: Uint8Array | Buffer;
    }>;
    let revisionSkippedCount = 0;
    for (const r of revisionRowsPreflight) {
      try {
        this.decryptStoredValue(r.value);
      } catch {
        revisionSkippedCount++;
      }
    }
    if (revisionSkippedCount > 0) {
      throw new Error(
        `Rekey aborted: ${revisionSkippedCount} of ${revisionRowsPreflight.length} credential revision row(s) could not be decrypted with the current key. Fix or purge those revisions before rekeying.`,
      );
    }
    const plaintextRows = decryptedEntries.map((entry) => ({
      service: entry.service,
      type: entry.type as CredentialType,
      value: entry.value,
      url: entry.url,
      notes: entry.notes,
      created: entry.created,
      updated: entry.updated,
      expires: entry.expires,
    }));

    const newSalt = randomBytes(32);
    const newKdfVersion = CRED_KDF_VERSION;
    const newKey = deriveKey(newEncryptionKey, newSalt, newKdfVersion);
    const priorKdfVersion = this.kdfVersion;
    const priorSalt = Buffer.from(this.salt);
    const priorKey = Buffer.from(this.key);
    let rekeyedCount = plaintextRows.length;

    let oldBackupPath: string | undefined;
    if (backupPath) {
      mkdirSync(dirname(backupPath), { recursive: true });
      try {
        if (existsSync(backupPath)) {
          oldBackupPath = `${backupPath}.old.${Date.now()}`;
          renameSync(backupPath, oldBackupPath);
        }
      } catch {
        /* proceed */
      }
    }

    const rekey = createTransaction(
      this.liveDb,
      () => {
        if (backupPath) {
          const backupDb = new DatabaseSync(backupPath);
          try {
            backupDb.exec(`
              CREATE TABLE vault_meta (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL
              )
            `);
            backupDb.exec(`
              CREATE TABLE credentials (
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
            backupDb.exec(`CREATE INDEX idx_credentials_service ON credentials(service)`);
            const metaRows = this.liveDb.prepare("SELECT key, value FROM vault_meta").all() as Array<{
              key: string;
              value: Uint8Array | Buffer;
            }>;
            const insertMeta = backupDb.prepare("INSERT INTO vault_meta (key, value) VALUES (?, ?)");
            for (const row of metaRows) insertMeta.run(row.key, row.value);
            const credRows = this.liveDb.prepare("SELECT * FROM credentials").all() as Array<Record<string, unknown>>;
            const insertCred = backupDb.prepare(
              "INSERT INTO credentials (service, type, value, url, notes, created, updated, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            );
            for (const row of credRows) {
              insertCred.run(
                row.service as string,
                row.type as string,
                row.value as string,
                row.url as string | null,
                row.notes as string | null,
                row.created as number,
                row.updated as number,
                row.expires as number | null,
              );
            }
            backupDb.close();
            tryRestrictSqliteDbFileMode(backupPath);
          } catch (err) {
            backupDb.close();
            throw err;
          }
        }

        const updateStmt = this.liveDb.prepare("UPDATE credentials SET value = ? WHERE service = ? AND type = ?");
        for (const row of plaintextRows) {
          const encrypted = encryptValue(row.value, newKey);
          updateStmt.run(encrypted as unknown as Uint8Array, row.service, row.type);
        }
        // Backup above intentionally does not snapshot credential_revisions (see encryptVaultSafe).
        this.reencryptAllRevisions(newKey);
        this.liveDb
          .prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('kdf_version', ?)")
          .run(Buffer.from([newKdfVersion]));
        this.liveDb.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('salt', ?)").run(newSalt);
      },
      "IMMEDIATE",
    );

    let rekeySucceeded = false;
    try {
      rekey();
      this.kdfVersion = newKdfVersion;
      this.salt = newSalt;
      this.key = newKey;
      this.password = null;
      this.storesEncryptedValues = true;

      let verified: boolean | undefined;
      if (verify) {
        const entries = this.listAll();
        if (entries.length !== rekeyedCount) {
          throw new Error(`Verification failed: only ${entries.length} of ${rekeyedCount} entries could be decrypted`);
        }
        for (const row of plaintextRows) {
          const verifiedEntry = this.get(row.service, row.type);
          if (!verifiedEntry || verifiedEntry.value !== row.value) {
            throw new Error(`Verification failed: credential ${row.service}/${row.type} mismatch after rekey`);
          }
        }
        verified = true;
      }

      rekeySucceeded = true;

      if (oldBackupPath) {
        try {
          unlinkSync(oldBackupPath);
        } catch {
          /* best effort */
        }
      }

      return {
        rekeyed: rekeyedCount,
        kdfVersion: this.kdfVersion,
        ...(backupPath !== undefined ? { backupPath } : {}),
        ...(verified !== undefined ? { verified } : {}),
      };
    } catch (err) {
      if (!rekeySucceeded && backupPath && existsSync(backupPath)) {
        try {
          this.restoreVaultFileFromBackup(backupPath, {
            kdfVersion: priorKdfVersion,
            salt: priorSalt,
            key: priorKey,
          });
        } catch (restoreErr) {
          capturePluginError(restoreErr as Error, {
            subsystem: "credentials",
            operation: "rekeyVaultSafe:restore-from-backup",
          });
        }
      }
      if (oldBackupPath && backupPath && !rekeySucceeded) {
        try {
          if (existsSync(backupPath)) unlinkSync(backupPath);
          renameSync(oldBackupPath, backupPath);
        } catch {
          /* preserve .old backup */
        }
      }
      throw err;
    }
  }

  private restoreVaultFileFromBackup(
    backupPath: string,
    prior: { kdfVersion: number; salt: Buffer; key: Buffer },
  ): void {
    this.db.close();
    this._dbOpen = false;
    copyFileSync(backupPath, this.dbPath);
    tryRestrictSqliteDbFileMode(this.dbPath);
    this.db.open();
    this._dbOpen = true;
    this.applyPragmas();
    this.kdfVersion = prior.kdfVersion;
    this.salt = prior.salt;
    this.key = prior.key;
    this.password = null;
    this.storesEncryptedValues = prior.kdfVersion !== CRED_KDF_PLAINTEXT;
  }

  /**
   * If another process's `migrateLegacyVault()` already moved the on-disk vault from v1 to v2
   * since this instance last checked, adopt its new salt/key before encrypting anything with
   * our stale in-memory v1 key. Without this, a store() racing a concurrent migration writes a
   * value encrypted with the old key while `vault_meta.kdf_version` already says v2, permanently
   * breaking decryption for that credential (every future read derives the v2 key).
   */
  private maybeAdoptExternalVaultMigration(): void {
    if (this.kdfVersion !== 1 || !this.password) return;
    const versionRow = this.liveDb.prepare("SELECT value FROM vault_meta WHERE key = 'kdf_version'").get() as
      | { value: Uint8Array | Buffer }
      | undefined;
    if (!versionRow || toBuffer(versionRow.value)[0] !== CRED_KDF_VERSION) return;
    const saltRow = this.liveDb.prepare("SELECT value FROM vault_meta WHERE key = 'salt'").get() as
      | { value: Uint8Array | Buffer }
      | undefined;
    if (!saltRow) return;
    const newSalt = toBuffer(saltRow.value);
    this.salt = newSalt;
    this.key = deriveKeyV2(this.password, newSalt);
    this.kdfVersion = CRED_KDF_VERSION;
    this.password = null;
  }

  /**
   * Insert or update a credential. On conflict (service, type), `updated` and value fields refresh;
   * `created` is preserved from the original row — intentional for "same key, rotated secret" flows (#894).
   *
   * When a row already exists for (service, type) and `opts.revisionsEnabled` is not `false` (issue
   * #2104), the value being overwritten is preserved as a historical revision — copying the raw
   * ciphertext directly (no decrypt/re-encrypt round-trip needed) before the upsert clobbers it.
   */
  store(
    entry: {
      service: string;
      type: CredentialType;
      value: string;
      url?: string;
      notes?: string;
      expires?: number | null;
    },
    opts: { revisionsEnabled?: boolean; revisionTtlDays?: number; replacedBy?: string | null } = {},
  ): CredentialEntry {
    assertValidCredentialType(entry.type);
    this.maybeAdoptExternalVaultMigration();
    const now = Math.floor(Date.now() / 1000);
    if (opts.revisionsEnabled !== false) {
      this.snapshotCurrentAsRevision(entry.service, entry.type, now, opts.revisionTtlDays, opts.replacedBy ?? null);
    }
    const stored = this.storesEncryptedValues ? encryptValue(entry.value, this.key) : Buffer.from(entry.value, "utf8");
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

  /** Copy the current (service, type) row's ciphertext into `credential_revisions`, if one exists. */
  private snapshotCurrentAsRevision(
    service: string,
    type: CredentialType,
    now: number,
    ttlDays: number | undefined,
    replacedBy: string | null,
  ): void {
    const existing = this.liveDb
      .prepare("SELECT value, url, notes, created, expires FROM credentials WHERE service = ? AND type = ?")
      .get(service, type) as
      | { value: Uint8Array | Buffer; url: string | null; notes: string | null; created: number; expires: number | null }
      | undefined;
    if (!existing) return;
    const ttl = ttlDays ?? DEFAULT_REVISION_TTL_DAYS;
    const expiresAt = now + ttl * SECONDS_PER_DAY;
    this.liveDb
      .prepare(
        `INSERT INTO credential_revisions
           (id, service, type, value, url, notes, created, cred_expires, replaced_at, expires_at, pinned_at, replaced_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        randomUUID(),
        service,
        type,
        existing.value,
        existing.url,
        existing.notes,
        existing.created,
        existing.expires,
        now,
        expiresAt,
        replacedBy,
      );
  }

  /** Delete expired, unpinned revisions (lazy sweep — called before any revision read). */
  private pruneExpiredRevisions(service: string, type?: CredentialType): void {
    const now = Math.floor(Date.now() / 1000);
    if (type) {
      this.liveDb
        .prepare(
          "DELETE FROM credential_revisions WHERE service = ? AND type = ? AND pinned_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?",
        )
        .run(service, type, now);
    } else {
      this.liveDb
        .prepare(
          "DELETE FROM credential_revisions WHERE service = ? AND pinned_at IS NULL AND expires_at IS NOT NULL AND expires_at < ?",
        )
        .run(service, now);
    }
  }

  private rowToRevisionMeta(row: Record<string, unknown>): CredentialRevisionMeta {
    return {
      id: row.id as string,
      service: row.service as string,
      type: row.type as CredentialType,
      url: (row.url as string) ?? null,
      notes: (row.notes as string) ?? null,
      created: row.created as number,
      credExpires: (row.cred_expires as number) ?? null,
      replacedAt: row.replaced_at as number,
      expiresAt: (row.expires_at as number) ?? null,
      pinnedAt: (row.pinned_at as number) ?? null,
      replacedBy: (row.replaced_by as string) ?? null,
    };
  }

  private recordRevisionAudit(
    action: CredentialRevisionAuditAction,
    service: string,
    type: CredentialType,
    revisionId: string,
    actor: string | null,
  ): void {
    try {
      this.liveDb
        .prepare(
          "INSERT INTO credential_revision_audit (id, ts, service, type, revision_id, action, actor) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), Math.floor(Date.now() / 1000), service, type, revisionId, action, actor);
    } catch (err) {
      capturePluginError(err instanceof Error ? err : new Error(String(err)), {
        subsystem: "credentials",
        operation: "record-revision-audit",
        severity: "warning",
      });
    }
  }

  /** List historical revisions for a (service, type) — metadata only, values are never included. */
  listRevisions(service: string, type: CredentialType): CredentialRevisionMeta[] {
    this.pruneExpiredRevisions(service, type);
    const rows = this.liveDb
      .prepare(
        "SELECT * FROM credential_revisions WHERE service = ? AND type = ? ORDER BY replaced_at DESC",
      )
      .all(service, type) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToRevisionMeta(row));
  }

  /**
   * Retrieve one revision's decrypted value intentionally (never returned from a list call).
   * Unless `refreshAccess` is `false`, accessing a revision extends its retention TTL from now.
   */
  getRevision(
    service: string,
    type: CredentialType,
    revisionId: string,
    opts: { refreshAccess?: boolean; revisionTtlDays?: number; actor?: string | null } = {},
  ): CredentialRevisionEntry | null {
    this.pruneExpiredRevisions(service, type);
    const row = this.liveDb
      .prepare("SELECT * FROM credential_revisions WHERE id = ? AND service = ? AND type = ?")
      .get(revisionId, service, type) as Record<string, unknown> | undefined;
    if (!row) return null;
    const value = this.decryptStoredValue(row.value as Uint8Array | Buffer);
    const meta = this.rowToRevisionMeta(row);
    const refreshAccess = opts.refreshAccess !== false;
    if (refreshAccess && meta.pinnedAt == null) {
      const now = Math.floor(Date.now() / 1000);
      const ttl = opts.revisionTtlDays ?? DEFAULT_REVISION_TTL_DAYS;
      meta.expiresAt = now + ttl * SECONDS_PER_DAY;
      this.liveDb
        .prepare("UPDATE credential_revisions SET expires_at = ? WHERE id = ?")
        .run(meta.expiresAt, revisionId);
    }
    this.recordRevisionAudit("retrieve", service, type, revisionId, opts.actor ?? null);
    return { ...meta, value };
  }

  /**
   * Restore/promote a historical revision back to current. The value it replaces (if any) is
   * itself snapshotted as a new revision first, so a restore never discards data outright.
   */
  restoreRevision(
    service: string,
    type: CredentialType,
    revisionId: string,
    opts: { revisionsEnabled?: boolean; revisionTtlDays?: number; actor?: string | null } = {},
  ): CredentialEntry | null {
    this.pruneExpiredRevisions(service, type);
    const row = this.liveDb
      .prepare("SELECT * FROM credential_revisions WHERE id = ? AND service = ? AND type = ?")
      .get(revisionId, service, type) as
      | { value: Uint8Array | Buffer; url: string | null; notes: string | null; created: number; cred_expires: number | null }
      | undefined;
    if (!row) return null;
    const now = Math.floor(Date.now() / 1000);
    if (opts.revisionsEnabled !== false) {
      this.snapshotCurrentAsRevision(service, type, now, opts.revisionTtlDays, opts.actor ?? null);
    }
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
      .run(service, type, row.value, row.url, row.notes, row.created, now, row.cred_expires);
    this.recordRevisionAudit("restore", service, type, revisionId, opts.actor ?? null);
    return this.get(service, type);
  }

  /** Hard-delete a single revision. */
  purgeRevision(
    service: string,
    type: CredentialType,
    revisionId: string,
    opts: { actor?: string | null } = {},
  ): boolean {
    const r = this.liveDb
      .prepare("DELETE FROM credential_revisions WHERE id = ? AND service = ? AND type = ?")
      .run(revisionId, service, type);
    const deleted = r.changes > 0;
    if (deleted) this.recordRevisionAudit("purge", service, type, revisionId, opts.actor ?? null);
    return deleted;
  }

  /** Hard-delete every revision for a (service, type) — e.g. an operator wants a value gone for good. */
  purgeAllRevisions(service: string, type: CredentialType, opts: { actor?: string | null } = {}): number {
    const r = this.liveDb.prepare("DELETE FROM credential_revisions WHERE service = ? AND type = ?").run(service, type);
    const removed = Number(r.changes);
    if (removed > 0) this.recordRevisionAudit("purge_all", service, type, "*", opts.actor ?? null);
    return removed;
  }

  /** Pin (never expire) or unpin a revision. */
  pinRevision(
    service: string,
    type: CredentialType,
    revisionId: string,
    pinned: boolean,
    opts: { actor?: string | null } = {},
  ): boolean {
    const now = Math.floor(Date.now() / 1000);
    const r = this.liveDb
      .prepare("UPDATE credential_revisions SET pinned_at = ? WHERE id = ? AND service = ? AND type = ?")
      .run(pinned ? now : null, revisionId, service, type);
    const changed = r.changes > 0;
    if (changed) this.recordRevisionAudit(pinned ? "pin" : "unpin", service, type, revisionId, opts.actor ?? null);
    return changed;
  }

  /** Audit trail for revision retrieval/restoration/purge/pin — self-contained (works even when the
   * cross-agent AuditStore is unavailable, e.g. the credentials-only CLI fast path). */
  listRevisionAuditEvents(service?: string, type?: CredentialType, limit = 50): CredentialRevisionAuditEvent[] {
    let rows: Array<Record<string, unknown>>;
    if (service && type) {
      rows = this.liveDb
        .prepare("SELECT * FROM credential_revision_audit WHERE service = ? AND type = ? ORDER BY ts DESC LIMIT ?")
        .all(service, type, limit) as Array<Record<string, unknown>>;
    } else if (service) {
      rows = this.liveDb
        .prepare("SELECT * FROM credential_revision_audit WHERE service = ? ORDER BY ts DESC LIMIT ?")
        .all(service, limit) as Array<Record<string, unknown>>;
    } else {
      rows = this.liveDb
        .prepare("SELECT * FROM credential_revision_audit ORDER BY ts DESC LIMIT ?")
        .all(limit) as Array<Record<string, unknown>>;
    }
    return rows.map((row) => ({
      id: row.id as string,
      ts: row.ts as number,
      service: row.service as string,
      type: row.type as CredentialType,
      revisionId: row.revision_id as string,
      action: row.action as CredentialRevisionAuditAction,
      actor: (row.actor as string) ?? null,
    }));
  }

  get(service: string, type?: CredentialType): CredentialEntry | null {
    this.maybeMigrateLegacyCredentialTypes();
    this.maybeAdoptExternalVaultMigration();
    const row = type
      ? (this.liveDb.prepare("SELECT * FROM credentials WHERE service = ? AND type = ?").get(service, type) as
          | Record<string, unknown>
          | undefined)
      : (this.liveDb
          .prepare("SELECT * FROM credentials WHERE service = ? ORDER BY updated DESC LIMIT 1")
          .get(service) as Record<string, unknown> | undefined);
    if (!row) return null;
    const buf = toBuffer(row.value as Uint8Array | Buffer);
    const value = this.storesEncryptedValues ? decryptValue(buf, this.key) : buf.toString("utf8");

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

    const out = {
      service: row.service as string,
      type: row.type as string as CredentialType,
      value,
      url: (row.url as string) ?? null,
      notes: (row.notes as string) ?? null,
      created: row.created as number,
      updated: row.updated as number,
      expires: (row.expires as number) ?? null,
    };
    assertValidCredentialRow(out);
    return out;
  }

  /** Migrate legacy SHA-256 vault to scrypt. Called after first successful decryption. */
  private migrateLegacyVault(): void {
    if (!this.password) {
      throw new Error("Migration requires password");
    }

    // Generate new salt and derive new key with scrypt (avoid deriveKey dispatcher so static analysis sees only scrypt here)
    const migrationSalt = randomBytes(32);
    const newKey = deriveKeyV2(this.password, migrationSalt);

    // Wrap read + mutations in one transaction (IMMEDIATE) so new rows cannot appear after the snapshot.
    const migrate = createTransaction(
      this.liveDb,
      () => {
        const rows = this.liveDb.prepare("SELECT * FROM credentials").all() as Array<Record<string, unknown>>;
        const updateStmt = this.liveDb.prepare("UPDATE credentials SET value = ? WHERE service = ? AND type = ?");
        for (const row of rows) {
          const oldBuf = toBuffer(row.value as Uint8Array | Buffer);
          const plaintext = decryptValue(oldBuf, this.key); // Decrypt with old key
          const newEncrypted = encryptValue(plaintext, newKey); // Encrypt with new key
          updateStmt.run(newEncrypted as unknown as Uint8Array, row.service as string, row.type as string);
        }

        this.liveDb
          .prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('kdf_version', ?)")
          .run(Buffer.from([CRED_KDF_VERSION]));
        this.liveDb.prepare("INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('salt', ?)").run(migrationSalt);
      },
      "IMMEDIATE",
    );

    migrate();

    this.salt = migrationSalt;

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
    assertValidCredentialType(entry.type);
    this.maybeAdoptExternalVaultMigration();
    // Check for a legacy cross-variant (underscore ↔ hyphen) before inserting so we
    // don't create a parallel entry alongside an existing differently-named one.
    const legacyVariant = entry.service.includes("_")
      ? entry.service.replace(/_/g, "-")
      : entry.service.replace(/-/g, "_");
    if (legacyVariant !== entry.service && this.exists(legacyVariant, entry.type)) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const stored = this.storesEncryptedValues ? encryptValue(entry.value, this.key) : Buffer.from(entry.value, "utf8");
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
    return this.listAllWithSkipped().entries;
  }

  /**
   * Like {@link listAll}, but also reports how many rows failed to decrypt/validate and were
   * skipped, so callers can distinguish "vault is genuinely empty" from "the configured
   * encryption key can't decrypt these rows" instead of both cases silently reporting as empty.
   */
  listAllWithSkipped(): { entries: CredentialEntry[]; skippedCount: number } {
    this.maybeMigrateLegacyCredentialTypes();
    this.maybeAdoptExternalVaultMigration();
    const rows = this.liveDb.prepare("SELECT * FROM credentials ORDER BY service, type").all() as Array<
      Record<string, unknown>
    >;
    const out: CredentialEntry[] = [];
    let skippedCount = 0;
    for (const row of rows) {
      try {
        const buf = toBuffer(row.value as Uint8Array | Buffer);
        const value = this.storesEncryptedValues ? decryptValue(buf, this.key) : buf.toString("utf8");
        const entry: CredentialEntry = {
          service: row.service as string,
          type: row.type as string as CredentialType,
          value,
          url: (row.url as string) ?? null,
          notes: (row.notes as string) ?? null,
          created: row.created as number,
          updated: row.updated as number,
          expires: (row.expires as number) ?? null,
        };
        assertValidCredentialRow(entry);
        out.push(entry);
      } catch (err) {
        skippedCount++;
        capturePluginError(err instanceof Error ? err : new Error(String(err)), {
          subsystem: "credentials",
          operation: "list-all-skip-row",
          severity: "warning",
        });
      }
    }
    return { entries: out, skippedCount };
  }

  list(): Array<{ service: string; type: string; url: string | null; expires: number | null }> {
    this.maybeMigrateLegacyCredentialTypes();
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
