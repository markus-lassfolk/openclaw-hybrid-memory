/**
 * CLI Store Command Handlers
 *
 * Contains inferTargetFile and runStoreForCli — the core memory-store
 * CLI implementation extracted from handlers.ts.
 */

import type { MemoryCategory } from "../config.js";
import { getDefaultCronModel, getCronModelConfig } from "../config.js";
import { capturePluginError } from "../services/error-reporter.js";
import { extractStructuredFields } from "../services/fact-extraction.js";
import { isCredentialLike, tryParseCredentialForVault, VAULT_POINTER_PREFIX } from "../services/auto-capture.js";
import { findSimilarByEmbedding } from "../services/vector-search.js";
import { classifyMemoryOperation } from "../services/classification.js";
import { parseSourceDate } from "../utils/dates.js";
import { extractTags } from "../utils/tags.js";
import { CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import type { StoreCliOpts, StoreCliResult } from "./types.js";
import type { HandlerContext } from "./handlers.js";

/**
 * Infer which identity file a rule or suggestion should target (#260).
 */
export function inferTargetFile(content: string): string {
  const lower = content.toLowerCase();
  if (/\b(identity|creature|persona)\b/.test(lower)) return "IDENTITY.md";
  if (/\b(my (name|role)|agent (name|role|identity)|who (i am|you are))\b/.test(lower)) return "IDENTITY.md";
  if (/\b(preference|style|workflow|working|setup|tooling)\b/.test(lower)) return "USER.md";
  return "SOUL.md";
}

/**
 * Store a memory via CLI
 */
export async function runStoreForCli(
  ctx: HandlerContext,
  opts: StoreCliOpts,
  log: { warn: (m: string) => void },
): Promise<StoreCliResult> {
  const { factsDb, vectorDb, embeddings, openai, cfg, credentialsDb, aliasDb } = ctx;
  const text = opts.text;
  if (factsDb.hasDuplicate(text)) return { outcome: "duplicate" };
  const sourceDate = opts.sourceDate ? parseSourceDate(opts.sourceDate) : null;
  const extracted = extractStructuredFields(text, (opts.category ?? "other") as MemoryCategory);
  const entity = opts.entity ?? extracted.entity ?? null;
  const key = opts.key ?? extracted.key ?? null;
  const value = opts.value ?? extracted.value ?? null;

  if (cfg.credentials.enabled && credentialsDb && isCredentialLike(text, entity, key, value)) {
    const parsed = tryParseCredentialForVault(text, entity, key, value, {
      requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
    });
    if (parsed) {
      // Step 1: Write to vault (use storeIfNew to avoid overwriting user-managed credentials)
      try {
        const stored = credentialsDb.storeIfNew({
          service: parsed.service,
          type: parsed.type as any,
          value: parsed.secretValue,
          url: parsed.url,
          notes: parsed.notes,
        });
        if (!stored) {
          return { outcome: "credential_skipped_duplicate", service: parsed.service, type: parsed.type };
        }
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:credential-vault-store" });
        return { outcome: "credential_vault_error" };
      }

      // Step 2: Write pointer to factsDb
      let pointerEntry: any;
      try {
        const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}") to retrieve.`;
        const pointerValue = `${VAULT_POINTER_PREFIX}${parsed.service}:${parsed.type}`;
        pointerEntry = factsDb.store({
          text: pointerText,
          category: "technical" as MemoryCategory,
          importance: CLI_STORE_IMPORTANCE,
          entity: "Credentials",
          key: parsed.service,
          value: pointerValue,
          source: "cli",
          sourceDate,
          tags: ["auth", ...extractTags(pointerText, "Credentials")],
        });
        try {
          const vector = await embeddings.embed(pointerText);
          factsDb.setEmbeddingModel(pointerEntry.id, embeddings.modelName);
          if (!(await vectorDb.hasDuplicate(vector))) {
            await vectorDb.store({
              text: pointerText,
              vector,
              importance: CLI_STORE_IMPORTANCE,
              category: "technical",
              id: pointerEntry.id,
            });
          }
        } catch (err) {
          log.warn(`memory-hybrid: vector store failed: ${err}`);
          capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:vector-store" });
        }
      } catch (err) {
        // Compensating delete: vault write succeeded but pointer write failed
        try {
          // biome-ignore lint/suspicious/noExplicitAny: credential type from parsed input
          credentialsDb.delete(parsed.service, parsed.type as any);
        } catch (cleanupErr) {
          log.warn(`memory-hybrid: Failed to clean up orphaned credential for ${parsed.service}: ${cleanupErr}`);
          capturePluginError(cleanupErr as Error, {
            subsystem: "cli",
            operation: "runStoreForCli:credential-compensating-delete",
          });
        }
        capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:credential-db-store" });
        return { outcome: "credential_db_error" };
      }
      return { outcome: "credential", id: pointerEntry.id, service: parsed.service, type: parsed.type };
    }
    return { outcome: "credential_parse_error" };
  }

  const tags = opts.tags
    ? opts.tags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    : undefined;
  const category = (opts.category ?? "other") as MemoryCategory;

  // FR-006: Compute scope early so it's available for classify-before-write UPDATE path
  const scope = opts.scope ?? "global";
  const scopeTarget = scope === "global" ? null : (opts.scopeTarget?.trim() ?? null);

  if (cfg.store.classifyBeforeWrite) {
    let vector: number[] | undefined;
    try {
      vector = await embeddings.embed(text);
    } catch (err) {
      log.warn(`memory-hybrid: CLI store embedding failed: ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:embed" });
    }
    if (vector) {
      let similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vector, 5);
      if (similarFacts.length === 0) {
        similarFacts = factsDb.findSimilarForClassification(text, entity, key, 5);
      }
      if (similarFacts.length > 0) {
        try {
          const classification = await classifyMemoryOperation(
            text,
            entity,
            key,
            similarFacts,
            openai,
            cfg.store.classifyModel ?? getDefaultCronModel(getCronModelConfig(cfg), "nano"),
            log,
          );
          if (classification.action === "NOOP") return { outcome: "noop", reason: classification.reason ?? "" };
          if (classification.action === "DELETE" && classification.targetId) {
            factsDb.supersede(classification.targetId, null);
            aliasDb?.deleteByFactId(classification.targetId);
            return { outcome: "retracted", targetId: classification.targetId, reason: classification.reason ?? "" };
          }
          if (classification.action === "UPDATE" && classification.targetId) {
            const oldFact = factsDb.getById(classification.targetId);
            if (oldFact) {
              const nowSec = Math.floor(Date.now() / 1000);
              const newEntry = factsDb.store({
                text,
                category,
                importance: CLI_STORE_IMPORTANCE,
                entity: entity ?? oldFact.entity,
                key: opts.key ?? extracted.key ?? oldFact.key ?? null,
                value: opts.value ?? extracted.value ?? oldFact.value ?? null,
                source: "cli",
                sourceDate,
                tags: tags ?? extractTags(text, entity),
                validFrom: sourceDate ?? nowSec,
                supersedesId: classification.targetId,
                scope,
                scopeTarget,
              });
              factsDb.supersede(classification.targetId, newEntry.id);
              aliasDb?.deleteByFactId(classification.targetId);
              try {
                factsDb.setEmbeddingModel(newEntry.id, embeddings.modelName);
                if (!(await vectorDb.hasDuplicate(vector))) {
                  await vectorDb.store({ text, vector, importance: CLI_STORE_IMPORTANCE, category, id: newEntry.id });
                }
              } catch (err) {
                log.warn(`memory-hybrid: vector store failed: ${err}`);
                capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:vector-store-update" });
              }
              return {
                outcome: "updated",
                id: newEntry.id,
                supersededId: classification.targetId,
                reason: classification.reason ?? "",
              };
            }
          }
        } catch (err) {
          log.warn(`memory-hybrid: CLI store classification failed: ${err}`);
          capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:classify" });
        }
      }
    }
  }

  // FR-006: scope already computed above
  const supersedesId = opts.supersedes?.trim();
  const nowSec = supersedesId ? Math.floor(Date.now() / 1000) : undefined;
  try {
    const entry = factsDb.store({
      text,
      category,
      importance: CLI_STORE_IMPORTANCE,
      entity,
      key: opts.key ?? extracted.key ?? null,
      value: opts.value ?? extracted.value ?? null,
      source: "cli",
      sourceDate,
      tags: tags ?? extractTags(text, entity),
      scope,
      scopeTarget,
      ...(supersedesId ? { validFrom: nowSec, supersedesId } : {}),
    });
    if (supersedesId) {
      factsDb.supersede(supersedesId, entry.id);
      aliasDb?.deleteByFactId(supersedesId);
    }
    try {
      const vector = await embeddings.embed(text);
      factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
      if (!(await vectorDb.hasDuplicate(vector))) {
        await vectorDb.store({
          text,
          vector,
          importance: CLI_STORE_IMPORTANCE,
          category: opts.category ?? "other",
          id: entry.id,
        });
      }
    } catch (err) {
      log.warn(`memory-hybrid: vector store failed: ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:vector-store-final" });
    }
    return {
      outcome: "stored",
      id: entry.id,
      textPreview: text.slice(0, 80) + (text.length > 80 ? "..." : ""),
      ...(supersedesId ? { supersededId: supersedesId } : {}),
    };
  } catch (err) {
    capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:store" });
    throw err;
  }
}
