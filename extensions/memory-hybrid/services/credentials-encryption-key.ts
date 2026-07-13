import { existsSync } from "node:fs";
import { CredentialsDB } from "../backends/credentials-db.js";
import { resolveCredentialsEncryptionKeyCandidates } from "../config/parsers/core.js";
import type { CredentialType } from "../config.js";
import { pluginLogger } from "../utils/logger.js";
import { resetWarnOnceForTestsByPrefix, warnOnce } from "../utils/warn-once.js";

export {
  resolveCredentialsEncryptionKeyCandidates,
  resolveCredentialsEncryptionKeyForConfig,
} from "../config/parsers/core.js";
export { getCredentialsEncryptionKeyRaw } from "./credentials-path.js";

const LEGACY_FILE_REF_WARN_KEY_PREFIX = "credentials-vault-legacy-key:";

/** Subcommands where surfacing the legacy-key migration warning is expected: vault/credential
 *  management itself, and the two general health-check commands. */
const VAULT_WARNING_SUBCOMMANDS = new Set(["credentials", "doctor", "verify"]);

/**
 * True when this invocation is a command where the legacy-key migration warning is expected
 * (credential/vault-focused commands, or an explicit health check), or `--verbose`/`-v` was
 * passed. Every `hybrid-mem` CLI invocation is its own process, so `warnOnce`'s per-process dedup
 * cannot suppress this across invocations (#2099) — command scoping is the actual fix. Scans raw
 * argv (not Commander opts) because this runs deep inside bootstrap, before any command handler
 * has parsed its options.
 */
export function shouldSurfaceLegacyKeyWarning(argv: readonly string[] = process.argv): boolean {
  const hybridIdx = argv.indexOf("hybrid-mem");
  if (hybridIdx === -1) return true; // Can't tell from argv — fail open rather than hide a real warning.
  let sawSubcommand = false;
  for (let i = hybridIdx + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--verbose" || arg === "-v") return true;
    if (arg.startsWith("-")) continue;
    if (!sawSubcommand) {
      sawSubcommand = true;
      if (VAULT_WARNING_SUBCOMMANDS.has(arg)) return true;
    }
  }
  return false;
}

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
  if (!shouldSurfaceLegacyKeyWarning()) return;
  warnOnce(`${LEGACY_FILE_REF_WARN_KEY_PREFIX}${dbPath}`, () => {
    pluginLogger.warn(
      "memory-hybrid: credentials vault opened using legacy literal file: SecretRef key material " +
        `(configured as "${raw.slice(0, 48)}${raw.length > 48 ? "…" : ""}"). ` +
        "New installs should use file contents via file:/path/to/key. " +
        "To migrate from legacy literal file: key material, store the desired passphrase in that file, " +
        "set credentials.encryptionKey to the file: ref, then run " +
        "`openclaw hybrid-mem credentials rekey-vault --backup --verify --yes`.",
    );
  });
}

export type CredentialsVaultKeyResolution = {
  keyMaterial: string;
  /** True when the vault was opened using the literal `file:/path` ref string as the passphrase
   * itself, rather than resolved file contents (#2099) — the legacy behavior new installs should
   * not rely on. */
  legacyLiteralFileKey: boolean;
};

/**
 * Resolve vault key material for CredentialsDB construction, with metadata about how it was
 * resolved (#2099). When the vault exists and `file:` is configured, probes decrypt with file
 * contents first, then legacy literal ref.
 */
export function resolveCredentialsVaultKeyMaterialDetailed(raw: string, dbPath: string): CredentialsVaultKeyResolution {
  const trimmed = raw.trim();
  let candidates = resolveCredentialsEncryptionKeyCandidates(trimmed).filter((c) => c.length >= 16);
  // Legacy vaults may have been encrypted with the literal `file:/path` string when the key file was missing.
  if (trimmed.startsWith("file:") && existsSync(dbPath) && trimmed.length >= 16 && !candidates.includes(trimmed)) {
    candidates = [...candidates, trimmed];
  }
  if (candidates.length === 0) return { keyMaterial: "", legacyLiteralFileKey: false };

  if (!existsSync(dbPath)) {
    if (trimmed.startsWith("file:")) {
      // New vault: require resolved file contents; never bootstrap with literal `file:/path`.
      const fromFile = candidates.find((c) => c !== trimmed);
      return { keyMaterial: fromFile ?? "", legacyLiteralFileKey: false };
    }
    return { keyMaterial: candidates[0], legacyLiteralFileKey: false };
  }

  for (const candidate of candidates) {
    if (probeCredentialsVaultKey(dbPath, candidate)) {
      // Warn exactly when the vault was opened using the literal `file:/path` ref string itself
      // (the legacy passphrase behavior), not by array position — when the key file is missing,
      // the literal ref is the *only* candidate (index 0), so an index-based check never fires
      // for the most common trigger case.
      const legacyLiteralFileKey = trimmed.startsWith("file:") && candidate === trimmed;
      if (legacyLiteralFileKey) {
        warnLegacyFileRefLiteralKey(dbPath, trimmed);
      }
      return { keyMaterial: candidate, legacyLiteralFileKey };
    }
  }

  return { keyMaterial: "", legacyLiteralFileKey: false };
}

/**
 * Resolve vault key material for CredentialsDB construction.
 * When the vault exists and `file:` is configured, probes decrypt with file contents first, then legacy literal ref.
 */
export function resolveCredentialsVaultKeyMaterial(raw: string, dbPath: string): string {
  return resolveCredentialsVaultKeyMaterialDetailed(raw, dbPath).keyMaterial;
}

/** @internal Test hook */
export function _resetCredentialsEncryptionKeyWarningsForTests(): void {
  // Scoped to this module's own key prefix (not the whole shared warn-once registry) so it can't
  // clear an unrelated module's suppressed-warning state if another feature adopts warnOnce().
  resetWarnOnceForTestsByPrefix(LEGACY_FILE_REF_WARN_KEY_PREFIX);
}
