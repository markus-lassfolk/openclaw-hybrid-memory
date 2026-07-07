import { existsSync } from "node:fs";
import type { CredentialType } from "../config.js";
import { resolveCredentialsEncryptionKeyCandidates } from "../config/parsers/core.js";
import { CredentialsDB } from "../backends/credentials-db.js";
import { pluginLogger } from "../utils/logger.js";

export {
  resolveCredentialsEncryptionKeyCandidates,
  resolveCredentialsEncryptionKeyForConfig,
} from "../config/parsers/core.js";
export { getCredentialsEncryptionKeyRaw } from "./credentials-path.js";

const legacyFileRefWarnedPaths = new Set<string>();

/** Returns true when the key can open the vault (empty vaults always pass). */
export function probeCredentialsVaultKey(dbPath: string, encryptionKey: string): boolean {
  if (!encryptionKey || encryptionKey.length < 16) return false;
  let db: CredentialsDB | null = null;
  try {
    db = new CredentialsDB(dbPath, encryptionKey);
    const items = db.list();
    if (items.length === 0) return true;
    db.get(items[0].service, items[0].type as CredentialType);
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function warnLegacyFileRefLiteralKey(dbPath: string, raw: string): void {
  if (legacyFileRefWarnedPaths.has(dbPath)) return;
  legacyFileRefWarnedPaths.add(dbPath);
  pluginLogger.warn(
    "memory-hybrid: credentials vault opened using legacy literal file: SecretRef key material " +
      `(configured as "${raw.slice(0, 48)}${raw.length > 48 ? "…" : ""}"). ` +
      "New installs should use file contents via file:/path/to/key. " +
      "To migrate from legacy literal file: key material, store the desired passphrase in that file, " +
      "set credentials.encryptionKey to the file: ref, then run " +
      "`openclaw hybrid-mem credentials rekey-vault --backup --verify --yes`.",
  );
}

/**
 * Resolve vault key material for CredentialsDB construction.
 * When the vault exists and `file:` is configured, probes decrypt with file contents first, then legacy literal ref.
 */
export function resolveCredentialsVaultKeyMaterial(raw: string, dbPath: string): string {
  const trimmed = raw.trim();
  let candidates = resolveCredentialsEncryptionKeyCandidates(trimmed).filter((c) => c.length >= 16);
  // Legacy vaults may have been encrypted with the literal `file:/path` string when the key file was missing.
  if (trimmed.startsWith("file:") && existsSync(dbPath) && trimmed.length >= 16 && !candidates.includes(trimmed)) {
    candidates = [...candidates, trimmed];
  }
  if (candidates.length === 0) return "";

  if (!existsSync(dbPath)) {
    if (trimmed.startsWith("file:")) {
      // New vault: require resolved file contents; never bootstrap with literal `file:/path`.
      const fromFile = candidates.find((c) => c !== trimmed);
      return fromFile ?? "";
    }
    return candidates[0];
  }

  for (const candidate of candidates) {
    if (probeCredentialsVaultKey(dbPath, candidate)) {
      // Warn exactly when the vault was opened using the literal `file:/path` ref string itself
      // (the legacy passphrase behavior), not by array position — when the key file is missing,
      // the literal ref is the *only* candidate (index 0), so an index-based check never fires
      // for the most common trigger case.
      if (trimmed.startsWith("file:") && candidate === trimmed) {
        warnLegacyFileRefLiteralKey(dbPath, trimmed);
      }
      return candidate;
    }
  }

  return "";
}

/** @internal Test hook */
export function _resetCredentialsEncryptionKeyWarningsForTests(): void {
  legacyFileRefWarnedPaths.clear();
}
