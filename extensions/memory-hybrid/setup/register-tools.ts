/**
 * Tool Registration Wiring
 *
 * Registers all plugin tools with the OpenClaw API.
 * Extracted from index.ts to reduce main file size.
 */

import type { ClawdbotPluginApi } from "openclaw/plugin-sdk";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { Embeddings } from "../services/embeddings.js";
import type { PendingLLMWarnings } from "../services/chat.js";
import type OpenAI from "openai";
import type { HybridMemoryConfig } from "../config.js";
import type { MemoryEntry, ScopeFilter } from "../types/memory.js";
import { registerMemoryTools } from "../tools/memory-tools.js";
import { registerGraphTools } from "../tools/graph-tools.js";
import { registerCredentialTools } from "../tools/credential-tools.js";
import { registerPersonaTools } from "../tools/persona-tools.js";
import {
  registerUtilityTools,
  type RunReflectionFn,
  type RunReflectionRulesFn,
  type RunReflectionMetaFn,
} from "../tools/utility-tools.js";
import { capturePluginError } from "../services/error-reporter.js";

export interface ToolsContext {
  factsDb: FactsDB;
  vectorDb: VectorDB;
  cfg: HybridMemoryConfig;
  embeddings: Embeddings;
  openai: OpenAI;
  wal: WriteAheadLog | null;
  credentialsDb: CredentialsDB | null;
  proposalsDb: ProposalsDB | null;
  lastProgressiveIndexIds: string[];
  currentAgentIdRef: { value: string | null };
  pendingLLMWarnings: PendingLLMWarnings;
  resolvedSqlitePath: string;
  timers: {
    proposalsPruneTimer: { value: ReturnType<typeof setInterval> | null };
  };
  buildToolScopeFilter: (
    params: { userId?: string | null; agentId?: string | null; sessionId?: string | null },
    currentAgent: string | null,
    config: { multiAgent: { orchestratorId: string }; autoRecall: { scopeFilter?: ScopeFilter } }
  ) => ScopeFilter | undefined;
  walWrite: (
    wal: WriteAheadLog | null,
    operation: "store" | "update",
    data: Record<string, unknown>,
    logger: { warn: (msg: string) => void }
  ) => string;
  walRemove: (wal: WriteAheadLog | null, id: string, logger: { warn: (msg: string) => void }) => void;
  findSimilarByEmbedding: (
    vectorDb: VectorDB,
    factsDb: { getById(id: string): MemoryEntry | null },
    vector: number[],
    limit: number,
    minScore?: number
  ) => Promise<MemoryEntry[]>;
  runReflection: RunReflectionFn;
  runReflectionRules: RunReflectionRulesFn;
  runReflectionMeta: RunReflectionMetaFn;
}

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
    openai,
    wal,
    credentialsDb,
    proposalsDb,
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
  } = ctx;

  // Memory tools (core recall, store, forget operations)
  registerMemoryTools(
    { factsDb, vectorDb, cfg, embeddings, openai, wal, credentialsDb, lastProgressiveIndexIds, currentAgentIdRef, pendingLLMWarnings },
    api,
    buildToolScopeFilter,
    (operation, data, logger) => walWrite(wal, operation, data, logger),
    (id, logger) => walRemove(wal, id, logger),
    findSimilarByEmbedding
  );

  // Graph tools (memory linking and traversal)
  if (cfg.graph.enabled) {
    registerGraphTools({ factsDb, cfg }, api);
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

    // Periodic cleanup of expired proposals (stored in module-level variable for cleanup on stop)
    timers.proposalsPruneTimer.value = setInterval(() => {
      try {
        if (proposalsDb) {
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
    }, 24 * 60 * 60_000); // daily

    // Proposals CLI (list/show/approve/reject) is registered under hybrid-mem in manage.ts only
  }

  // Utility tools (reflection, consolidation, export)
  registerUtilityTools(
    { factsDb, vectorDb, embeddings, openai, cfg, wal, resolvedSqlitePath },
    api,
    runReflection,
    runReflectionRules,
    runReflectionMeta,
    (operation, data) => walWrite(wal, operation, data, api.logger),
    (id) => walRemove(wal, id, api.logger)
  );
}
