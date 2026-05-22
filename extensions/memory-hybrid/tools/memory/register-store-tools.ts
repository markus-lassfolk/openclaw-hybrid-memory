/**
 * Memory Tool Registrations
 *
 * Tool definitions for memory recall, storage, promotion, and deletion.
 * Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../../utils/typebox.js";

import { categoryToEventType } from "../../backends/event-log.js";
import {
  DECAY_CLASSES,
  type DecayClass,
  type MemoryCategory,
  getCronModelConfig,
  getDefaultCronModel,
  getMemoryCategories,
  isCompactVerbosity,
} from "../../config.js";
import { VAULT_POINTER_PREFIX, isCredentialLike, tryParseCredentialForVault } from "../../services/auto-capture.js";
import { classifyMemoryOperation } from "../../services/classification.js";
import { AllEmbeddingProvidersFailed, shouldSuppressEmbeddingError } from "../../services/embeddings.js";
import { extractEntityMentionsWithLlm } from "../../services/entity-enrichment.js";
import { addOperationBreadcrumb, capturePluginError } from "../../services/error-reporter.js";
import { extractStructuredFields } from "../../services/fact-extraction.js";
import { storeAliases } from "../../services/retrieval-aliases.js";
import { validateScopedClassificationTarget } from "../../services/classification-scope.js";
import { shouldAutoVerify } from "../../services/verification-store.js";
import { cleanupEvictedVector, deleteVectorForFactId } from "../../services/vector-maintenance.js";
import type { MemoryEntry } from "../../types/memory.js";
import { MEMORY_SCOPES } from "../../types/memory.js";
import { detectFutureDate } from "../../utils/date-detector.js";
import { embedCallWithTimeoutAndRetry } from "../../utils/embed-call.js";
import { extractTags } from "../../utils/tags.js";
import { truncateForStorage } from "../../utils/text.js";
import type { MemoryToolRuntime } from "./runtime.js";

export function registerStoreTools(runtime: MemoryToolRuntime): void {
  const {
    factsDb,
    edictStore,
    vectorDb,
    cfg,
    embeddings,
    openai,
    credentialsDb,
    eventLog,
    narrativesDb,
    provenanceService,
    aliasDb,
    embeddingRegistry,
    verificationStore,
    lastProgressiveIndexIds,
    currentAgentIdRef,
    pendingLLMWarnings,
    variantQueue,
    buildToolScopeFilter,
    walWrite,
    walRemove,
    findSimilarByEmbedding,
    auditStore,
    api,
    auditAppend,
    agentIdForAudit,
    maybeRefreshProjectActiveTaskProjection,
    storeActiveCanonicalVector,
    storeRegistryEmbeddings,
    isEdictWriteToolEnabled,
    sanitizeScopeParam,
  } = runtime;

  api.registerTool(
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information in long-term memory. Stores to both structured (SQLite) and semantic (LanceDB) backends.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        why: Type.Optional(
          Type.String({
            description:
              "Optional lineage context: why this memory matters (decision rationale, file impact, blocker context, etc.).",
          }),
        ),
        importance: Type.Optional(
          Type.Number({
            description:
              "Importance 0-1 (default: 0.5). Higher values signal facts that should survive longer during decay.",
          }),
        ),
        category: Type.Optional(stringEnum(getMemoryCategories() as unknown as readonly string[])),
        entity: Type.Optional(
          Type.String({
            description: "Entity name (person, project, tool, etc.)",
          }),
        ),
        key: Type.Optional(
          Type.String({
            description: "Structured key (e.g. 'birthday', 'email')",
          }),
        ),
        value: Type.Optional(
          Type.String({
            description: "Structured value (e.g. 'Nov 13', 'john@example.com')",
          }),
        ),
        decayClass: Type.Optional(
          Object.assign(stringEnum(DECAY_CLASSES as unknown as readonly string[]), {
            description:
              "Decay class defining half-life: durable (~3mo), normal (~2w), short (~2d), session (~1d), ephemeral (~4h), permanent (no decay). Legacy aliases: stable=durable, active=normal, checkpoint=ephemeral.",
          }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Topic tags for sharper retrieval (e.g. nibe, zigbee). Auto-inferred if omitted.",
          }),
        ),
        supersedes: Type.Optional(
          Type.String({
            description:
              "Fact id this one supersedes (replaces). Marks the old fact as superseded and links the new one.",
          }),
        ),
        scope: Type.Optional(stringEnum(MEMORY_SCOPES as unknown as readonly string[])),
        scopeTarget: Type.Optional(
          Type.String({
            description:
              "Scope target (userId, agentId, or sessionId). Required when scope is user, agent, or session.",
          }),
        ),
        verification_tier: Type.Optional(
          Type.String({
            description:
              "Optional verification tier override (e.g. 'critical') to force verification store enrollment.",
          }),
        ),
        decayFreezeUntil: Type.Optional(
          Type.Number({
            description:
              "Unix epoch seconds until which confidence decay is paused. Auto-detected from future dates in text if omitted.",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const {
            text,
            why,
            importance = 0.5,
            category = "other",
            entity: paramEntity,
            key: paramKey,
            value: paramValue,
            decayClass: paramDecayClass,
            tags: paramTags,
            supersedes,
            scope: paramScope,
            scopeTarget: paramScopeTarget,
            verification_tier: verificationTier,
            decayFreezeUntil: paramDecayFreezeUntil,
          } = params as {
            text: string;
            why?: string;
            importance?: number;
            category?: MemoryCategory;
            entity?: string;
            key?: string;
            value?: string;
            decayClass?: DecayClass;
            tags?: string[];
            supersedes?: string;
            scope?: "global" | "user" | "agent" | "session";
            scopeTarget?: string;
            verification_tier?: string;
            decayFreezeUntil?: number;
          };

          let textToStore = text;
          textToStore = truncateForStorage(textToStore, cfg.captureMaxChars);
          const provenanceSessionId = api.context?.sessionId ?? null;
          const recordActiveStoreProvenance = (factId: string, sourceText?: string) => {
            if (!provenanceService || !cfg.provenance.enabled) return;
            try {
              provenanceService.addEdge(factId, {
                edgeType: "DERIVED_FROM",
                sourceType: "active_store",
                sourceId: provenanceSessionId ?? "unknown-session",
                sourceText,
              });
            } catch (err) {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "provenance",
                operation: "memory-store-provenance",
                factId,
              });
            }
          };

          const extracted = extractStructuredFields(textToStore, category as MemoryCategory);
          const entity = paramEntity || extracted.entity;
          const key = paramKey || extracted.key;
          const value = paramValue || extracted.value;

          if (factsDb.hasDuplicate(textToStore, "conversation", { category, entity, key, value })) {
            return {
              content: [{ type: "text", text: "Similar memory already exists." }],
              details: { action: "duplicate" },
            };
          }

          // FR-006: Compute scope early so it's available for classify-before-write UPDATE path; normal path may overwrite with multiAgent logic below
          let scope: "global" | "user" | "agent" | "session" = paramScope ?? "global";
          let scopeTarget: string | null = scope === "global" ? null : (paramScopeTarget?.trim() ?? null);
          if (scope !== "global" && !scopeTarget) {
            return {
              content: [
                {
                  type: "text",
                  text: `Scope "${scope}" requires scopeTarget (userId, agentId, or sessionId).`,
                },
              ],
              details: { error: "scope_target_required" },
            };
          }

          const explicitVerificationTier = (verificationTier ?? "").trim().toLowerCase();

          const maybeAutoVerify = (
            factId: string,
            factText: string,
            autoTags: string[],
            autoEntity?: string | null,
            autoKey?: string | null,
            autoValue?: string | null,
          ) => {
            if (!cfg.verification.enabled || !verificationStore) return;
            const shouldEnroll =
              explicitVerificationTier === "critical" ||
              (cfg.verification.autoClassify &&
                shouldAutoVerify({
                  text: factText,
                  category,
                  tags: autoTags,
                  entity: autoEntity,
                  key: autoKey,
                  value: autoValue,
                  verificationTier: verificationTier ?? null,
                }));
            if (!shouldEnroll) return;
            try {
              const verifiedBy = explicitVerificationTier === "critical" ? "agent" : "system";
              verificationStore.verify(factId, factText, verifiedBy);
            } catch (err) {
              api.logger.warn?.(`memory-hybrid: auto-verify failed for ${factId}: ${err}`);
            }
          };

          // Dual-mode credentials: vault enabled → store in vault + pointer in memory; vault disabled → store in memory (live behavior).
          // When vault is enabled, credential-like content that fails to parse must not be written to memory (see docs/CREDENTIALS.md).
          if (cfg.credentials.enabled && credentialsDb && isCredentialLike(textToStore, entity, key, value)) {
            const parsed = tryParseCredentialForVault(textToStore, entity, key, value, {
              requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
            });
            if (parsed) {
              const stored = credentialsDb.storeIfNew({
                service: parsed.service,
                type: parsed.type,
                value: parsed.secretValue,
                url: parsed.url,
                notes: parsed.notes,
              });
              if (!stored) {
                return {
                  content: [
                    { type: "text", text: `Credential already in vault for ${parsed.service} (${parsed.type}).` },
                  ],
                  details: { action: "credential_skipped_duplicate", service: parsed.service, type: parsed.type },
                };
              }
              const pointerText = `Credential for ${parsed.service} (${parsed.type}) — stored in secure vault. Use credential_get(service="${parsed.service}", type="${parsed.type}") to retrieve.`;
              const pointerValue = `${VAULT_POINTER_PREFIX}${parsed.service}:${parsed.type}`;
              const pointerStoreResult = factsDb.storeWithResult({
                text: pointerText,
                why,
                category: "technical" as MemoryCategory,
                importance,
                entity: "Credentials",
                key: parsed.service,
                value: pointerValue,
                source: "conversation",
                decayClass: paramDecayClass ?? "permanent",
                tags: ["auth", ...extractTags(pointerText, "Credentials")],
                provenanceSession: provenanceSessionId,
                extractionMethod: "active",
                extractionConfidence: importance,
              });
              const pointerEntry = pointerStoreResult.entry;
              await cleanupEvictedVector({
                vectorDb,
                evictedFactId: pointerStoreResult.evictedFactId,
                logger: api.logger,
                context: "memory-store-credential-pointer",
              });
              recordActiveStoreProvenance(pointerEntry.id, pointerText);
              try {
                addOperationBreadcrumb("vector", "store-credential-pointer");
                const vector = await embedCallWithTimeoutAndRetry(
                  () => embeddings.embed(pointerText),
                  "memory-tools:store-credential-pointer",
                );
                await storeActiveCanonicalVector({
                  factId: pointerEntry.id,
                  text: pointerText,
                  why,
                  vector,
                  importance,
                  category: "technical",
                });
                await storeRegistryEmbeddings({
                  factsDb,
                  embeddingRegistry,
                  embeddings,
                  factId: pointerEntry.id,
                  text: pointerText,
                  vector,
                  logger: api.logger,
                  operation: "store-credential-pointer",
                });
              } catch (err) {
                // AllEmbeddingProvidersFailed is expected when no providers are configured — don't report to Sentry.
                if (!(err instanceof AllEmbeddingProvidersFailed)) {
                  capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                    subsystem: "vector",
                    operation: "store-credential-pointer",
                    phase: "runtime",
                    backend: "lancedb",
                  });
                }
                api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Credential stored in vault for ${parsed.service} (${parsed.type}). Pointer saved in memory.`,
                  },
                ],
                details: {
                  action: "credential_vault",
                  id: pointerEntry.id,
                  service: parsed.service,
                  type: parsed.type,
                },
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: "Credential-like content detected but could not be parsed as a structured credential; not stored (vault is enabled).",
                },
              ],
              details: { action: "credential_skipped" },
            };
          }

          const tags =
            paramTags && paramTags.length > 0
              ? paramTags.map((t) => t.trim().toLowerCase()).filter(Boolean)
              : extractTags(textToStore, entity);

          const summaryThreshold = cfg.autoRecall.summaryThreshold;
          const summary =
            summaryThreshold > 0 && textToStore.length > summaryThreshold
              ? `${textToStore.slice(0, cfg.autoRecall.summaryMaxChars).trim()}…`
              : undefined;

          // Generate vector first (needed for WAL and storage)
          let vector: number[] | undefined;
          try {
            vector = await embedCallWithTimeoutAndRetry(
              () => embeddings.embed(textToStore),
              "memory-tools:store-embed",
            );
          } catch (err) {
            if (err instanceof AllEmbeddingProvidersFailed) {
              // Graceful degradation: store the fact without a vector.
              // The fact is still findable by structured/keyword search.
              api.logger.warn("memory-hybrid: Stored fact without embeddings — all providers unavailable");
            } else if (shouldSuppressEmbeddingError(err)) {
              // Ollama circuit breaker, 429, config errors, etc. — expected noise (#937); don't send to GlitchTip.
              api.logger.warn(`memory-hybrid: embedding skipped (expected): ${err}`);
            } else {
              capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                subsystem: "embeddings",
                operation: "store-embed",
                phase: "runtime",
              });
              api.logger.warn(`memory-hybrid: embedding generation failed: ${err}`);
            }
          }

          // Classify the operation before storing (use embedding similarity)
          if (cfg.store.classifyBeforeWrite) {
            let similarFacts: MemoryEntry[] = [];
            if (vector) {
              similarFacts = await findSimilarByEmbedding(vectorDb, factsDb, vector, 5, 0.3, {
                scope,
                scopeTarget,
              });
            }
            if (similarFacts.length === 0) {
              similarFacts = factsDb.findSimilarForClassification(textToStore, entity, key, 5, scope, scopeTarget);
            }
            if (similarFacts.length > 0) {
              const classification = await classifyMemoryOperation(
                textToStore,
                entity,
                key,
                similarFacts,
                openai,
                cfg.store.classifyModel ?? getDefaultCronModel(getCronModelConfig(cfg), "nano"),
                api.logger,
              );

              if (classification.action === "NOOP") {
                return {
                  content: [{ type: "text", text: `Already known: ${classification.reason}` }],
                  details: { action: "noop", reason: classification.reason },
                };
              }

              if (classification.action === "DELETE" && classification.targetId) {
                const target = validateScopedClassificationTarget({
                  targetId: classification.targetId,
                  candidates: similarFacts,
                  getById: (id) => factsDb.getById(id),
                  scope,
                  scopeTarget,
                  warn: (message) => api.logger.warn?.(message),
                  warnMessage: `memory-hybrid: blocked cross-scope or unknown memory_store DELETE target ${classification.targetId}`,
                });
                if (target) {
                  factsDb.supersede(classification.targetId, null);
                  aliasDb?.deleteByFactId(classification.targetId);
                  await deleteVectorForFactId({
                    vectorDb,
                    factId: classification.targetId,
                    logger: api.logger,
                    context: "store-delete-action",
                  });
                  return {
                    content: [
                      { type: "text", text: `Retracted fact ${classification.targetId}: ${classification.reason}` },
                    ],
                    details: { action: "delete", targetId: classification.targetId, reason: classification.reason },
                  };
                }
                return {
                  content: [
                    {
                      type: "text",
                      text: `Blocked delete target ${classification.targetId}: failed scope/candidate validation.`,
                    },
                  ],
                  details: { action: "noop", reason: "blocked-delete-target-validation" },
                };
              }

              if (classification.action === "UPDATE" && classification.targetId) {
                const oldFact = validateScopedClassificationTarget({
                  targetId: classification.targetId,
                  candidates: similarFacts,
                  getById: (id) => factsDb.getById(id),
                  scope,
                  scopeTarget,
                  warn: (message) => api.logger.warn?.(message),
                  warnMessage: `memory-hybrid: blocked cross-scope or unknown memory_store UPDATE target ${classification.targetId}`,
                });
                if (oldFact) {
                  const walEntryId = await walWrite(
                    "update",
                    {
                      text: textToStore,
                      why,
                      category,
                      importance: Math.max(importance, oldFact.importance),
                      entity: entity || oldFact.entity,
                      key: key || oldFact.key,
                      value: value || oldFact.value,
                      source: "conversation",
                      decayClass: paramDecayClass ?? oldFact.decayClass,
                      summary,
                      tags,
                      vector,
                      embeddingModelName: vector ? embeddings.modelName : undefined,
                      scope,
                      scopeTarget,
                    },
                    api.logger,
                    classification.targetId,
                  );

                  const nowSec = Math.floor(Date.now() / 1000);
                  const updateStoreResult = factsDb.storeWithResult({
                    text: textToStore,
                    why,
                    category: category as MemoryCategory,
                    importance: Math.max(importance, oldFact.importance),
                    entity: entity || oldFact.entity,
                    key: key || oldFact.key,
                    value: value || oldFact.value,
                    source: "conversation",
                    decayClass: paramDecayClass ?? oldFact.decayClass,
                    summary,
                    tags,
                    validFrom: nowSec,
                    supersedesId: classification.targetId,
                    scope,
                    scopeTarget,
                    sourceSessions: api.context?.sessionId ?? undefined,
                    provenanceSession: provenanceSessionId,
                    extractionMethod: "active",
                    extractionConfidence: Math.max(importance, oldFact.importance),
                  });
                  const newEntry = updateStoreResult.entry;
                  await cleanupEvictedVector({
                    vectorDb,
                    evictedFactId: updateStoreResult.evictedFactId,
                    logger: api.logger,
                    context: "memory-store-update",
                  });
                  recordActiveStoreProvenance(newEntry.id, textToStore);
                  factsDb.supersede(classification.targetId, newEntry.id);
                  aliasDb?.deleteByFactId(classification.targetId);
                  await deleteVectorForFactId({
                    vectorDb,
                    factId: classification.targetId,
                    logger: api.logger,
                    context: "store-update-delete-superseded",
                  });
                  maybeAutoVerify(
                    newEntry.id,
                    textToStore,
                    newEntry.tags ?? tags,
                    newEntry.entity,
                    newEntry.key,
                    newEntry.value,
                  );

                  const finalImportance = Math.max(importance, oldFact.importance);
                  try {
                    if (vector) {
                      await storeActiveCanonicalVector({
                        factId: newEntry.id,
                        text: textToStore,
                        why,
                        vector,
                        importance: finalImportance,
                        category,
                      });
                    }
                    await storeRegistryEmbeddings({
                      factsDb,
                      embeddingRegistry,
                      embeddings,
                      factId: newEntry.id,
                      text: textToStore,
                      vector,
                      logger: api.logger,
                      operation: "store-update-supersede",
                    });
                  } catch (err) {
                    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                      subsystem: "vector",
                      operation: "store-update-supersede",
                      phase: "runtime",
                      backend: "lancedb",
                    });
                    api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
                  }

                  await walRemove(walEntryId, api.logger);
                  await maybeRefreshProjectActiveTaskProjection(newEntry.category, newEntry.id, newEntry.scope);

                  // Issue #159: enqueue contextual variant generation (non-blocking)
                  if (variantQueue) {
                    variantQueue.enqueue({ factId: newEntry.id, text: textToStore, category: category as string });
                  }

                  api.logger.info?.(
                    `memory-hybrid: UPDATE — superseded ${classification.targetId} with ${newEntry.id}: ${classification.reason}`,
                  );
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Updated: superseded old fact with "${textToStore.slice(0, 100)}${textToStore.length > 100 ? "..." : ""}"${entity ? ` [entity: ${entity}]` : ""} [decay: ${newEntry.decayClass}] (reason: ${classification.reason})`,
                      },
                    ],
                    details: {
                      action: "updated",
                      id: newEntry.id,
                      why: why ?? undefined,
                      superseded: classification.targetId,
                      reason: classification.reason,
                      backend: "both",
                      decayClass: newEntry.decayClass,
                    },
                  };
                }
                return {
                  content: [
                    {
                      type: "text",
                      text: `Blocked update target ${classification.targetId}: failed scope/candidate validation.`,
                    },
                  ],
                  details: { action: "noop", reason: "blocked-update-target-validation" },
                };
              }
              // action === "ADD" falls through to normal store
            }
          }

          // Resolve final scope before WAL write so the WAL entry captures the complete scope
          // metadata. Without this, a crash between WAL write and DB commit would cause replay
          // to default scoped facts to global scope (issue #1574).
          // Smart default scope based on agent identity and config (FR-006: overwrite for normal path when not explicit)
          if (paramScope) {
            // Explicit scope parameter always takes precedence
            scope = paramScope;
            scopeTarget = scope === "global" ? null : (paramScopeTarget?.trim() ?? null);
          } else {
            // Auto-determine scope based on multiAgent config
            const agentId = currentAgentIdRef.value || cfg.multiAgent.orchestratorId;
            const isOrchestrator = agentId === cfg.multiAgent.orchestratorId;

            // Strict agent scoping: throw if agent detection failed in agent/auto mode
            if (
              cfg.multiAgent.strictAgentScoping &&
              !currentAgentIdRef.value &&
              (cfg.multiAgent.defaultStoreScope === "agent" || cfg.multiAgent.defaultStoreScope === "auto")
            ) {
              throw new Error(
                `Agent detection failed (currentAgentId is null) and multiAgent.strictAgentScoping is enabled. Cannot auto-determine scope for defaultStoreScope="${cfg.multiAgent.defaultStoreScope}". Fix: ensure agent_id is provided in session context, or disable strictAgentScoping.`,
              );
            }

            if (cfg.multiAgent.defaultStoreScope === "global") {
              // Backward compatible: always global
              scope = "global";
              scopeTarget = null;
            } else if (cfg.multiAgent.defaultStoreScope === "agent") {
              // Always agent-scoped (for fully isolated setups)
              scope = "agent";
              scopeTarget = agentId;
            } else {
              // "auto" mode: orchestrator → global, specialists → agent
              if (isOrchestrator) {
                scope = "global";
                scopeTarget = null;
              } else {
                scope = "agent";
                scopeTarget = agentId;
              }
            }
          }

          // Final validation: if scope requires a target but none is available, fall back to global
          // (unless strictAgentScoping already threw above)
          if (scope !== "global" && !scopeTarget) {
            if (paramScope) {
              // User explicitly requested non-global scope but didn't provide target
              return {
                content: [
                  {
                    type: "text",
                    text: `Scope "${scope}" requires scopeTarget (userId, agentId, or sessionId). Provide scopeTarget parameter or use scope="global".`,
                  },
                ],
                details: { error: "scope_target_required" },
              };
            }
            // Auto-determined scope ended up without target (shouldn't happen with current logic,
            // but handle gracefully by falling back to global)
            scope = "global";
            scopeTarget = null;
          }

          const walEntryId = await walWrite(
            "store",
            {
              text: textToStore,
              why,
              category,
              importance,
              entity,
              key,
              value,
              source: "conversation",
              decayClass: paramDecayClass,
              summary,
              tags,
              vector,
              scope,
              scopeTarget,
            },
            api.logger,
          );
          const decayFreezeUntil =
            paramDecayFreezeUntil != null && Number.isFinite(paramDecayFreezeUntil)
              ? paramDecayFreezeUntil
              : detectFutureDate(textToStore, cfg.futureDateProtection ?? { enabled: false });

          const nowSec = Math.floor(Date.now() / 1000);
          const storeSessionId = api.context?.sessionId ?? null;
          const storeResult = factsDb.storeWithResult({
            text: textToStore,
            why,
            category: category as MemoryCategory,
            importance,
            entity,
            key,
            value,
            source: "conversation",
            decayClass: paramDecayClass,
            summary,
            tags,
            scope,
            scopeTarget,
            sourceSessions: storeSessionId ?? undefined,
            provenanceSession: provenanceSessionId,
            extractionMethod: "active",
            extractionConfidence: importance,
            decayFreezeUntil: decayFreezeUntil ?? undefined,
            ...(supersedes?.trim() ? { validFrom: nowSec, supersedesId: supersedes.trim() } : {}),
          });
          const entry = storeResult.entry;
          await cleanupEvictedVector({
            vectorDb,
            evictedFactId: storeResult.evictedFactId,
            logger: api.logger,
            context: "memory-store",
          });
          recordActiveStoreProvenance(entry.id, textToStore);
          if (supersedes?.trim()) {
            const supersededId = supersedes.trim();
            factsDb.supersede(supersededId, entry.id);
            aliasDb?.deleteByFactId(supersededId);
            await deleteVectorForFactId({
              vectorDb,
              factId: supersededId,
              logger: api.logger,
              context: "store-manual-supersede",
            });
          }

          try {
            addOperationBreadcrumb("vector", "store-fact");
            if (vector) {
              await storeActiveCanonicalVector({
                factId: entry.id,
                text: textToStore,
                why,
                vector,
                importance,
                category,
              });
            }
            await storeRegistryEmbeddings({
              factsDb,
              embeddingRegistry,
              embeddings,
              factId: entry.id,
              text: textToStore,
              vector,
              logger: api.logger,
              operation: "store-fact",
            });
          } catch (err) {
            capturePluginError(err instanceof Error ? err : new Error(String(err)), {
              subsystem: "vector",
              operation: "store-fact",
              phase: "runtime",
              backend: "lancedb",
            });
            api.logger.warn(`memory-hybrid: vector store failed: ${err}`);
          }

          await walRemove(walEntryId, api.logger);
          await maybeRefreshProjectActiveTaskProjection(entry.category, entry.id, entry.scope);

          // Issue #150: write event to episodic event log
          if (eventLog) {
            try {
              const eventType = categoryToEventType(category);
              eventLog.append({
                sessionId: api.context?.sessionId ?? "unknown",
                timestamp: new Date().toISOString(),
                eventType,
                content: {
                  text: textToStore.slice(0, 500),
                  factId: entry.id,
                  category,
                  importance,
                  source: "memory_store",
                },
                entities: entity ? [entity] : undefined,
              });
            } catch {
              // Non-fatal
            }
          }

          // Issue #159: enqueue contextual variant generation (non-blocking)
          if (variantQueue) {
            variantQueue.enqueue({ factId: entry.id, text: textToStore, category: category as string });
          }

          // Issue #149: generate and store retrieval aliases (non-blocking)
          if (cfg.aliases?.enabled && aliasDb && importance >= 0.5) {
            const aliasModel = cfg.aliases.model ?? getDefaultCronModel(getCronModelConfig(cfg), "nano");
            void storeAliases(entry.id, textToStore, cfg.aliases, aliasModel, openai, embeddings, aliasDb, (msg) =>
              api.logger.warn(msg),
            ).catch((err) => {
              api.logger.warn(`memory-hybrid: alias generation failed: ${err}`);
            });
          }

          // Contradiction detection (Issue #157): check for same entity+key, different value
          // Pass the stored fact's scope so detection stays within the same scope boundary.
          const contradictions = factsDb.detectContradictions(
            entry.id,
            entity ?? null,
            key ?? null,
            value ?? null,
            entry.scope ?? null,
            entry.scopeTarget ?? null,
          );
          for (const { contradictionId, oldFactId } of contradictions) {
            if (eventLog) {
              eventLog.append({
                sessionId: api.context?.sessionId ?? "unknown",
                timestamp: new Date().toISOString(),
                eventType: "correction",
                content: {
                  type: "contradiction_detected",
                  contradictionId,
                  newFactId: entry.id,
                  oldFactId,
                  entity: entity ?? null,
                  key: key ?? null,
                  newValue: value ?? null,
                },
                entities: entity ? [entity] : undefined,
              });
            }
          }

          // Auto-link to similar facts when enabled
          let autoLinked = 0;
          if (cfg.graph.enabled && cfg.graph.autoLink) {
            const entryScope = entry.scope ?? "global";
            const entryScopeTarget = entryScope === "global" ? null : (entry.scopeTarget ?? null);
            const similar = factsDb.findSimilarForClassification(
              textToStore,
              entity ?? null,
              key ?? null,
              cfg.graph.autoLinkLimit,
              entryScope,
              entryScopeTarget,
            );
            for (const s of similar) {
              if (s.id === entry.id) continue;
              factsDb.createLink(entry.id, s.id, "RELATED_TO", cfg.graph.autoLinkMinScore);
              autoLinked++;
            }
          }

          // Entity-based auto-linking (Issue #154): known-entity matching, IP NER,
          // temporal co-occurrence, and supersession detection.
          let entityAutoLinked = 0;
          let autoSupersededIds: string[] = [];
          if (cfg.graph.enabled && cfg.graph.autoLink) {
            const sessionId = api.context?.sessionId ?? null;
            const result = factsDb.autoLinkEntities(
              entry.id,
              textToStore,
              entity ?? null,
              key ?? null,
              sessionId,
              {
                coOccurrenceWeight: cfg.graph.coOccurrenceWeight,
                autoSupersede: cfg.graph.autoSupersede,
              },
              entry.scope ?? null,
              entry.scopeTarget ?? null,
            );
            entityAutoLinked = result.linkedCount;
            autoSupersededIds = result.supersededIds;
            if (autoSupersededIds.length > 0) {
              api.logger.info?.(
                `memory-hybrid: autoSupersede — superseded [${autoSupersededIds.join(", ")}] with ${entry.id}`,
              );
            }
          }

          // NER + contact/org layer (#985–#987): async enrichment after graph auto-link; uses franc + LLM.
          if (cfg.graph.enabled) {
            const enrichModel = getDefaultCronModel(getCronModelConfig(cfg), "nano");
            void extractEntityMentionsWithLlm(textToStore, openai, enrichModel, {
              stopWords: cfg.entityExtraction.stopWords,
            })
              .then(({ mentions, detectedLang }) => {
                factsDb.applyEntityEnrichment(entry.id, mentions, detectedLang);
              })
              .catch((err) => {
                const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
                api.logger.warn?.(`memory-hybrid: entity enrichment failed: ${msg}`);
              });
          }

          const totalLinked = autoLinked + entityAutoLinked;
          const verbosity = cfg.verbosity ?? "normal";
          let storedMsg: string;
          if (isCompactVerbosity(verbosity)) {
            // Quiet: only report the ID and any warnings (contradictions are important)
            storedMsg = `Stored: ${entry.id}${
              contradictions.length > 0
                ? ` (⚠️ contradicts ${contradictions.length} existing fact${contradictions.length === 1 ? "" : "s"})`
                : ""
            }`;
          } else {
            // normal / verbose: full details (verbose adds scope/category info)
            storedMsg = `Stored: "${textToStore.slice(0, 100)}${textToStore.length > 100 ? "..." : ""}"${entity ? ` [entity: ${entity}]` : ""} [decay: ${entry.decayClass}]${supersedes?.trim() ? " (supersedes previous fact)" : ""}${totalLinked > 0 ? ` (linked to ${totalLinked} related fact${totalLinked === 1 ? "" : "s"})` : ""}${
              autoSupersededIds.length > 0
                ? ` (auto-superseded ${autoSupersededIds.length} fact${autoSupersededIds.length === 1 ? "" : "s"})`
                : ""
            }${
              contradictions.length > 0
                ? ` (⚠️ contradicts ${contradictions.length} existing fact${contradictions.length === 1 ? "" : "s"})`
                : ""
            }`;
            if (verbosity === "verbose") {
              storedMsg += ` [id: ${entry.id}]`;
              if (entry.scope)
                storedMsg += ` [scope: ${entry.scope}${entry.scopeTarget ? `/${entry.scopeTarget}` : ""}]`;
            }
          }

          auditAppend({
            agentId: agentIdForAudit(),
            action: "memory_store",
            target: `memory #${entry.id}`,
            outcome: "success",
            sessionId: api.context?.sessionId ?? undefined,
            context: { category },
          });

          return {
            content: [
              {
                type: "text",
                text: storedMsg,
              },
            ],
            details: {
              action: supersedes?.trim() ? "updated" : "created",
              id: entry.id,
              why: why ?? undefined,
              backend: "both",
              decayClass: entry.decayClass,
              ...(supersedes?.trim() ? { superseded: supersedes.trim() } : {}),
              ...(totalLinked > 0 ? { autoLinked: totalLinked } : {}),
              ...(autoSupersededIds.length > 0 ? { autoSuperseded: autoSupersededIds } : {}),
              ...(contradictions.length > 0
                ? {
                    contradictions: contradictions.map((c) => ({
                      contradictionId: c.contradictionId,
                      oldFactId: c.oldFactId,
                    })),
                  }
                : {}),
              ...(decayFreezeUntil != null ? { decayFreezeUntil } : {}),
            },
          };
        } catch (err) {
          auditAppend({
            agentId: agentIdForAudit(),
            action: "memory_store",
            target: undefined,
            outcome: "failed",
            error: err instanceof Error ? err.message : String(err),
            sessionId: api.context?.sessionId ?? undefined,
          });
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "memory",
            operation: "memory-store",
            phase: "runtime",
          });
          throw err;
        }
      },
    },
    { name: "memory_store" },
  );
}
