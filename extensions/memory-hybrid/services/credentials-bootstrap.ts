import { CredentialsDB } from "../backends/credentials-db.js";
import type { HybridMemoryConfig } from "../config.js";
import { getCredentialsEncryptionKeyRaw } from "./credentials-path.js";
import { resolveCredentialsVaultKeyMaterialDetailed } from "./credentials-encryption-key.js";
import { resolveCredentialsDbPath } from "./credentials-path.js";

export { resolveCredentialsDbPath } from "./credentials-path.js";

/** Construct CredentialsDB when the vault feature is enabled; otherwise null. */
export function createCredentialsDbForConfig(
  cfg: HybridMemoryConfig,
  resolvedSqlitePath: string,
): CredentialsDB | null {
  if (!cfg.credentials.enabled) return null;
  const dbPath = resolveCredentialsDbPath(resolvedSqlitePath);
  const rawKey = getCredentialsEncryptionKeyRaw(cfg);
  const { keyMaterial, legacyLiteralFileKey } = resolveCredentialsVaultKeyMaterialDetailed(rawKey, dbPath);
  return new CredentialsDB(dbPath, keyMaterial, legacyLiteralFileKey);
}
