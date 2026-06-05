import { dirname, join } from "node:path";
import type { HybridMemoryConfig } from "../config.js";

/** Resolve the credentials vault SQLite path adjacent to the main memory DB. */
export function resolveCredentialsDbPath(resolvedSqlitePath: string): string {
  return join(dirname(resolvedSqlitePath), "credentials.db");
}

/** Original `credentials.encryptionKey` config string (non-enumerable on parsed config). */
export function getCredentialsEncryptionKeyRaw(cfg: HybridMemoryConfig): string {
  const cred = cfg.credentials as { encryptionKeyRef?: string };
  const raw = cred.encryptionKeyRef?.trim();
  if (raw) return raw;
  return cfg.credentials.encryptionKey?.trim() ?? "";
}
