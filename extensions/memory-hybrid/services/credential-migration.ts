/**
 * Credential migration service: migrate existing credential facts to vault.
 * One-time migration logic when vault is enabled.
 */

import { writeFileSync } from "fs";
import type { FactsDB } from "../backends/facts.js";
import type { VectorDB } from "../backends/vector.js";
import type { CredentialsDB } from "../backends/credentials.js";
import type { Embeddings } from "./embeddings.js";
import type { MemoryCategory } from "../types/memory.js";
import { tryParseCredentialForVault, VAULT_POINTER_PREFIX } from "./auto-capture.js";
import { extractTags } from "./auto-capture.js";
import { BATCH_STORE_IMPORTANCE } from "../utils/constants.js";
import { capturePluginError } from "./error-reporter.js";

export const CREDENTIAL_REDACTION_MIGRATION_FLAG = ".credential-redaction-migrated";

export interface MigrateCredentialsOptions {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: Embeddings;
  credentialsDb: CredentialsDB;
  migrationFlagPath: string;
  markDone: boolean;
}

export interface MigrateCredentialsResult {
  migrated: number;
  skipped: number;
  errors: string[];
}

/**
 * When vault is enabled: move existing credential facts from memory into the vault and replace them with pointers.
 * Idempotent: facts that are already pointers (value starts with vault:) are skipped.
 * Returns { migrated, skipped, errors }. If markDone is true, writes a flag file so init only runs once.
 */
export async function migrateCredentialsToVault(
  opts: MigrateCredentialsOptions,
): Promise<MigrateCredentialsResult> {
  const { factsDb, vectorDb, embeddings, credentialsDb, migrationFlagPath, markDone } = opts;
  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];

  const results = factsDb.lookup("Credentials");
  const toMigrate = results.filter(
    (r) =>
      !r.entry.text.includes("stored in secure vault") &&
      (r.entry.value == null || (typeof r.entry.value === "string" && !r.entry.value.startsWith(VAULT_POINTER_PREFIX))),
  );

  for (const { entry } of toMigrate) {
    const parsed = tryParseCredentialForVault(
      entry.text,
      entry.entity,
      entry.key,
      entry.value,
    );
    if (!parsed) {
      skipped++;
      continue;
    }
    try {
      credentialsDb.store({
        service: parsed.service,
        type: parsed.type,
        value: parsed.secretValue,
        url: parsed.url,
        notes: parsed.notes,
      });
      factsDb.delete(entry.id);
      try {
        await vectorDb.delete(entry.id);
      } catch {
        // LanceDB row might not exist
      }
      const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
      const pointerValue = VAULT_POINTER_PREFIX + parsed.service;
      const pointerEntry = factsDb.store({
        text: pointerText,
        category: "technical" as MemoryCategory,
        importance: BATCH_STORE_IMPORTANCE,
        entity: "Credentials",
        key: parsed.service,
        value: pointerValue,
        source: "conversation",
        decayClass: "permanent",
        tags: ["auth", ...extractTags(pointerText, "Credentials")],
      });
      try {
        const vector = await embeddings.embed(pointerText);
        if (!(await vectorDb.hasDuplicate(vector))) {
          await vectorDb.store({
            text: pointerText,
            vector,
            importance: BATCH_STORE_IMPORTANCE,
            category: "technical",
            id: pointerEntry.id,
          });
        }
      } catch (e) {
        capturePluginError(e instanceof Error ? e : new Error(String(e)), {
          subsystem: "vector",
          operation: "store-migration-pointer",
          phase: "initialization",
          backend: "lancedb",
        });
        errors.push(`vector store for ${parsed.service}: ${String(e)}`);
      }
      migrated++;
    } catch (e) {
      capturePluginError(e instanceof Error ? e : new Error(String(e)), {
        subsystem: "credentials",
        operation: "migrate-fact-to-vault",
        phase: "initialization",
        backend: "sqlite",
      });
      errors.push(`${parsed.service}: ${String(e)}`);
    }
  }

  if (markDone) {
    try {
      writeFileSync(migrationFlagPath, "1", "utf8");
    } catch (e) {
      capturePluginError(e instanceof Error ? e : new Error(String(e)), {
        subsystem: "credentials",
        operation: "migrate-write-flag",
        phase: "initialization",
      });
      errors.push(`write migration flag: ${String(e)}`);
    }
  }
  return { migrated, skipped, errors };
}
