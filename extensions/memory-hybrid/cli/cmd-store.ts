/**
 * CLI Store Command Handlers
 *
 * Contains inferTargetFile and runStoreForCli — the core memory-store
 * CLI implementation extracted from handlers.ts.
 */

import type { MemoryCategory } from "../config.js";
import { getCronModelConfig, getDefaultCronModel } from "../config.js";
import { tryParseCredentialForVault, isStructuredCredentialCandidate } from "../services/auto-capture.js";
import {
  buildCredentialPointerText,
  ensureCredentialVaultPointer,
  abortCredentialVaultWriteOnPointerDedupe,
  rollbackVaultCredentialWrite,
} from "../services/credential-vault-pointer.js";
import { classifyMemoryOperation } from "../services/classification.js";
import { validateScopedClassificationTarget } from "../services/classification-scope.js";
import { capturePluginError } from "../services/error-reporter.js";
import { extractStructuredFields } from "../services/fact-extraction.js";
import { cleanupEvictedVector, deleteVectorForFactId } from "../services/vector-maintenance.js";
import { findSimilarByEmbedding } from "../services/vector-search.js";
import { CLI_STORE_IMPORTANCE } from "../utils/constants.js";
import { parseSourceDate } from "../utils/dates.js";
import { persistCanonicalFactEmbedding } from "../utils/fact-embeddings.js";
import { extractTags } from "../utils/tags.js";
import type { HandlerContext } from "./handlers.js";
import type { StoreCliOpts, StoreCliResult } from "./types.js";
import type { MemoryEntry } from "../types/memory.js";

/**
 * Infer which identity file a rule or suggestion should target (#260).
 */
/**
 * Infer the persona target file for a self-correction AGENTS_RULE line.
 *
 * Rules:
 * - SOUL.md is the default for behavioural guidance — how the agent acts.
 * - USER.md only gets facts explicitly about the human operator (name, preferences,
 *   personal context). Behavioural rules that mention "workflow" or "working" describe
 *   Maeve's working style, not the user's, so they must NOT go to USER.md.
 * - IDENTITY.md is for identity/persona declarations (name, role, creature type).
 */
export function inferTargetFile(content: string): string {
  const lower = content.toLowerCase();
  if (/\b(identity|creature|persona)\b/.test(lower)) return "IDENTITY.md";
  if (/\b(my (name|role)|agent (name|role|identity)|who (i am|you are))\b/.test(lower)) return "IDENTITY.md";
  // USER.md only for explicit user/operator facts — not agent behavioural style
  if (/\bthe (user|operator|human|markus)\b.*\b(prefers?|likes?|wants?|expects?|needs?)\b/.test(lower))
    return "USER.md";
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
  const sourceDate = opts.sourceDate ? parseSourceDate(opts.sourceDate) : null;
  const extracted = extractStructuredFields(text, (opts.category ?? "other") as MemoryCategory);
  const entity = opts.entity ?? extracted.entity ?? null;
  const key = opts.key ?? extracted.key ?? null;
  const value = opts.value ?? extracted.value ?? null;
  const parsedCredential = tryParseCredentialForVault(text, entity, key, value, {
    requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
  });
  if (parsedCredential) {
    const parsed = parsedCredential;
    if (cfg.credentials.enabled && credentialsDb) {
      let storedInVault = false;
      try {
        storedInVault = credentialsDb.storeIfNew({
          service: parsed.service,
          type: parsed.type,
          value: parsed.secretValue,
          url: parsed.url,
          notes: parsed.notes,
        }) != null;
      } catch (err) {
        capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:credential-vault-store" });
        return { outcome: "credential_vault_error" };
      }

      let pointerEntry: MemoryEntry;
      try {
        const pointer = ensureCredentialVaultPointer(factsDb, parsed.service, parsed.type, "cli", {
          importance: CLI_STORE_IMPORTANCE,
          sourceDate,
        });
        if (!pointer.ok) {
          if (storedInVault) {
            rollbackVaultCredentialWrite(credentialsDb, parsed.service, parsed.type, (msg, err) =>
              log.warn(`memory-hybrid: ${msg}: ${err}`),
            );
          }
          return { outcome: "noop", reason: "artifact text rejected by pre-store guard" };
        }
        pointerEntry = pointer.entry;
        if (
          abortCredentialVaultWriteOnPointerDedupe(storedInVault, pointer, credentialsDb, parsed.service, parsed.type)
        ) {
          return {
            outcome: "credential_skipped_duplicate",
            service: parsed.service,
            type: parsed.type,
          };
        }
        await cleanupEvictedVector({
          vectorDb: vectorDb,
          evictedFactId: pointer.evictedFactId,
          logger: log,
          context: "cli-store",
        });
        if (pointer.newlyStored || pointer.embeddingStale) {
          const pointerText = buildCredentialPointerText(parsed.service, parsed.type);
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
            persistCanonicalFactEmbedding(
              factsDb,
              pointerEntry.id,
              embeddings.modelName,
              vector,
              "runStoreForCli:pointer-fact-embeddings",
              "cli",
              log.warn,
            );
          } catch (err) {
            log.warn(`memory-hybrid: vector store failed: ${err}`);
            capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:vector-store" });
          }
        }
      } catch (err) {
        if (storedInVault) {
          rollbackVaultCredentialWrite(credentialsDb, parsed.service, parsed.type, (msg, cleanupErr) =>
            log.warn(`memory-hybrid: ${msg}: ${cleanupErr}`),
          );
        }
        capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:credential-db-store" });
        return { outcome: "credential_db_error" };
      }
      return { outcome: "credential", id: pointerEntry.id, service: parsed.service, type: parsed.type };
    }
    return { outcome: "credential_blocked_no_vault" };
  }

  // When requirePatternMatch rejects vault parsing but the input is still credential-like,
  // block ordinary storage to prevent plaintext secrets in facts.db (#1896).
  if (
    !parsedCredential &&
    cfg.credentials.autoCapture?.requirePatternMatch === true &&
    isStructuredCredentialCandidate(text, entity, key, value)
  ) {
    return { outcome: "credential_blocked_require_pattern_match" };
  }

  const tags = opts.tags
    ? opts.tags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    : undefined;
  const category = (opts.category ?? "other") as MemoryCategory;

  // FR-006: Compute scope before the duplicate pre-check below (must run after scope resolution,
  // not before it): dedupe state must never be shared across scopes, or an agent/user-scoped
  // store can be wrongly rejected as "duplicate" against an unrelated global fact with the same
  // text (or vice versa) — the identical bug already fixed in the sibling
  // tools/memory/register-store-tools.ts MCP path.
  const scope = opts.scope ?? "global";
  const scopeTarget = scope === "global" ? null : (opts.scopeTarget?.trim() ?? null);

  const dedupeProfile = cfg.store.sourceProfiles?.cli ?? cfg.store.defaultProfile;
  const cliDuplicatesCanMutateExistingFact =
    dedupeProfile?.onDuplicate === "merge" || dedupeProfile?.onDuplicate === "boost";
  if (
    !cliDuplicatesCanMutateExistingFact &&
    factsDb.hasDuplicate(
      text,
      "cli",
      {
        category,
        entity,
        key,
        value,
      },
      scope,
      scopeTarget,
    )
  ) {
    return { outcome: "duplicate" };
  }

  if (cfg.store.classifyBeforeWrite) {
    let vector: number[] | undefined;
    try {
      vector = await embeddings.embed(text);
    } catch (err) {
      log.warn(`memory-hybrid: CLI store embedding failed: ${err}`);
      capturePluginError(err as Error, { subsystem: "cli", operation: "runStoreForCli:embed" });
    }
    if (vector) {
      let similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vector, 5, 0.3, { scope, scopeTarget });
      if (similarFacts.length === 0) {
        similarFacts = factsDb.findSimilarForClassification(text, entity, key, 5, scope, scopeTarget);
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
            const target = validateScopedClassificationTarget({
              targetId: classification.targetId,
              candidates: similarFacts,
              getById: (id) => factsDb.getById(id),
              scope,
              scopeTarget,
              warn: (message) => log.warn(message),
              warnMessage: `memory-hybrid: blocked cross-scope or unknown classification DELETE target ${classification.targetId}`,
            });
            if (target) {
              factsDb.supersede(classification.targetId, null);
              aliasDb?.deleteByFactId(classification.targetId);
              await deleteVectorForFactId({
                vectorDb: vectorDb,
                factId: classification.targetId,
                logger: log,
                context: "cli-store-delete-action",
              });
              return { outcome: "retracted", targetId: classification.targetId, reason: classification.reason ?? "" };
            }
            return {
              outcome: "noop",
              reason: `blocked delete target ${classification.targetId} due to scope/candidate validation`,
            };
          }
          if (classification.action === "UPDATE" && classification.targetId) {
            const oldFact = validateScopedClassificationTarget({
              targetId: classification.targetId,
              candidates: similarFacts,
              getById: (id) => factsDb.getById(id),
              scope,
              scopeTarget,
              warn: (message) => log.warn(message),
              warnMessage: `memory-hybrid: blocked cross-scope classification UPDATE target ${classification.targetId}`,
            });
            if (oldFact) {
              const nowSec = Math.floor(Date.now() / 1000);
              const storeResult = factsDb.storeWithResult({
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
              if (storeResult.skipped) {
                return { outcome: "noop", reason: "artifact text rejected by pre-store guard" };
              }
              if (storeResult.newlyStored === false && !storeResult.embeddingStale) {
                return {
                  outcome: "noop",
                  reason: "dedupe-update",
                  id: storeResult.entry.id,
                };
              }
              const newEntry = storeResult.entry;
              // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
              await cleanupEvictedVector({
                vectorDb: vectorDb,
                evictedFactId: storeResult.evictedFactId,
                logger: log,
                context: "cli-store",
              });
              if (storeResult.newlyStored) {
                factsDb.supersede(classification.targetId, newEntry.id);
                aliasDb?.deleteByFactId(classification.targetId);
                await deleteVectorForFactId({
                  vectorDb: vectorDb,
                  factId: classification.targetId,
                  logger: log,
                  context: "cli-store-update-superseded",
                });
              }
              try {
                if (storeResult.embeddingStale) {
                  const mergedVector = await embeddings.embed(newEntry.text);
                  factsDb.setEmbeddingModel(newEntry.id, embeddings.modelName);
                  await vectorDb.store({
                    text: newEntry.text,
                    vector: mergedVector,
                    importance: CLI_STORE_IMPORTANCE,
                    category,
                    id: newEntry.id,
                  });
                  persistCanonicalFactEmbedding(
                    factsDb,
                    newEntry.id,
                    embeddings.modelName,
                    mergedVector,
                    "runStoreForCli:update-fact-embeddings",
                    "cli",
                    log.warn,
                  );
                } else {
                  const canonicalText = newEntry.text;
                  const canonicalVector = canonicalText === text ? vector : await embeddings.embed(canonicalText);
                  factsDb.setEmbeddingModel(newEntry.id, embeddings.modelName);
                  if (!(await vectorDb.hasDuplicate(canonicalVector))) {
                    await vectorDb.store({
                      text: canonicalText,
                      vector: canonicalVector,
                      importance: CLI_STORE_IMPORTANCE,
                      category,
                      id: newEntry.id,
                    });
                  }
                  persistCanonicalFactEmbedding(
                    factsDb,
                    newEntry.id,
                    embeddings.modelName,
                    canonicalVector,
                    "runStoreForCli:update-fact-embeddings",
                    "cli",
                    log.warn,
                  );
                }
              } catch (err) {
                log.warn(
                  storeResult.embeddingStale
                    ? `memory-hybrid: stale vector re-embed failed for merged fact ${newEntry.id.slice(0, 8)} — nightly re-index will repair: ${err}`
                    : `memory-hybrid: vector store failed: ${err}`,
                );
                capturePluginError(err as Error, {
                  subsystem: "cli",
                  operation: storeResult.embeddingStale
                    ? "runStoreForCli:vector-store-update-stale"
                    : "runStoreForCli:vector-store-update",
                });
              }
              return storeResult.newlyStored
                ? {
                    outcome: "updated",
                    id: newEntry.id,
                    supersededId: classification.targetId,
                    reason: classification.reason ?? "",
                  }
                : {
                    outcome: "noop",
                    reason: storeResult.embeddingStale ? "dedupe-merge" : "dedupe-update",
                    id: newEntry.id,
                  };
            }
            return {
              outcome: "noop",
              reason: `blocked update target ${classification.targetId} due to scope/candidate validation`,
            };
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
    const storeResult = factsDb.storeWithResult({
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
    if (storeResult.skipped) {
      return { outcome: "noop", reason: "artifact text rejected by pre-store guard" };
    }
    if (storeResult.newlyStored === false && !storeResult.embeddingStale) {
      return { outcome: "noop", reason: "dedupe", id: storeResult.entry.id };
    }
    const entry = storeResult.entry;
    // CRITICAL FIX (#2): Delete vector for evicted fact to prevent orphaned vectors
    await cleanupEvictedVector({
      vectorDb: vectorDb,
      evictedFactId: storeResult.evictedFactId,
      logger: log,
      context: "cli-store",
    });
    if (supersedesId && storeResult.newlyStored) {
      factsDb.supersede(supersedesId, entry.id);
      aliasDb?.deleteByFactId(supersedesId);
    }
    try {
      if (storeResult.embeddingStale) {
        // Merge case: the existing fact's text was updated in-place.
        // Re-embed the merged text and force-replace the stale LanceDB vector.
        // If embed fails, the vector encodes stale pre-merge text; nightly re-index will repair.
        const mergedVector = await embeddings.embed(entry.text);
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
        await vectorDb.store({
          text: entry.text,
          vector: mergedVector,
          importance: CLI_STORE_IMPORTANCE,
          category: opts.category ?? "other",
          id: entry.id,
        });
        persistCanonicalFactEmbedding(
          factsDb,
          entry.id,
          embeddings.modelName,
          mergedVector,
          "runStoreForCli:final-fact-embeddings",
          "cli",
          log.warn,
        );
      } else {
        const canonicalText = entry.text;
        const vector = await embeddings.embed(text);
        const canonicalVector = canonicalText === text ? vector : await embeddings.embed(canonicalText);
        factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
        if (!(await vectorDb.hasDuplicate(canonicalVector))) {
          await vectorDb.store({
            text: canonicalText,
            vector: canonicalVector,
            importance: CLI_STORE_IMPORTANCE,
            category: opts.category ?? "other",
            id: entry.id,
          });
        }
        persistCanonicalFactEmbedding(
          factsDb,
          entry.id,
          embeddings.modelName,
          canonicalVector,
          "runStoreForCli:final-fact-embeddings",
          "cli",
          log.warn,
        );
      }
    } catch (err) {
      log.warn(
        storeResult.embeddingStale
          ? `memory-hybrid: stale vector re-embed failed for merged fact ${entry.id.slice(0, 8)} — nightly re-index will repair: ${err}`
          : `memory-hybrid: vector store failed: ${err}`,
      );
      capturePluginError(err as Error, {
        subsystem: "cli",
        operation: storeResult.embeddingStale
          ? "runStoreForCli:vector-store-final-stale"
          : "runStoreForCli:vector-store-final",
      });
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
