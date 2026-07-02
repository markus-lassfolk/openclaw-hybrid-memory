/**
 * Shared vault pointer fact helpers — keep credential tools and memory_store paths consistent.
 */

import type { CredentialsDB } from "../backends/credentials-db.js";
import type { StoreFactInput, StoreFactResult } from "../backends/facts-db/crud.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { CredentialType, MemoryCategory } from "../config.js";
import type { MemoryEntry } from "../types/memory.js";
import { extractTags } from "../utils/tags.js";
import { VAULT_POINTER_PREFIX } from "./auto-capture.js";
import { capturePluginError } from "./error-reporter.js";

export function credentialPointerValue(service: string, type: CredentialType): string {
  return `${VAULT_POINTER_PREFIX}${service}:${type}`;
}

export function buildCredentialPointerText(service: string, type: CredentialType): string {
  return `Credential for ${service} (${type}) — stored in secure vault. Use credential_get(service="${service}", type="${type}") to retrieve.`;
}

export function buildCredentialPointerStoreInput(
  service: string,
  type: CredentialType,
  source: string,
  extra?: Partial<StoreFactInput>,
): StoreFactInput {
  const pointerText = buildCredentialPointerText(service, type);
  return {
    text: pointerText,
    category: "technical" as MemoryCategory,
    importance: extra?.importance ?? 0.9,
    entity: "Credentials",
    key: service,
    value: credentialPointerValue(service, type),
    source,
    decayClass: extra?.decayClass ?? "permanent",
    tags: ["auth", ...extractTags(pointerText, "Credentials")],
    ...extra,
  };
}

export function isCredentialPointerRejected(result: StoreFactResult): boolean {
  return result.skipped === true;
}

export function isCredentialPointerLinked(result: StoreFactResult): boolean {
  return !isCredentialPointerRejected(result);
}

export function isCredentialPointerPureDedupe(result: StoreFactResult): boolean {
  return isCredentialPointerLinked(result) && result.newlyStored === false && !result.embeddingStale;
}

/** When the facts pointer already exists, roll back a fresh vault write to avoid orphaned secrets. Returns true if the caller should treat the operation as a no-op duplicate. */
export function abortCredentialVaultWriteOnPointerDedupe(
  storedInVault: boolean,
  pointer: Extract<EnsureCredentialPointerResult, { ok: true }>,
  credentialsDb: CredentialsDB,
  service: string,
  type: CredentialType,
): boolean {
  if (pointer.newlyStored || pointer.embeddingStale) return false;
  if (storedInVault) {
    rollbackVaultCredentialWrite(credentialsDb, service, type);
  }
  return true;
}

/** Default failure reporter used when a caller doesn't supply its own `onFailure` — every
 * rollback failure orphans a live secret in the vault, so it must never be silently discarded. */
function defaultRollbackFailureHandler(message: string, err: unknown): void {
  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
    operation: "rollback-vault-credential-write",
    subsystem: "credentials",
    severity: "warning",
    tags: { message },
  });
}

export function rollbackVaultCredentialWrite(
  credentialsDb: CredentialsDB,
  service: string,
  type: CredentialType,
  onFailure: (message: string, err: unknown) => void = defaultRollbackFailureHandler,
): void {
  try {
    credentialsDb.delete(service, type);
  } catch (err) {
    onFailure(`Failed to clean up orphaned credential for ${service}`, err);
  }
}

export function findCredentialPointerFactIds(factsDb: FactsDB, service: string, type?: CredentialType): string[] {
  const ids: string[] = [];
  for (const { entry } of factsDb.lookup("Credentials")) {
    if ((entry.key ?? "") !== service) continue;
    const value = entry.value;
    if (typeof value !== "string" || !value.startsWith(VAULT_POINTER_PREFIX)) continue;
    if (type) {
      if (value === credentialPointerValue(service, type)) ids.push(entry.id);
    } else if (value.startsWith(`${VAULT_POINTER_PREFIX}${service}:`)) {
      ids.push(entry.id);
    }
  }
  return ids;
}

export async function deleteCredentialPointerFacts(
  factsDb: FactsDB,
  vectorDb: VectorDB | null | undefined,
  service: string,
  type?: CredentialType,
): Promise<number> {
  const ids = findCredentialPointerFactIds(factsDb, service, type);
  for (const id of ids) {
    factsDb.delete(id);
    if (vectorDb) {
      try {
        await vectorDb.delete(id);
      } catch {
        // Lance row may not exist
      }
    }
  }
  return ids.length;
}

export type EnsureCredentialPointerResult =
  | { ok: true; entry: MemoryEntry; newlyStored: boolean; embeddingStale: boolean; evictedFactId: string | null }
  | { ok: false; reason: "rejected" };

/** Store (or dedupe-merge) the standard vault pointer fact. */
export function ensureCredentialVaultPointer(
  factsDb: FactsDB,
  service: string,
  type: CredentialType,
  source: string,
  extra?: Partial<StoreFactInput>,
): EnsureCredentialPointerResult {
  const result = factsDb.storeWithResult(buildCredentialPointerStoreInput(service, type, source, extra));
  if (isCredentialPointerRejected(result)) {
    return { ok: false, reason: "rejected" };
  }
  return {
    ok: true,
    entry: result.entry,
    newlyStored: result.newlyStored === true,
    embeddingStale: result.embeddingStale === true,
    evictedFactId: result.evictedFactId ?? null,
  };
}
