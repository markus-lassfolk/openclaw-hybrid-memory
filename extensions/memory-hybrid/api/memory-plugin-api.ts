/**
 * Stable internal API for the memory-hybrid plugin (Phase 3).
 *
 * Optional modules (analysis, learning, self-extension, observability) should depend
 * only on this type and the types it references. That avoids circular dependencies
 * and makes modules testable by passing a mock MemoryPluginAPI.
 *
 * The core plugin builds a single object satisfying MemoryPluginAPI in index.ts
 * and passes it to registerTools and registerLifecycleHooks. Future optional
 * modules will receive the same (or a subset) API.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { EventLog } from "../backends/event-log.js";
import type { IssueStore } from "../backends/issue-store.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import type { PendingLLMWarnings } from "../services/chat.js";
import type { AliasDB } from "../services/retrieval-aliases.js";
import type { ProvenanceService } from "../services/provenance.js";
import type { VerificationStore } from "../services/verification-store.js";
import type { VariantGenerationQueue } from "../services/contextual-variants.js";
import type { PythonBridge } from "../services/python-bridge.js";
import type { ApitapStore } from "../backends/apitap-store.js";
import type OpenAI from "openai";
import type { HybridMemoryConfig, MemoryCategory } from "../config.js";
import type { MemoryEntry, ScopeFilter } from "../types/memory.js";
import type { RunReflectionFn, RunReflectionRulesFn, RunReflectionMetaFn } from "../tools/utility-tools.js";

/** Raw WAL helpers (caller binds wal). Used by tools and lifecycle. */
export type WalWriteFn = typeof import("../services/wal-helpers.js").walWrite;
export type WalRemoveFn = typeof import("../services/wal-helpers.js").walRemove;

/** Vector similarity search (used by recall and tools). */
export type FindSimilarByEmbeddingFn = (
  vectorDb: VectorDB,
  factsDb: { getById(id: string): MemoryEntry | null },
  vector: number[],
  limit: number,
  minScore?: number,
) => Promise<MemoryEntry[]>;

/** Builds scope filter for tools from user/agent/session and config. */
export type BuildToolScopeFilterFn = (
  params: { userId?: string | null; agentId?: string | null; sessionId?: string | null },
  currentAgent: string | null,
  config: { multiAgent: { orchestratorId: string }; autoRecall: { scopeFilter?: ScopeFilter } },
) => ScopeFilter | undefined;

/**
 * Stable internal API provided by the core memory-hybrid plugin.
 * Optional modules depend on this type only; index.ts builds the single implementation.
 */
export interface MemoryPluginAPI {
  // --- Core (always present) ---
  factsDb: FactsDB;
  vectorDb: VectorDB;
  cfg: HybridMemoryConfig;
  embeddings: EmbeddingProvider;
  openai: OpenAI;
  resolvedSqlitePath: string;
  currentAgentIdRef: { value: string | null };
  lastProgressiveIndexIds: string[];
  pendingLLMWarnings: PendingLLMWarnings;

  // --- Optional core (nullable) ---
  wal: WriteAheadLog | null;
  embeddingRegistry: EmbeddingRegistry | null;
  credentialsDb: CredentialsDB | null;
  aliasDb: AliasDB | null;
  proposalsDb: ProposalsDB | null;
  eventLog: EventLog | null;
  provenanceService: ProvenanceService | null;
  issueStore: IssueStore | null;
  workflowStore: WorkflowStore | null;
  crystallizationStore: CrystallizationStore | null;
  toolProposalStore: ToolProposalStore | null;
  verificationStore: VerificationStore | null;
  variantQueue: VariantGenerationQueue | null;
  pythonBridge: PythonBridge | null;
  apitapStore: ApitapStore | null;

  // --- Refs (lifecycle / degradation) ---
  restartPendingClearedRef: { value: boolean };
  recallInFlightRef: { value: number };

  // --- WAL & search (raw; caller binds wal where needed) ---
  walWrite: WalWriteFn;
  walRemove: WalRemoveFn;
  findSimilarByEmbedding: FindSimilarByEmbeddingFn;

  // --- Capture helpers (used by lifecycle) ---
  shouldCapture: (text: string) => boolean;
  detectCategory: (text: string) => MemoryCategory;

  // --- Tools: scope filter & reflection ---
  buildToolScopeFilter: BuildToolScopeFilterFn;
  runReflection: RunReflectionFn;
  runReflectionRules: RunReflectionRulesFn;
  runReflectionMeta: RunReflectionMetaFn;

  // --- Tools: timers (for cleanup on stop) ---
  timers: {
    proposalsPruneTimer: { value: ReturnType<typeof setInterval> | null };
  };
}
