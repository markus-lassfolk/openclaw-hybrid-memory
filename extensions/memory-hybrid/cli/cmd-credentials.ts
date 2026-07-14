/**
 * Credentials CLI Handlers
 *
 * Implements the vault-related CLI commands:
 *   - migrate-to-vault   — migrate plain-text credential facts into the encrypted vault
 *   - credentials audit  — flag suspicious or duplicate vault entries
 *   - credentials list   — list vault metadata without decryption
 *   - credentials get    — retrieve a single vault entry by service
 *   - credentials prune  — remove flagged entries (dry-run by default)
 *   - credentials vault-status — show vault encryption status
 */

import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";

import type { CredentialType } from "../config.js";
import { CREDENTIAL_REDACTION_MIGRATION_FLAG, migrateCredentialsToVault } from "../services/credential-migration.js";
import {
  auditCredentialType,
  auditCredentialValue,
  auditServiceName,
  normalizeServiceForDedup,
} from "../services/credential-validation.js";
import { getCredentialsEncryptionKeyRaw } from "../services/credentials-path.js";
import { capturePluginError } from "../services/error-reporter.js";
import type { HandlerContext } from "./handlers.js";
import type {
  CredentialsAuditResult,
  CredentialsPruneResult,
  EncryptVaultResult,
  MigrateToVaultResult,
  RekeyVaultResult,
  VaultStatusResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// migrate-to-vault
// ---------------------------------------------------------------------------

/**
 * Migrate plain-text credential facts into the encrypted vault.
 * Returns null when the credentials vault is disabled.
 */
export async function runMigrateToVaultForCli(ctx: HandlerContext): Promise<MigrateToVaultResult | null> {
  const { factsDb, vectorDb, embeddings, credentialsDb, aliasDb, resolvedSqlitePath } = ctx;
  if (!credentialsDb) return null;
  const migrationFlagPath = join(dirname(resolvedSqlitePath), CREDENTIAL_REDACTION_MIGRATION_FLAG);
  try {
    return await migrateCredentialsToVault({
      factsDb,
      vectorDb,
      embeddings,
      credentialsDb,
      aliasDb,
      migrationFlagPath,
      markDone: true,
    });
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runMigrateToVaultForCli" });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// encrypt-vault (plaintext -> encrypted at rest)
// ---------------------------------------------------------------------------

/**
 * Encrypt an existing plaintext vault at rest (kdf_version=0).
 * Safe by default: returns a dry-run unless `yes` is true.
 * Pass `backup: true` to auto-generate a plaintext backup path, or `backupPath` for a custom path.
 * Pass `verify: true` to confirm every entry is readable after encryption.
 */
export function runEncryptVaultForCli(
  ctx: HandlerContext,
  opts: { yes?: boolean; backup?: boolean; backupPath?: string; verify?: boolean },
): EncryptVaultResult {
  const { credentialsDb, resolvedSqlitePath, cfg } = ctx;
  const vaultPath = join(dirname(resolvedSqlitePath), "credentials.db");
  if (!credentialsDb) {
    return { ok: false, vaultPath, error: "Credentials vault is not available (credentialsDb is null)." };
  }

  const st = credentialsDb.getVaultStatus();
  if (st.encryptedAtRest) {
    return { ok: true, dryRun: true, vaultPath, status: { kdfVersion: st.kdfVersion, encryptedAtRest: true } };
  }

  if (!st.configuredKeyPresent) {
    return {
      ok: false,
      vaultPath,
      error:
        "Vault is plaintext and no encryption key is configured. Set credentials.encryptionKey (16+ chars) or OPENCLAW_CRED_KEY, then re-run.",
    };
  }

  if (!opts.yes) {
    return { ok: true, dryRun: true, vaultPath, status: { kdfVersion: st.kdfVersion, encryptedAtRest: false } };
  }

  // Resolve backup path: explicit path > auto-generated (when --backup is set) > none
  let resolvedBackupPath: string | undefined = opts.backupPath;
  if (!resolvedBackupPath && opts.backup) {
    resolvedBackupPath = `${vaultPath}.bak.${Date.now()}-${process.pid}`;
  }

  try {
    const res = credentialsDb.encryptVaultSafe(cfg.credentials.encryptionKey ?? "", {
      backupPath: resolvedBackupPath,
      verify: opts.verify,
    });
    const after = credentialsDb.getVaultStatus();
    return {
      ok: true,
      dryRun: false,
      vaultPath,
      migrated: res.migrated,
      ...(res.backupPath !== undefined ? { backupPath: res.backupPath } : {}),
      ...(res.verified !== undefined ? { verified: res.verified } : {}),
      status: { kdfVersion: after.kdfVersion, encryptedAtRest: after.encryptedAtRest },
    };
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runEncryptVaultForCli" });
    return { ok: false, vaultPath, error: String(err) };
  }
}

/**
 * Non-mutating migration-readiness preflight (#2099): can a backup actually be written next to
 * the vault, and — when the configured key is a `file:` ref — does that file exist and is it
 * readable? Neither check writes anything; `accessSync` only probes permissions.
 */
function checkVaultMigrationPreflight(
  vaultPath: string,
  rawKeyRef: string,
): { backupPathWritable: boolean; targetKeyFileReadable: boolean | null } {
  let backupPathWritable = false;
  try {
    accessSync(dirname(vaultPath), constants.W_OK);
    backupPathWritable = true;
  } catch {
    backupPathWritable = false;
  }

  let targetKeyFileReadable: boolean | null = null;
  const trimmedRef = rawKeyRef.trim();
  if (trimmedRef.startsWith("file:")) {
    const filePath = trimmedRef.slice(5).trim();
    try {
      accessSync(filePath, constants.R_OK);
      targetKeyFileReadable = true;
    } catch {
      targetKeyFileReadable = false;
    }
  }

  return { backupPathWritable, targetKeyFileReadable };
}

/**
 * Re-encrypt an already-encrypted vault with the configured encryption key material.
 * Use after fixing a legacy literal `file:/path` SecretRef to file-content semantics.
 */
export function runRekeyVaultForCli(
  ctx: HandlerContext,
  opts: { yes?: boolean; backup?: boolean; backupPath?: string; verify?: boolean },
): RekeyVaultResult {
  const { credentialsDb, resolvedSqlitePath, cfg } = ctx;
  const vaultPath = join(dirname(resolvedSqlitePath), "credentials.db");
  if (!credentialsDb) {
    return { ok: false, vaultPath, error: "Credentials vault is not available (credentialsDb is null)." };
  }

  const st = credentialsDb.getVaultStatus();
  if (!st.encryptedAtRest) {
    return {
      ok: false,
      vaultPath,
      error: "Vault is plaintext. Run `openclaw hybrid-mem credentials encrypt-vault --backup --verify --yes` first.",
    };
  }

  const newKey = cfg.credentials.encryptionKey ?? "";
  if (newKey.length < 16) {
    return {
      ok: false,
      vaultPath,
      error:
        "Configured encryption key is missing or too short. Set credentials.encryptionKey (16+ chars) or OPENCLAW_CRED_KEY to the desired new key material.",
    };
  }

  if (!opts.yes) {
    const preflight = checkVaultMigrationPreflight(vaultPath, getCredentialsEncryptionKeyRaw(cfg));
    return {
      ok: true,
      dryRun: true,
      vaultPath,
      status: { kdfVersion: st.kdfVersion, encryptedAtRest: true },
      preflight,
    };
  }

  let resolvedBackupPath: string | undefined = opts.backupPath;
  if (!resolvedBackupPath && opts.backup) {
    resolvedBackupPath = `${vaultPath}.rekey.bak.${Date.now()}-${process.pid}`;
  }

  try {
    const res = credentialsDb.rekeyVaultSafe(newKey, {
      backupPath: resolvedBackupPath,
      verify: opts.verify,
    });
    const after = credentialsDb.getVaultStatus();
    return {
      ok: true,
      dryRun: false,
      vaultPath,
      rekeyed: res.rekeyed,
      ...(res.backupPath !== undefined ? { backupPath: res.backupPath } : {}),
      ...(res.verified !== undefined ? { verified: res.verified } : {}),
      status: { kdfVersion: after.kdfVersion, encryptedAtRest: after.encryptedAtRest },
    };
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runRekeyVaultForCli" });
    return { ok: false, vaultPath, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// credentials vault-status
// ---------------------------------------------------------------------------

/**
 * Return vault encryption status. Returns null when the credentials vault is disabled.
 */
export function runVaultStatusForCli(ctx: HandlerContext): VaultStatusResult | null {
  const { credentialsDb } = ctx;
  if (!credentialsDb) return null;
  return credentialsDb.getVaultStatus();
}

// ---------------------------------------------------------------------------
// credentials audit
// ---------------------------------------------------------------------------

/**
 * Audit credentials vault: list entries and flag suspicious ones (value/service heuristics).
 */
export function runCredentialsAuditForCli(ctx: HandlerContext): CredentialsAuditResult {
  const { credentialsDb } = ctx;
  const entries: Array<{ service: string; type: string; url: string | null; flags: string[] }> = [];
  if (!credentialsDb) return { entries, total: 0, undecryptable: 0 };
  const { entries: list, skippedCount } = credentialsDb.listAllWithSkipped();
  // Group entries by canonical value and by normalized service name so we can flag
  // older duplicates in each group. Each item carries its `updated` timestamp so we
  // can sort newest-first and keep only group[0] (the newest) un-flagged.
  const valueToEntries = new Map<string, Array<{ service: string; type: string; updated: number }>>();
  const normKeyToEntries = new Map<string, Array<{ service: string; type: string; updated: number }>>();
  for (const row of list) {
    const value = row.value;
    const updated = row.updated;
    const flags = [
      ...auditCredentialType(row.type),
      ...auditCredentialValue(value, row.type),
      ...auditServiceName(row.service),
    ];
    const normKey = `${normalizeServiceForDedup(row.service)}:${row.type}`;
    if (!valueToEntries.has(value)) valueToEntries.set(value, []);
    valueToEntries.get(value)?.push({ service: row.service, type: row.type, updated });
    if (!normKeyToEntries.has(normKey)) normKeyToEntries.set(normKey, []);
    normKeyToEntries.get(normKey)?.push({ service: row.service, type: row.type, updated });
    entries.push({ service: row.service, type: row.type, url: row.url, flags });
  }
  for (const [, group] of valueToEntries) {
    if (group.length > 1) {
      // Sort newest-first so that group[0] is the most recently updated entry.
      // Only the older copies (i >= 1) are flagged, preserving the newest credential.
      const sorted = [...group].sort((a, b) => b.updated - a.updated);
      for (let i = 1; i < sorted.length; i++) {
        const { service, type } = sorted[i];
        const e = entries.find((x) => x.service === service && x.type === type);
        if (e && !e.flags.includes("duplicate_value")) e.flags.push("duplicate_value");
      }
    }
  }
  for (const [, group] of normKeyToEntries) {
    if (group.length > 1) {
      // Sort newest-first; only flag the older normalized-service duplicates (i >= 1).
      const sorted = [...group].sort((a, b) => b.updated - a.updated);
      for (let i = 1; i < sorted.length; i++) {
        const { service, type } = sorted[i];
        const e = entries.find((x) => x.service === service && x.type === type);
        if (e && !e.flags.includes("duplicate_normalized_service")) e.flags.push("duplicate_normalized_service");
      }
    }
  }
  return { entries, total: entries.length, undecryptable: skippedCount };
}

// ---------------------------------------------------------------------------
// credentials list
// ---------------------------------------------------------------------------

/**
 * List credentials metadata (service, type, url) without decryption.
 * Used by the `credentials list` CLI command.
 */
export function runCredentialsListForCli(
  ctx: HandlerContext,
): Array<{ service: string; type: string; url: string | null }> {
  const { credentialsDb } = ctx;
  if (!credentialsDb) return [];
  return credentialsDb.list();
}

// ---------------------------------------------------------------------------
// credentials get
// ---------------------------------------------------------------------------

/**
 * Get a single credential value by service (and optional type). Used by the `credentials get` CLI command.
 * Returns null if vault is disabled or no matching entry exists.
 */
export function runCredentialsGetForCli(
  ctx: HandlerContext,
  opts: { service: string; type?: string },
): { service: string; type: string; value: string; url: string | null; notes: string | null } | null {
  const { credentialsDb } = ctx;
  if (!credentialsDb) return null;
  const type = opts.type as CredentialType | undefined;
  const entry = credentialsDb.get(opts.service.trim(), type);
  if (!entry) return null;
  return {
    service: entry.service,
    type: entry.type,
    value: entry.value,
    url: entry.url ?? null,
    notes: entry.notes ?? null,
  };
}

// ---------------------------------------------------------------------------
// credentials prune
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// credentials revisions (#2104)
// ---------------------------------------------------------------------------

/** CLI-originated revision operations are attributed to this actor in the audit trail. */
const CLI_REVISION_ACTOR = "cli";

/** List historical revisions (metadata only) for a service/type. Returns null when vault is disabled. */
export function runCredentialRevisionListForCli(
  ctx: HandlerContext,
  opts: { service: string; type: CredentialType },
): import("../backends/credentials-db.js").CredentialRevisionMeta[] | null {
  const { credentialsDb } = ctx;
  if (!credentialsDb) return null;
  return credentialsDb.listRevisions(opts.service.trim(), opts.type);
}

/** Retrieve a specific revision's decrypted value intentionally. Returns null when not found/disabled. */
export function runCredentialRevisionGetForCli(
  ctx: HandlerContext,
  opts: { service: string; type: CredentialType; revision: string },
): import("../backends/credentials-db.js").CredentialRevisionEntry | null {
  const { credentialsDb, cfg } = ctx;
  if (!credentialsDb) return null;
  return credentialsDb.getRevision(opts.service.trim(), opts.type, opts.revision.trim(), {
    refreshAccess: cfg.credentials.revisionAccessRefresh !== false,
    revisionTtlDays: cfg.credentials.revisionTtlDays,
    actor: CLI_REVISION_ACTOR,
  });
}

/** Restore/promote a revision back to current. Returns null when not found/disabled. */
export function runCredentialRevisionRestoreForCli(
  ctx: HandlerContext,
  opts: { service: string; type: CredentialType; revision: string },
): import("../backends/credentials-db.js").CredentialEntry | null {
  const { credentialsDb, cfg } = ctx;
  if (!credentialsDb) return null;
  return credentialsDb.restoreRevision(opts.service.trim(), opts.type, opts.revision.trim(), {
    revisionsEnabled: cfg.credentials.revisionsEnabled !== false,
    revisionTtlDays: cfg.credentials.revisionTtlDays,
    actor: CLI_REVISION_ACTOR,
  });
}

/** Hard-delete one revision (or every revision for the service/type when `all` is true). */
export function runCredentialRevisionPurgeForCli(
  ctx: HandlerContext,
  opts: { service: string; type: CredentialType; revision?: string; all?: boolean },
): { purged: number } | null {
  const { credentialsDb } = ctx;
  if (!credentialsDb) return null;
  const service = opts.service.trim();
  if (opts.all) {
    return { purged: credentialsDb.purgeAllRevisions(service, opts.type, { actor: CLI_REVISION_ACTOR }) };
  }
  if (!opts.revision) return { purged: 0 };
  const purged = credentialsDb.purgeRevision(service, opts.type, opts.revision.trim(), { actor: CLI_REVISION_ACTOR });
  return { purged: purged ? 1 : 0 };
}

/** Pin (never expire) or unpin a revision. Returns null when vault is disabled. */
export function runCredentialRevisionPinForCli(
  ctx: HandlerContext,
  opts: { service: string; type: CredentialType; revision: string; pinned: boolean },
): { changed: boolean } | null {
  const { credentialsDb } = ctx;
  if (!credentialsDb) return null;
  const changed = credentialsDb.pinRevision(opts.service.trim(), opts.type, opts.revision.trim(), opts.pinned, {
    actor: CLI_REVISION_ACTOR,
  });
  return { changed };
}

// ---------------------------------------------------------------------------
// credentials prune
// ---------------------------------------------------------------------------

/**
 * Prune credentials vault: remove entries flagged by audit. Default dry-run; use --yes to apply.
 */
export function runCredentialsPruneForCli(
  ctx: HandlerContext,
  opts: { dryRun: boolean; yes?: boolean; onlyFlags?: string[] },
): CredentialsPruneResult {
  const { credentialsDb } = ctx;
  const removed: Array<{ service: string; type: string }> = [];
  const apply = opts.yes === true && !opts.dryRun;
  if (!credentialsDb) return { removed: 0, entries: [], dryRun: !apply, undecryptable: 0 };
  const audit = runCredentialsAuditForCli(ctx);
  const flagsToPrune = opts.onlyFlags && opts.onlyFlags.length > 0 ? new Set(opts.onlyFlags) : null;
  for (const e of audit.entries) {
    if (e.flags.length === 0) continue;
    const match = !flagsToPrune || e.flags.some((f) => flagsToPrune.has(f));
    if (!match) continue;
    if (apply) {
      credentialsDb.delete(e.service, e.type as CredentialType);
      removed.push({ service: e.service, type: e.type });
    } else {
      removed.push({ service: e.service, type: e.type });
    }
  }
  return { removed: removed.length, entries: removed, dryRun: !apply, undecryptable: audit.undecryptable };
}
