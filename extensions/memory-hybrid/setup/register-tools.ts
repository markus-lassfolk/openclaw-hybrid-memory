/**
 * Tool Registration Wiring
 *
 * Registers all plugin tools with the OpenClaw API.
 * Extracted from index.ts to reduce main file size.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { MemoryPluginAPI } from "../api/memory-plugin-api.js";
import type { EventLog } from "../backends/event-log.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import type { AliasDB } from "../services/retrieval-aliases.js";
import type { PendingLLMWarnings } from "../services/chat.js";
import type OpenAI from "openai";
import type { HybridMemoryConfig } from "../config.js";
import type { MemoryEntry, ScopeFilter } from "../types/memory.js";
import { registerMemoryTools } from "../tools/memory-tools.js";
import { registerGraphTools } from "../tools/graph-tools.js";
import { registerProvenanceTools } from "../tools/provenance-tools.js";
import { registerCredentialTools } from "../tools/credential-tools.js";
import { registerPersonaTools } from "../tools/persona-tools.js";
import { registerIssueTools } from "../tools/issue-tools.js";
import type { IssueStore } from "../backends/issue-store.js";
import { registerDocumentTools } from "../tools/document-tools.js";
import { registerWorkflowTools } from "../tools/workflow-tools.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import { registerCrystallizationTools } from "../tools/crystallization-tools.js";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import { registerSelfExtensionTools } from "../tools/self-extension-tools.js";
import type { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { PythonBridge } from "../services/python-bridge.js";
import { registerVerificationTools } from "../tools/verification-tools.js";
import type { VerificationStore } from "../services/verification-store.js";
import {
  registerUtilityTools,
  type RunReflectionFn,
  type RunReflectionRulesFn,
  type RunReflectionMetaFn,
} from "../tools/utility-tools.js";
import { registerDashboardHttpRoutes } from "../tools/dashboard-routes.js";
import { capturePluginError } from "../services/error-reporter.js";
import type { ProvenanceService } from "../services/provenance.js";
import type { VariantGenerationQueue } from "../services/contextual-variants.js";

/** Tool registration receives the stable plugin API (Phase 3). */
export type ToolsContext = MemoryPluginAPI;

/**
 * Register all plugin tools with the OpenClaw API.
 * Calls tool registration modules in the correct order.
 */
export function registerTools(ctx: ToolsContext, api: ClawdbotPluginApi): void {
  const {
    factsDb,
    vectorDb,
    cfg,
    embeddings,
    embeddingRegistry,
    openai,
    wal,
    credentialsDb,
    proposalsDb,
    eventLog,
    provenanceService,
    aliasDb,
    issueStore,
    workflowStore,
    crystallizationStore,
    toolProposalStore,
    verificationStore,
    lastProgressiveIndexIds,
    currentAgentIdRef,
    pendingLLMWarnings,
    resolvedSqlitePath,
    timers,
    buildToolScopeFilter,
    walWrite,
    walRemove,
    findSimilarByEmbedding,
    runReflection,
    runReflectionRules,
    runReflectionMeta,
    pythonBridge,
    variantQueue,
  } = ctx;

  // Memory tools (core recall, store, forget operations)
  registerMemoryTools(
    {
      factsDb,
      vectorDb,
      cfg,
      embeddings,
      embeddingRegistry,
      openai,
      wal,
      credentialsDb,
      eventLog,
      provenanceService,
      aliasDb,
      verificationStore,
      variantQueue,
      lastProgressiveIndexIds,
      currentAgentIdRef,
      pendingLLMWarnings,
    },
    api,
    buildToolScopeFilter,
    (operation, data, logger) => walWrite(wal, operation, data, logger),
    (id, logger) => walRemove(wal, id, logger),
    findSimilarByEmbedding,
  );

  // Graph tools (memory linking and traversal)
  if (cfg.graph.enabled) {
    registerGraphTools({ factsDb, cfg }, api);
  }

  // Provenance tools (when provenance tracing is enabled)
  if (cfg.provenance.enabled && provenanceService) {
    registerProvenanceTools({ factsDb, eventLog, provenanceService, cfg }, api);
  }

  // Credential tools (secure credential storage and retrieval)
  if (cfg.credentials.enabled && credentialsDb) {
    registerCredentialTools({ credentialsDb, cfg, api }, api);
  }

  // Persona proposal tools and CLI
  if (cfg.personaProposals.enabled && proposalsDb) {
    registerPersonaTools({ proposalsDb, cfg, resolvedSqlitePath }, api);

    // NOTE: persona_proposal_review and persona_proposal_apply are intentionally
    // NOT registered as agent-callable tools. They are CLI-only commands to ensure
    // human approval is required. This prevents agents from self-approving and
    // applying their own proposals, maintaining the security guarantee.

    // Periodic cleanup of expired proposals (stored in module-level variable for cleanup on stop).
    // Guard: only call pruneExpired when DB is still open to avoid "database connection is not open" after stop() (issue #130).
    timers.proposalsPruneTimer.value = setInterval(
      () => {
        try {
          if (proposalsDb?.isOpen()) {
            const pruned = proposalsDb.pruneExpired();
            if (pruned > 0) {
              api.logger.info(`memory-hybrid: pruned ${pruned} expired proposal(s)`);
            }
          }
        } catch (err) {
          capturePluginError(err instanceof Error ? err : new Error(String(err)), {
            subsystem: "proposals",
            operation: "periodic-prune",
          });
          api.logger.warn(`memory-hybrid: proposal prune failed: ${err}`);
        }
      },
      24 * 60 * 60_000,
    ); // daily

    // Proposals CLI (list/show/approve/reject) is registered under hybrid-mem in manage.ts only
  }

  // Utility tools (reflection, consolidation, export)
  registerUtilityTools(
    { factsDb, vectorDb, embeddings, openai, cfg, wal, resolvedSqlitePath, provenanceService },
    api,
    runReflection,
    runReflectionRules,
    runReflectionMeta,
    (operation, data) => walWrite(wal, operation, data, api.logger),
    (id) => walRemove(wal, id, api.logger),
  );

  // Document ingestion tool (opt-in, requires Python + markitdown)
  if (cfg.documents.enabled && pythonBridge) {
    registerDocumentTools({ factsDb, vectorDb, cfg, embeddings, pythonBridge, openai, provenanceService }, api);
  }

  // Verification tools (Issue #162)
  if (cfg.verification.enabled && verificationStore) {
    registerVerificationTools({ factsDb, verificationStore }, api);
  }

  // Issue lifecycle tracking (always enabled — lightweight, Issue #137)
  if (issueStore) {
    registerIssueTools({ issueStore, cfg }, api);
  }

  // Workflow pattern tool (always registered when store available; recording is gated by cfg, Issue #209)
  if (workflowStore) {
    registerWorkflowTools({ workflowStore }, api);
  }

  // Crystallization tools (register when store available; crystallization gated by cfg, Issue #208)
  if (crystallizationStore && workflowStore) {
    registerCrystallizationTools({ crystallizationStore, workflowStore, cfg }, api);
  }

  // Self-extension tools (register when store available; analysis gated by cfg, Issue #210)
  if (toolProposalStore && workflowStore) {
    registerSelfExtensionTools({ toolProposalStore, workflowStore, cfg }, api);
  }

  // Dashboard HTTP routes (Issue #279)
  registerDashboardHttpRoutes({ cfg }, api);
}
