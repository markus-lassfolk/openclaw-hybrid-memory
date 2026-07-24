/**
 * Memory Tool Registrations
 *
 * Tool definitions for memory recall, storage, promotion, and deletion.
 * Extracted from index.ts for better modularity.
 */

import { Type } from "@sinclair/typebox";
import { categoryToEventType } from "../../backends/event-log.js";
import { resolveWriteVectorCandidates } from "../../cli/vector-dedupe-helpers.js";
import {
  DECAY_CLASSES,
  type DecayClass,
  getCronModelConfig,
  getDefaultCronModel,
  getMemoryCategories,
  isCompactVerbosity,
  type MemoryCategory,
} from "../../config.js";
import { isStructuredCredentialCandidate, tryParseCredentialForVault } from "../../services/auto-capture.js";
import { classifyMemoryOperation } from "../../services/classification.js";
import { matchesExactScope, validateScopedClassificationTarget } from "../../services/classification-scope.js";
import {
  abortCredentialVaultWriteOnPointerDedupe,
  buildCredentialPointerText,
  ensureCredentialVaultPointer,
  rollbackVaultCredentialWrite,
} from "../../services/credential-vault-pointer.js";
import { AllEmbeddingProvidersFailed, shouldSuppressEmbeddingError } from "../../services/embeddings.js";
import { extractEntityMentionsWithLlm } from "../../services/entity-enrichment.js";
import { addOperationBreadcrumb, capturePluginError } from "../../services/error-reporter.js";
import { extractStructuredFields } from "../../services/fact-extraction.js";
import { emitFeatureTelemetry } from "../../services/feature-telemetry.js";
import { autoLinkSemanticallySimilarFacts } from "../../services/graph-autolink.js";
import { claimInlineEnrichment } from "../../services/post-store-enrichment.js";
import {
  isSubstantiveMemoryText,
  prepareMemoryMetadataForStorage,
  prepareMemoryTextForStorage,
} from "../../services/recalled-context-assembler.js";
import { storeAliases } from "../../services/retrieval-aliases.js";
import { normalizeSupersedesInput } from "../../services/supersedes-input.js";
import { mirrorMemoryStoreToActiveTaskLedger } from "../../services/task-ledger-facts.js";
import { guardAgainstWrapperArgsDropped } from "../../services/tool-args-guard.js";
import { cleanupEvictedVector, deleteVectorForFactId } from "../../services/vector-maintenance.js";
import { shouldAutoVerify } from "../../services/verification-store.js";
import {
  isWalWriteFailure,
  walRemove as walRemoveEntry,
  walWrite as walWriteEntry,
} from "../../services/wal-helpers.js";
import type { MemoryEntry } from "../../types/memory.js";
import { MEMORY_SCOPES } from "../../types/memory.js";
import { detectFutureDate } from "../../utils/date-detector.js";
import { nowIso } from "../../utils/dates.js";
import { embedCallWithTimeoutAndRetry } from "../../utils/embed-call.js";
import { isSystemSenderEmail } from "../../utils/system-sender-email.js";
import { extractTags } from "../../utils/tags.js";
import { stringEnum } from "../../utils/typebox.js";
import type { MemoryToolRuntime } from "./runtime.js";
import { resolveToolVaultBackends, resolveToolVaultWal } from "./vault-resolve.js";

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
    wal,
    walWrite,
    walRemove,
  } = runtime;

  const writeStoreWal = (
    storeWal: ReturnType<typeof resolveToolVaultWal>,
    operation: "store" | "update",
    data: Record<string, unknown>,
    supersedeTargetId?: string,
  ) => {
    if (storeWal != null && storeWal !== wal) {
      return walWriteEntry(storeWal, operation, data, api.logger, supersedeTargetId);
    }
    return walWrite(operation, data, api.logger, supersedeTargetId);
  };

  const removeStoreWal = (storeWal: ReturnType<typeof resolveToolVaultWal>, id: string) => {
    if (storeWal != null && storeWal !== wal) {
      return walRemoveEntry(storeWal, id, api.logger);
    }
    return walRemove(id, api.logger);
  };

  const storeWalWriteFailed = (storeWal: ReturnType<typeof resolveToolVaultWal>, walEntryId: string | null) => {
    const walRef = storeWal != null && storeWal !== wal ? storeWal : wal;
    return isWalWriteFailure(walRef, walEntryId);
  };

  const walWriteFailedResponse = () => ({
    content: [
      {
        type: "text" as const,
        text: "Store aborted: WAL durability write failed. Resolve WAL storage issues before storing.",
      },
    ],
    details: { error: "wal_write_failed" },
  });

  const syncProjectStoreToActiveTaskLedger = async (opts: {
    category: string;
    entity?: string | null;
    key?: string | null;
    value?: string | null;
    scope?: string | null;
    /** Vault-resolved backends — required so a project-task fact stored in a named vault mirrors
     * to that same vault's ledger, not the plugin's default vault. */
    factsDb?: typeof factsDb;
    vectorDb?: typeof vectorDb;
  }): Promise<{ synced: boolean; autoTaskUpdated: boolean }> => {
    try {
      return await mirrorMemoryStoreToActiveTaskLedger({
        factsDb: opts.factsDb ?? factsDb,
        vectorDb: opts.vectorDb ?? vectorDb,
        embeddings,
        activeTaskEnabled: cfg.activeTask?.enabled === true && cfg.activeTask.ledger === "facts",
        category: opts.category,
        entity: opts.entity,
        key: opts.key,
        value: opts.value,
        scope: opts.scope,
        log: api.logger,
      });
    } catch (err) {
      api.logger?.warn?.(
        `memory-hybrid: active-task ledger mirror failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { synced: false, autoTaskUpdated: false };
    }
  };

  api.registerTool(
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information in long-term memory. Stores to both structured (SQLite) and semantic (LanceDB) backends. When entity+key+value are present, runs contradiction detection (serialized via DB lock; nightly dream-cycle repair backfills any missed pairs).",
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
          Type.Union([Type.String(), Type.Array(Type.String())], {
            description:
              "Fact id — or an array of fact ids — this one supersedes (replaces). Marks the old fact(s) as superseded and links the new one.",
          }),
        ),
        expectedHash: Type.Optional(
          Type.String({
            description:
              "OCC token from a prior read (FactsDB.getOccToken). When set on shared-scope supersedes, refuse with memory_conflict if the target changed (#2175).",
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
        vault: Type.Optional(Type.String({ description: "Named vault from plugin config vaults map" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const dropped = guardAgainstWrapperArgsDropped("memory_store", params, api.logger);
          if (dropped) return dropped;
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
            expectedHash,
            scope: paramScope,
            scopeTarget: paramScopeTarget,
            verification_tier: verificationTier,
            decayFreezeUntil: paramDecayFreezeUntil,
            vault: vaultParam,
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
            supersedes?: string | string[];
            expectedHash?: string;
            scope?: "global" | "user" | "agent" | "session";
            scopeTarget?: string;
            verification_tier?: string;
            decayFreezeUntil?: number;
            vault?: string;
          };

          const { factsDb: storeFactsDb, vectorDb: storeVectorDb } = resolveToolVaultBackends(
            runtime,
            typeof vaultParam === "string" ? vaultParam : undefined,
          );
          const storeWal = resolveToolVaultWal(runtime, typeof vaultParam === "string" ? vaultParam : undefined);

          // --- Early input validation (must run before any side effects) ---
          const trimmedText = typeof text === "string" ? text.trim() : "";
          if (trimmedText.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "memory_store: text is required and must be non-empty (received empty or non-string text)",
                },
              ],
              details: { error: "invalid_text" },
            };
          }

          const textToStore = prepareMemoryTextForStorage(trimmedText, cfg.captureMaxChars);
          if (!textToStore || !isSubstantiveMemoryText(textToStore)) {
            return {
              content: [
                {
                  type: "text",
                  text: "memory_store: text is empty after sanitization (prompt-injection markers removed).",
                },
              ],
              details: { error: "invalid_text" },
            };
          }
          const whyStored = prepareMemoryMetadataForStorage(why);

          const importanceValue = importance as number;
          if (!Number.isFinite(importanceValue) || importanceValue < 0 || importanceValue > 1) {
            return {
              content: [
                {
                  type: "text",
                  text: `memory_store: importance must be a finite number in [0, 1]; got ${importanceValue}.`,
                },
              ],
              details: { error: "invalid_importance" },
            };
          }

          if (paramDecayFreezeUntil != null && (!Number.isFinite(paramDecayFreezeUntil) || paramDecayFreezeUntil < 0)) {
            return {
              content: [
                {
                  type: "text",
                  text: `memory_store: decayFreezeUntil must be a non-negative finite epoch seconds value; got ${paramDecayFreezeUntil}.`,
                },
              ],
              details: { error: "invalid_decay_freeze_until" },
            };
          }

          // `supersedes` may arrive as a string or an array of fact ids (the runtime does not
          // enforce the TypeBox schema); normalize once here so no downstream code calls `.trim`
          // on a non-string (#2139). A malformed shape yields a structured validation error rather
          // than a raw `supersedes?.trim is not a function` exception.
          const supersedesNorm = normalizeSupersedesInput(supersedes);
          if (!supersedesNorm.ok) {
            return {
              content: [{ type: "text", text: `memory_store: ${supersedesNorm.error}.` }],
              details: { error: "invalid_supersedes" },
            };
          }
          const supersedesIds = supersedesNorm.ids;
          const hasSupersedes = supersedesIds.length > 0;
          // --- End early validation ---

          const provenanceSessionId = api.context?.sessionId ?? null;
          const recordActiveStoreProvenance = (factId: string, sourceText?: string) => {
            if (!provenanceService || cfg.provenance?.enabled !== true) return;
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
          const entity =
            prepareMemoryMetadataForStorage(paramEntity) ?? prepareMemoryMetadataForStorage(extracted.entity);
          const rawKey = prepareMemoryMetadataForStorage(paramKey) ?? prepareMemoryMetadataForStorage(extracted.key);
          const rawValue =
            prepareMemoryMetadataForStorage(paramValue) ?? prepareMemoryMetadataForStorage(extracted.value);
          // #2062: an LLM-supplied key/value pair bypasses extractStructuredFields' own blocklist
          // entirely (paramKey/paramValue win via `??` above) — apply the same system-sender guard
          // here, mirroring cmd-distill.ts's identical guard on the LLM-sourced distill path.
          const rejectSystemSenderEmail = rawKey?.toLowerCase() === "email" && isSystemSenderEmail(rawValue);
          const key = rejectSystemSenderEmail ? null : rawKey;
          const value = rejectSystemSenderEmail ? null : rawValue;

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

          // Resolve final scope before classify-before-write and WAL so scoped metadata is complete (issue #1574).
          if (paramScope) {
            scope = paramScope;
            scopeTarget = scope === "global" ? null : (paramScopeTarget?.trim() ?? null);
          } else {
            const agentId = currentAgentIdRef.value || cfg.multiAgent.orchestratorId;
            const isOrchestrator = agentId === cfg.multiAgent.orchestratorId;

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
              scope = "global";
              scopeTarget = null;
            } else if (cfg.multiAgent.defaultStoreScope === "agent") {
              scope = "agent";
              scopeTarget = agentId;
            } else if (isOrchestrator) {
              scope = "global";
              scopeTarget = null;
            } else {
              scope = "agent";
              scopeTarget = agentId;
            }
          }

          if (scope !== "global" && !scopeTarget) {
            if (paramScope) {
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
            scope = "global";
            scopeTarget = null;
          }

          // Scope-aware duplicate pre-check (must run after scope resolution above): dedupe state
          // must never be shared across scopes, or an agent/user-scoped store can be wrongly
          // rejected as "duplicate" against an unrelated global fact with the same text (or vice
          // versa) — see the scope guard in services/dedupe-policy.ts's applyDedupe().
          if (
            storeFactsDb.hasDuplicate(textToStore, "conversation", { category, entity, key, value }, scope, scopeTarget)
          ) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Similar memory already exists. Do not retry memory_store with the same text. " +
                    "Use memory_recall to verify what is stored, or memory_forget to remove an incorrect fact before storing a correction.",
                },
              ],
              details: { action: "duplicate" },
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
            entryScope?: "global" | "user" | "agent" | "session" | null,
            entryScopeTarget?: string | null,
          ) => {
            if (!cfg.verification?.enabled || !verificationStore) return;
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
              verificationStore.verify(factId, factText, verifiedBy, entryScope, entryScopeTarget);
            } catch (err) {
              api.logger.warn?.(`memory-hybrid: auto-verify failed for ${factId}: ${err}`);
            }
          };

          const parsedCredential = tryParseCredentialForVault(textToStore, entity, key, value, {
            requirePatternMatch: cfg.credentials.autoCapture?.requirePatternMatch === true,
          });
          if (parsedCredential) {
            const parsed = parsedCredential;
            if (cfg.credentials.enabled && credentialsDb) {
              let storedInVault = false;
              try {
                storedInVault =
                  credentialsDb.storeIfNew({
                    service: parsed.service,
                    type: parsed.type,
                    value: parsed.secretValue,
                    url: parsed.url,
                    notes: parsed.notes,
                  }) != null;
              } catch (err) {
                capturePluginError(err instanceof Error ? err : new Error(String(err)), {
                  subsystem: "memory-tools",
                  operation: "memory-store:credential-vault-store",
                });
                auditAppend({
                  agentId: agentIdForAudit(),
                  action: "memory_store",
                  outcome: "failed",
                  error: "credential vault store failed",
                  sessionId: api.context?.sessionId ?? undefined,
                });
                return {
                  content: [{ type: "text", text: "Credential vault store failed." }],
                  details: { action: "credential_vault_error" },
                };
              }

              const pointer = ensureCredentialVaultPointer(storeFactsDb, parsed.service, parsed.type, "conversation", {
                why: whyStored,
                importance,
                decayClass: paramDecayClass ?? "permanent",
                provenanceSession: provenanceSessionId,
                extractionMethod: "active",
                extractionConfidence: importance,
              });
              if (!pointer.ok) {
                if (storedInVault) {
                  rollbackVaultCredentialWrite(credentialsDb, parsed.service, parsed.type);
                }
                auditAppend({
                  agentId: agentIdForAudit(),
                  action: "memory_store",
                  outcome: "failed",
                  error: "credential rejected by pre-store guard",
                  sessionId: api.context?.sessionId ?? undefined,
                });
                return {
                  content: [{ type: "text", text: "Credential-like content rejected by pre-store guard." }],
                  details: { action: "credential_rejected_artifact" },
                };
              }
              const pointerEntry = pointer.entry;
              if (
                abortCredentialVaultWriteOnPointerDedupe(
                  storedInVault,
                  pointer,
                  credentialsDb,
                  parsed.service,
                  parsed.type,
                )
              ) {
                auditAppend({
                  agentId: agentIdForAudit(),
                  action: "memory_store",
                  target: `memory #${pointerEntry.id}`,
                  outcome: "partial",
                  sessionId: api.context?.sessionId ?? undefined,
                  context: { credentialDuplicate: true, service: parsed.service },
                });
                return {
                  content: [
                    {
                      type: "text",
                      text: `Credential already in vault for ${parsed.service} (${parsed.type}).`,
                    },
                  ],
                  details: {
                    action: "credential_skipped_duplicate",
                    id: pointerEntry.id,
                    service: parsed.service,
                    type: parsed.type,
                  },
                };
              }
              await cleanupEvictedVector({
                vectorDb: storeVectorDb,
                evictedFactId: pointer.evictedFactId,
                logger: api.logger,
                context: "memory-store-credential-pointer",
              });
              const pointerText = buildCredentialPointerText(parsed.service, parsed.type);
              if (pointer.newlyStored) {
                recordActiveStoreProvenance(pointerEntry.id, pointerText);
              }
              if (pointer.newlyStored || pointer.embeddingStale) {
                try {
                  addOperationBreadcrumb("vector", "store-credential-pointer");
                  const vector = await embedCallWithTimeoutAndRetry(
                    () => embeddings.embed(pointerText),
                    "memory-tools:store-credential-pointer",
                  );
                  await storeActiveCanonicalVector({
                    factId: pointerEntry.id,
                    text: pointerText,
                    why: whyStored,
                    vector,
                    importance,
                    category: "technical",
                    factsDb: storeFactsDb,
                    vectorDb: storeVectorDb,
                  });
                  await storeRegistryEmbeddings({
                    factsDb: storeFactsDb,
                    embeddingRegistry,
                    embeddings,
                    factId: pointerEntry.id,
                    text: pointerText,
                    vector,
                    logger: api.logger,
                    operation: "store-credential-pointer",
                  });
                } catch (err) {
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
              }
              auditAppend({
                agentId: agentIdForAudit(),
                action: "memory_store",
                target: `memory #${pointerEntry.id}`,
                outcome: "partial",
                sessionId: api.context?.sessionId ?? undefined,
                context: { category: "technical", credentialType: parsed.type, service: parsed.service },
              });
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
            auditAppend({
              agentId: agentIdForAudit(),
              action: "memory_store",
              outcome: "failed",
              error: "credential vault disabled or unavailable",
              sessionId: api.context?.sessionId ?? undefined,
            });
            return {
              content: [
                {
                  type: "text",
                  text: "Credential-like content detected. Ordinary memory storage is blocked while the credential vault is disabled or unavailable. Enable credentials vault and retry.",
                },
              ],
              details: { action: "credential_blocked_no_vault" },
            };
          }

          // When requirePatternMatch rejects vault parsing but the input is still credential-like,
          // block ordinary storage to prevent plaintext secrets in facts.db (#1896).
          if (
            !parsedCredential &&
            cfg.credentials.autoCapture?.requirePatternMatch === true &&
            isStructuredCredentialCandidate(textToStore, entity, key, value)
          ) {
            auditAppend({
              agentId: agentIdForAudit(),
              action: "memory_store",
              outcome: "failed",
              error: "credential-like content blocked by requirePatternMatch",
              sessionId: api.context?.sessionId ?? undefined,
            });
            return {
              content: [
                {
                  type: "text",
                  text: "Credential-like content detected but no recognizable secret pattern was found (requirePatternMatch is enabled). Store using a known credential format or disable requirePatternMatch.",
                },
              ],
              details: { action: "credential_blocked_require_pattern_match" },
            };
          }

          const tags =
            paramTags && paramTags.length > 0
              ? paramTags
                  .map((t) => prepareMemoryMetadataForStorage(t.trim().toLowerCase()))
                  .filter((t): t is string => Boolean(t))
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
              similarFacts = await findSimilarByEmbedding(storeVectorDb, storeFactsDb, vector, 5, 0.3, {
                scope,
                scopeTarget,
              });
            }
            if (similarFacts.length === 0) {
              similarFacts = storeFactsDb.findSimilarForClassification(
                textToStore,
                entity ?? null,
                key ?? null,
                5,
                scope,
                scopeTarget,
              );
            }
            if (similarFacts.length > 0) {
              const classification = await classifyMemoryOperation(
                textToStore,
                entity ?? null,
                key ?? null,
                similarFacts,
                openai,
                cfg.store.classifyModel ?? getDefaultCronModel(getCronModelConfig(cfg), "nano"),
                api.logger,
              );

              if (classification.action === "NOOP") {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Already known: ${classification.reason}. Do not retry memory_store — use memory_recall to verify or memory_forget to supersede an incorrect fact.`,
                    },
                  ],
                  details: { action: "noop", reason: classification.reason },
                };
              }

              if (classification.action === "DELETE" && classification.targetId) {
                const target = validateScopedClassificationTarget({
                  targetId: classification.targetId,
                  candidates: similarFacts,
                  getById: (id) => storeFactsDb.getById(id),
                  scope,
                  scopeTarget,
                  warn: (message) => api.logger.warn?.(message),
                  warnMessage: `memory-hybrid: blocked cross-scope or unknown memory_store DELETE target ${classification.targetId}`,
                });
                if (target) {
                  storeFactsDb.supersede(classification.targetId, null);
                  aliasDb?.deleteByFactId(classification.targetId);
                  await deleteVectorForFactId({
                    vectorDb: storeVectorDb,
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
                  getById: (id) => storeFactsDb.getById(id),
                  scope,
                  scopeTarget,
                  warn: (message) => api.logger.warn?.(message),
                  warnMessage: `memory-hybrid: blocked cross-scope or unknown memory_store UPDATE target ${classification.targetId}`,
                });
                if (oldFact) {
                  const walEntryId = await writeStoreWal(
                    storeWal,
                    "update",
                    {
                      text: textToStore,
                      why: whyStored,
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
                    classification.targetId,
                  );
                  if (storeWalWriteFailed(storeWal, walEntryId)) {
                    return walWriteFailedResponse();
                  }

                  const nowSec = Math.floor(Date.now() / 1000);
                  const updateStoreResult = storeFactsDb.storeWithResult({
                    text: textToStore,
                    why: whyStored,
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
                  // Guard: skip post-store ops when pre-store guard blocked the write (#1560, #1561)
                  if (
                    !updateStoreResult.skipped &&
                    updateStoreResult.newlyStored === false &&
                    !updateStoreResult.embeddingStale
                  ) {
                    if (walEntryId) await removeStoreWal(storeWal, walEntryId);
                    return {
                      content: [
                        {
                          type: "text",
                          text: `Update deduplicated to existing fact — target ${classification.targetId.slice(0, 8)} not superseded.`,
                        },
                      ],
                      details: { action: "noop", reason: "dedupe-update", id: newEntry.id },
                    };
                  }
                  if (
                    !updateStoreResult.skipped &&
                    updateStoreResult.newlyStored === false &&
                    updateStoreResult.embeddingStale
                  ) {
                    await cleanupEvictedVector({
                      vectorDb: storeVectorDb,
                      evictedFactId: updateStoreResult.evictedFactId,
                      logger: api.logger,
                      context: "memory-store-update-merge",
                    });
                    try {
                      const mergedVector = await embeddings.embed(newEntry.text);
                      storeFactsDb.setEmbeddingModel(newEntry.id, embeddings.modelName);
                      await storeActiveCanonicalVector({
                        factId: newEntry.id,
                        text: newEntry.text,
                        why: whyStored,
                        vector: mergedVector,
                        importance: Math.max(importance, oldFact.importance),
                        category,
                        factsDb: storeFactsDb,
                        vectorDb: storeVectorDb,
                      });
                    } catch (err) {
                      api.logger.warn(`memory-hybrid: UPDATE merge vector refresh failed: ${err}`);
                    }
                    if (walEntryId) await removeStoreWal(storeWal, walEntryId);
                    return {
                      content: [
                        {
                          type: "text",
                          text: `Update merged into existing fact ${newEntry.id.slice(0, 8)} — target not superseded.`,
                        },
                      ],
                      details: { action: "noop", reason: "dedupe-merge", id: newEntry.id },
                    };
                  }
                  if (!updateStoreResult.skipped && updateStoreResult.newlyStored) {
                    await cleanupEvictedVector({
                      vectorDb: storeVectorDb,
                      evictedFactId: updateStoreResult.evictedFactId,
                      logger: api.logger,
                      context: "memory-store-update",
                    });
                    recordActiveStoreProvenance(newEntry.id, textToStore);
                    storeFactsDb.supersede(classification.targetId, newEntry.id);
                    aliasDb?.deleteByFactId(classification.targetId);
                    await deleteVectorForFactId({
                      vectorDb: storeVectorDb,
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
                      newEntry.scope,
                      newEntry.scopeTarget,
                    );

                    const finalImportance = Math.max(importance, oldFact.importance);
                    try {
                      if (vector) {
                        await storeActiveCanonicalVector({
                          factId: newEntry.id,
                          text: textToStore,
                          why: whyStored,
                          vector,
                          importance: finalImportance,
                          category,
                          factsDb: storeFactsDb,
                          vectorDb: storeVectorDb,
                        });
                      }
                      await storeRegistryEmbeddings({
                        factsDb: storeFactsDb,
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

                    await syncProjectStoreToActiveTaskLedger({
                      category: newEntry.category,
                      entity,
                      key,
                      value,
                      scope: newEntry.scope,
                      factsDb: storeFactsDb,
                      vectorDb: storeVectorDb,
                    });
                    await maybeRefreshProjectActiveTaskProjection(
                      newEntry.category,
                      newEntry.id,
                      newEntry.scope,
                      storeFactsDb,
                    );

                    // Issue #159: enqueue contextual variant generation (non-blocking)
                    if (variantQueue) {
                      variantQueue.enqueue({ factId: newEntry.id, text: textToStore, category: category as string });
                    }

                    api.logger.info?.(
                      `memory-hybrid: UPDATE — superseded ${classification.targetId} with ${newEntry.id}: ${classification.reason}`,
                    );
                    if (walEntryId) await removeStoreWal(storeWal, walEntryId);
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
                        why: whyStored ?? undefined,
                        superseded: classification.targetId,
                        reason: classification.reason,
                        backend: "both",
                        decayClass: newEntry.decayClass,
                      },
                    };
                  }
                  // WAL cleanup for skipped update path
                  if (walEntryId) await removeStoreWal(storeWal, walEntryId);
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Store blocked by pre-store guard (category: ${category}).`,
                      },
                    ],
                    details: { action: "skipped", reason: "blocked-by-guard", category },
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

          // Scope was resolved above (before classify-before-write) for WAL and classification consistency.

          const walEntryId = await writeStoreWal(storeWal, "store", {
            text: textToStore,
            why: whyStored,
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
            embeddingModelName: vector ? embeddings.modelName : undefined,
            scope,
            scopeTarget,
          });
          if (storeWalWriteFailed(storeWal, walEntryId)) {
            return walWriteFailedResponse();
          }
          const decayFreezeUntil =
            paramDecayFreezeUntil != null && Number.isFinite(paramDecayFreezeUntil)
              ? paramDecayFreezeUntil
              : detectFutureDate(textToStore, cfg.futureDateProtection ?? { enabled: false });

          const nowSec = Math.floor(Date.now() / 1000);
          const storeSessionId = api.context?.sessionId ?? null;

          // Resolve which requested `supersedes` targets are actually in-scope BEFORE the write, so
          // (a) the persisted `supersedes_id` lineage points only at a real in-scope target rather
          // than a phantom cross-scope/unknown id, and (b) callers get told which ids were blocked
          // instead of silently losing them (#2139 QA). Cross-scope / unknown ids are surfaced in
          // the response, never applied. Mirrors the classify-before-write UPDATE path, which also
          // validates scope before setting supersedesId.
          const supersedesScopeValid: string[] = [];
          const supersedesBlocked: string[] = [];
          for (const supersededId of supersedesIds) {
            const target = storeFactsDb.getById(supersededId);
            if (target && matchesExactScope(target, scope, scopeTarget)) {
              supersedesScopeValid.push(supersededId);
            } else {
              supersedesBlocked.push(supersededId);
              api.logger.warn?.(
                `memory-hybrid: blocked cross-scope or unknown memory_store supersedes target ${supersededId}`,
              );
            }
          }
          const primarySupersedesId = supersedesScopeValid[0] ?? null;

          // Plumb vector neighbour candidates into write-time dedupe so the configured vectorThreshold
          // actually runs on the live store path instead of silently degrading to lexical-only (#2027).
          // Reuses the already-computed embedding; candidates are source/scope filtered.
          //
          // Skip when the caller passed an explicit `supersedes`: the intent is to replace a specific
          // fact with this (usually near-identical) corrected text. Semantic vector dedupe would match
          // the supersede target itself (cosine ≥ threshold), return skip, and drop the supersession —
          // silently losing the update. An explicit supersede must always store, so we do not widen
          // write-time fuzzy dedupe on that path (matches pre-#2027 behaviour for supersede writes).
          let storeVectorCandidates: ReadonlyArray<{ id: string; score: number }> | undefined;
          if (cfg.store.fuzzyDedupe && vector && !hasSupersedes) {
            const resolvedCandidates = await resolveWriteVectorCandidates({
              fuzzyDedupe: true,
              vector,
              vectorDb: storeVectorDb,
              factsDb: storeFactsDb,
              source: "conversation",
              embeddingModelName: typeof embeddings.modelName === "string" ? embeddings.modelName : null,
              candidateScope: scope,
              candidateScopeTarget: scopeTarget,
            });
            storeVectorCandidates = resolvedCandidates.vectorCandidates;
          }
          const storeResult = storeFactsDb.storeWithResult(
            {
              text: textToStore,
              why: whyStored,
              category: category as MemoryCategory,
              importance,
              entity: entity ?? null,
              key: key ?? null,
              value: value ?? null,
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
              ...(primarySupersedesId ? { validFrom: nowSec, supersedesId: primarySupersedesId } : {}),
            },
            { vectorCandidates: storeVectorCandidates, warnContext: "memory-store" },
          );
          const entry = storeResult.entry;
          // Claim the id with the universal post-store enricher SYNCHRONOUSLY, before any await:
          // storeWithResult() above already queued a "factStored" microtask (memory-events.ts's
          // emitMemoryEvent uses queueMicrotask), which runs at the very next await/yield point —
          // claiming later (e.g. right before the inline auto-link call below, past several
          // intervening awaits) always loses that race, so post-store-enrichment.ts's subscriber
          // never sees the claim and double-links every newly stored fact. Mirror the exact guard
          // emitMemoryEvent uses (facts-db-layer1.ts) so we only ever claim ids that actually get
          // a factStored event.
          if (!storeResult.skipped && storeResult.newlyStored && cfg.graph.enabled && cfg.graph.autoLink) {
            claimInlineEnrichment(entry.id);
          }
          if (!storeResult.skipped && storeResult.newlyStored === false && !storeResult.embeddingStale) {
            if (walEntryId) await removeStoreWal(storeWal, walEntryId);
            return {
              content: [
                {
                  type: "text",
                  text: `Deduped to existing fact ${entry.id.slice(0, 8)} — no new store.`,
                },
              ],
              details: { action: "noop", reason: "dedupe", id: entry.id },
            };
          }
          // Guard: skip post-store ops when pre-store guard blocked the write (#1560, #1561)
          if (!storeResult.skipped) {
            await cleanupEvictedVector({
              vectorDb: storeVectorDb,
              evictedFactId: storeResult.evictedFactId,
              logger: api.logger,
              context: "memory-store",
            });
            if (storeResult.newlyStored) {
              recordActiveStoreProvenance(entry.id, textToStore);
              // Mirrors the classify-before-write UPDATE branch above — without this, the normal
              // ADD path (the vast majority of memory_store calls) never enrolls a fact in
              // verificationStore, so verification_tier:"critical" and cfg.verification.autoClassify
              // silently no-op for every genuinely new fact.
              maybeAutoVerify(
                entry.id,
                textToStore,
                entry.tags ?? tags,
                entry.entity,
                entry.key,
                entry.value,
                entry.scope,
                entry.scopeTarget,
              );
            }
            // Apply the supersession to each pre-validated in-scope target (scope was checked before
            // the write). `supersede()`'s `superseded_at IS NULL` guard keeps `applied` honest — a
            // target already superseded by an earlier write is not double-counted. Only runs when a
            // genuinely new fact was created; a dedupe-merge (newlyStored === false) never applies
            // the request. Out-of-scope/unknown ids were already collected in supersedesBlocked.
            const supersededAppliedIds: string[] = [];
            if (storeResult.newlyStored) {
              const occHash =
                typeof expectedHash === "string" && expectedHash.trim().length > 0 ? expectedHash.trim() : undefined;
              try {
                for (const supersededId of supersedesScopeValid) {
                  const applied = storeFactsDb.supersede(
                    supersededId,
                    entry.id,
                    occHash ? { expectedHash: occHash } : undefined,
                  );
                  if (applied) {
                    supersededAppliedIds.push(supersededId);
                    aliasDb?.deleteByFactId(supersededId);
                    await deleteVectorForFactId({
                      vectorDb: storeVectorDb,
                      factId: supersededId,
                      logger: api.logger,
                      context: "store-manual-supersede",
                    });
                  }
                }
              } catch (occErr) {
                const { MemoryConflictError } = await import("../../utils/fact-occ.js");
                if (occErr instanceof MemoryConflictError) {
                  return {
                    content: [
                      {
                        type: "text",
                        text: `memory_store: ${occErr.message}. Re-read the fact and retry with a fresh expectedHash.`,
                      },
                    ],
                    details: occErr.details,
                  };
                }
                throw occErr;
              }
            }

            try {
              addOperationBreadcrumb("vector", "store-fact");
              // When storeWithResult merged this call's text onto an existing fact
              // (newlyStored: false, embeddingStale: true), entry.text is the ACTUAL persisted
              // content (existing.text + "\n" + textToStore, truncated) — not textToStore alone.
              // Re-embed from entry.text so the vector backend encodes the same content as the
              // fact row, instead of leaving a vector embedded from only the newly-added text
              // fragment (mirrors the classify-before-write UPDATE merge branch above).
              const isMerge = storeResult.newlyStored === false && storeResult.embeddingStale === true;
              const vectorText = isMerge ? entry.text : textToStore;
              const vectorForStore = isMerge ? await embeddings.embed(entry.text) : vector;
              if (isMerge) {
                storeFactsDb.setEmbeddingModel(entry.id, embeddings.modelName);
              }
              if (vectorForStore) {
                await storeActiveCanonicalVector({
                  factId: entry.id,
                  text: vectorText,
                  why: whyStored,
                  vector: vectorForStore,
                  importance,
                  category,
                  factsDb: storeFactsDb,
                  vectorDb: storeVectorDb,
                });
              }
              await storeRegistryEmbeddings({
                factsDb: storeFactsDb,
                embeddingRegistry,
                embeddings,
                factId: entry.id,
                text: vectorText,
                vector: vectorForStore,
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

            if (
              storeResult.newlyStored &&
              cfg.lifecycle?.fragmentEmbedding?.enabled === true &&
              textToStore.length >= (cfg.lifecycle?.fragmentEmbedding?.minChars ?? 6000)
            ) {
              setImmediate(() => {
                void import("../../services/fragment-embedding.js")
                  .then(({ indexFactFragments }) =>
                    indexFactFragments({
                      factsDb: storeFactsDb,
                      vectorDb: storeVectorDb,
                      embeddings,
                      parentFact: entry,
                      cfg: cfg.lifecycle!.fragmentEmbedding!,
                      logger: api.logger,
                    }),
                  )
                  .catch((err) => {
                    api.logger.warn?.(`memory-hybrid: fragment indexing failed: ${err}`);
                  });
              });
            }

            const ledgerMirror = await syncProjectStoreToActiveTaskLedger({
              category: entry.category,
              entity,
              key,
              value,
              scope: entry.scope,
              factsDb: storeFactsDb,
              vectorDb: storeVectorDb,
            });
            await maybeRefreshProjectActiveTaskProjection(entry.category, entry.id, entry.scope, storeFactsDb);

            // Issue #150: write event to episodic event log
            if (eventLog) {
              try {
                const eventType = categoryToEventType(category);
                eventLog.append({
                  sessionId: api.context?.sessionId ?? "unknown",
                  timestamp: nowIso(),
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
            // Uses BEGIN IMMEDIATE inside detectContradictions to serialize with concurrent writers.
            // On failure, store still succeeds; nightly repair + fallback will retry.
            const contradictionStarted = Date.now();
            let contradictions: ReturnType<typeof storeFactsDb.detectContradictions> = [];
            let contradictionDetectFailed = false;
            try {
              contradictions = storeFactsDb.detectContradictions(
                entry.id,
                entity ?? null,
                key ?? null,
                value ?? null,
                entry.scope ?? null,
                entry.scopeTarget ?? null,
                textToStore,
              );
            } catch (contradictionErr) {
              contradictionDetectFailed = true;
              capturePluginError(
                contradictionErr instanceof Error ? contradictionErr : new Error(String(contradictionErr)),
                {
                  subsystem: "memory",
                  operation: "memory-store-contradiction-detect",
                  phase: "runtime",
                },
              );
              emitFeatureTelemetry(api.logger, {
                feature: "contradiction",
                operation: "memory_store_detect",
                durationMs: Date.now() - contradictionStarted,
                warnBudgetMs: cfg.retrieval.contradictionLatencyWarnMs,
                outcome: "error",
                fields: {
                  entity: entity ?? null,
                  key: key ?? null,
                  deferred_to_repair: true,
                },
              });
            }
            if (!contradictionDetectFailed) {
              emitFeatureTelemetry(api.logger, {
                feature: "contradiction",
                operation: "memory_store_detect",
                durationMs: Date.now() - contradictionStarted,
                warnBudgetMs: cfg.retrieval.contradictionLatencyWarnMs,
                outcome: "ok",
                fields: {
                  hit_count: contradictions.length,
                  entity: entity ?? null,
                  key: key ?? null,
                },
              });
            }
            for (const { contradictionId, oldFactId } of contradictions) {
              if (eventLog) {
                eventLog.append({
                  sessionId: api.context?.sessionId ?? "unknown",
                  timestamp: nowIso(),
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

            // Auto-link to similar facts when enabled (embedding-gated when vector available).
            // This path owns the freshly computed vector, so it links inline and the subscriber
            // must not repeat it — claimed synchronously above, right after storeWithResult().
            let autoLinked = 0;
            if (cfg.graph.enabled && cfg.graph.autoLink) {
              const entryScope = entry.scope ?? "global";
              const entryScopeTarget = entryScope === "global" ? null : (entry.scopeTarget ?? null);
              autoLinked = await autoLinkSemanticallySimilarFacts(
                {
                  factsDb: storeFactsDb,
                  vectorDb: storeVectorDb,
                  vector,
                  text: textToStore,
                  entity: entity ?? null,
                  key: key ?? null,
                  newFactId: entry.id,
                  scope: entryScope,
                  scopeTarget: entryScopeTarget,
                },
                cfg.graph,
              );
            }

            // Entity-based auto-linking (Issue #154): known-entity matching, IP NER,
            // temporal co-occurrence, and supersession detection.
            let entityAutoLinked = 0;
            let autoSupersededIds: string[] = [];
            if (cfg.graph.enabled && cfg.graph.autoLink) {
              const sessionId = api.context?.sessionId ?? null;
              const result = storeFactsDb.autoLinkEntities(
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
                  storeFactsDb.applyEntityEnrichment(entry.id, mentions, detectedLang, {
                    requireSurnameForNewContacts: cfg.contacts.requireSurname,
                  });
                  // Structured contact profile enrichment (#2014): fill email/phone/role/board
                  // status on the fact's single PERSON contact from the same text. Gated on the
                  // contacts.profileEnrichment config toggle (default on).
                  if (cfg.contacts.profileEnrichment) {
                    storeFactsDb.applyContactProfileEnrichment(entry.id, textToStore, "ner");
                  }
                })
                .catch((err) => {
                  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
                  api.logger.warn?.(`memory-hybrid: entity enrichment failed: ${msg}`);
                });
            }

            const totalLinked = autoLinked + entityAutoLinked;
            // Classify how the supersede request resolved so the message and details never claim
            // a "dedupe-merge" when the real cause was a blocked/unknown target (#2139 QA):
            //  - merged: a genuine dedupe-merge into an existing fact (newlyStored === false)
            //  - blockedOnly: a new fact was created but no requested target could be superseded
            //    (all cross-scope/unknown, or already superseded)
            const supersedeMerged = hasSupersedes && supersededAppliedIds.length === 0 && !storeResult.newlyStored;
            const supersedeBlockedOnly = hasSupersedes && supersededAppliedIds.length === 0 && storeResult.newlyStored;
            const supersedeMsgNote =
              supersededAppliedIds.length > 0
                ? ` (supersedes ${supersededAppliedIds.length} previous fact${supersededAppliedIds.length === 1 ? "" : "s"}${supersedesBlocked.length > 0 ? `; ${supersedesBlocked.length} blocked/not found` : ""})`
                : supersedeMerged
                  ? " (dedupe-merged — requested supersede was NOT applied)"
                  : supersedeBlockedOnly
                    ? ` (requested supersede NOT applied${supersedesBlocked.length > 0 ? ` — ${supersedesBlocked.length} target${supersedesBlocked.length === 1 ? "" : "s"} blocked/not found` : ""})`
                    : "";
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
              storedMsg = `Stored: "${textToStore.slice(0, 100)}${textToStore.length > 100 ? "..." : ""}"${entity ? ` [entity: ${entity}]` : ""} [decay: ${entry.decayClass}]${supersedeMsgNote}${totalLinked > 0 ? ` (linked to ${totalLinked} related fact${totalLinked === 1 ? "" : "s"})` : ""}${
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
              if (ledgerMirror.synced) {
                storedMsg += " (synced to active-task ledger)";
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

            if (walEntryId) await removeStoreWal(storeWal, walEntryId);
            return {
              content: [
                {
                  type: "text",
                  text: storedMsg,
                },
              ],
              details: {
                action: supersededAppliedIds.length > 0 ? "updated" : "created",
                id: entry.id,
                why: whyStored ?? undefined,
                backend: "both",
                decayClass: entry.decayClass,
                ...(supersededAppliedIds.length > 0
                  ? { superseded: supersededAppliedIds[0], supersededIds: supersededAppliedIds }
                  : hasSupersedes
                    ? {
                        supersedeRequested: supersedesIds.length === 1 ? supersedesIds[0] : supersedesIds,
                        supersedeApplied: false,
                        // Distinguish a genuine dedupe-merge from blocked/unknown targets so the
                        // caller fixes the right thing (bad target id vs near-duplicate text) (#2139 QA).
                        reason: supersedeMerged ? "dedupe-merge" : "targets_blocked_or_not_found",
                      }
                    : {}),
                // Always surface targets that were requested but not applied (cross-scope/unknown),
                // even on a partially-successful multi-id supersede, so nothing is silently dropped.
                ...(supersedesBlocked.length > 0 ? { supersedeBlocked: supersedesBlocked } : {}),
                ...(totalLinked > 0 ? { autoLinked: totalLinked } : {}),
                ...(autoSupersededIds.length > 0 ? { autoSuperseded: autoSupersededIds } : {}),
                ...(contradictions.length > 0
                  ? {
                      contradictions: contradictions.map((c) => ({
                        contradictionId: c.contradictionId,
                        oldFactId: c.oldFactId,
                        fact_id: c.oldFactId,
                        score: c.score,
                        heuristicSignals: c.heuristicSignals,
                      })),
                    }
                  : {}),
                ...(decayFreezeUntil != null ? { decayFreezeUntil } : {}),
              },
            };
          }
          // WAL cleanup and return for skipped store path (Bug fix #1560, #1561)
          if (walEntryId) await removeStoreWal(storeWal, walEntryId);
          return {
            content: [
              {
                type: "text",
                text: `Store blocked by pre-store guard (category: ${category}).`,
              },
            ],
            details: { action: "skipped", reason: "blocked-by-guard", category },
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

  api.registerTool(
    {
      name: "memory_contradictions",
      label: "List Memory Contradictions",
      description:
        "Returns facts flagged with contradictions — useful for reviewing uncertain or conflicting knowledge.",
      parameters: Type.Object({
        since: Type.Optional(
          Type.String({ description: "ISO8601 timestamp cursor — only contradictions after this time." }),
        ),
        entity: Type.Optional(Type.String({ description: "Filter to contradictions involving this entity." })),
        limit: Type.Optional(Type.Number({ description: "Max results (default 50, max 200)." })),
        resolved: Type.Optional(
          Type.Boolean({ description: "When true, only resolved; when false, only unresolved." }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const scopeFilter = buildToolScopeFilter({}, currentAgentIdRef.value, cfg);
        const rows = factsDb.queryContradictionSurface({
          since: typeof params.since === "string" ? params.since : undefined,
          entity: typeof params.entity === "string" ? params.entity : undefined,
          limit: typeof params.limit === "number" && params.limit > 0 ? Math.min(200, Math.floor(params.limit)) : 50,
          resolved: typeof params.resolved === "boolean" ? params.resolved : undefined,
          scopeFilter,
        });
        return {
          content: [
            {
              type: "text",
              text:
                rows.length === 0
                  ? "No contradictions found."
                  : rows
                      .map(
                        (r) => `- [${r.score.toFixed(2)}] ${r.preview} (new=${r.factId}, old=${r.contradictingFactId})`,
                      )
                      .join("\n"),
            },
          ],
          details: { count: rows.length, contradictions: rows },
        };
      },
    },
    { name: "memory_contradictions" },
  );
}
