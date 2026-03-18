/**
 * PluginRuntime: instance-scoped container for all mutable plugin state.
 *
 * Replaces module-level `let` variables in index.ts to enable:
 *  - Independent plugin instances in the same process (testability)
 *  - Clearer ownership of runtime state
 *  - Explicit context passing to tools and lifecycle hooks
 *
 * A single module-level `const runtimeRef: { value: PluginRuntime | null }` holds the
 * active instance.  Closures (tools, timers, event handlers) capture `runtimeRef` by
 * reference; when register() creates a fresh PluginRuntime after a SIGUSR1 reload the
 * closures automatically see the new instance through `runtimeRef.value`.
 */

import type OpenAI from "openai";
import type { HybridMemoryConfig } from "../config.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { EventLog } from "../backends/event-log.js";
import type { AliasDB } from "../services/retrieval-aliases.js";
import type { EventBus } from "../backends/event-bus.js";
import type { CostTracker } from "../backends/cost-tracker.js";
import type { IssueStore } from "../backends/issue-store.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { LearningsDB } from "../backends/learnings-db.js";
import type { ProvenanceService } from "../services/provenance.js";
import type { VerificationStore } from "../services/verification-store.js";
import type { PythonBridge } from "../services/python-bridge.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import type { LifecycleHooksHandle } from "../setup/register-hooks.js";
import type { VariantGenerationQueue } from "../services/contextual-variants.js";
import type { PendingLLMWarnings } from "../services/chat.js";

/** All mutable per-instance state for the memory-hybrid plugin. */
export interface PluginRuntime {
  // --- Config & resolved paths ---
  cfg: HybridMemoryConfig;
  resolvedLancePath: string;
  resolvedSqlitePath: string;

  // --- Core backends (always present after init) ---
  factsDb: FactsDB;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  embeddingRegistry: EmbeddingRegistry;
  openai: OpenAI;

  // --- Optional backends (null when feature disabled) ---
  credentialsDb: CredentialsDB | null;
  wal: WriteAheadLog | null;
  proposalsDb: ProposalsDB | null;
  eventLog: EventLog | null;
  aliasDb: AliasDB | null;
  eventBus: EventBus | null;
  costTracker: CostTracker | null;
  issueStore: IssueStore | null;
  workflowStore: WorkflowStore | null;
  crystallizationStore: CrystallizationStore | null;
  toolProposalStore: ToolProposalStore | null;
  provenanceService: ProvenanceService | null;
  verificationStore: VerificationStore | null;
  pythonBridge: PythonBridge | null;
  variantQueue: VariantGenerationQueue | null;
  /** Staged intake buffer for errors, lessons, and feature requests (Issue #617). */
  learningsDb: LearningsDB | null;

  // --- Lifecycle state ---
  /** Handle returned by registerLifecycleHooks; set after hooks are registered, null until then. */
  lifecycleHooksHandle: LifecycleHooksHandle | null;
  pendingLLMWarnings: PendingLLMWarnings;

  // --- Mutable refs (objects so that closures can share mutations) ---
  /** Detected agent for current session; updated on before_agent_start. */
  currentAgentIdRef: { value: string | null };
  /** Set to true once the restart-pending flag has been cleared this session. */
  restartPendingClearedRef: { value: boolean };
  /** Count of in-flight recall operations (degradation / back-pressure). */
  recallInFlightRef: { value: number };
  /** Last progressive index fact IDs (1-based position → fact id). */
  lastProgressiveIndexIds: string[];

  // --- Timer refs (objects so they can be passed by reference to plugin-service) ---
  timers: {
    pruneTimer: { value: ReturnType<typeof setInterval> | null };
    classifyTimer: { value: ReturnType<typeof setInterval> | null };
    classifyStartupTimeout: { value: ReturnType<typeof setTimeout> | null };
    proposalsPruneTimer: { value: ReturnType<typeof setInterval> | null };
    languageKeywordsTimer: { value: ReturnType<typeof setInterval> | null };
    languageKeywordsStartupTimeout: { value: ReturnType<typeof setTimeout> | null };
    postUpgradeTimeout: { value: ReturnType<typeof setTimeout> | null };
    passiveObserverTimer: { value: ReturnType<typeof setInterval> | null };
    /** Issue #631: Stale-run watchdog timer for autonomous task queue self-healing. */
    watchdogTimer: { value: ReturnType<typeof setInterval> | null };
  };
}

/** Create a fresh, empty timers bag for a new PluginRuntime instance. */
export function createTimers(): PluginRuntime["timers"] {
  return {
    pruneTimer: { value: null },
    classifyTimer: { value: null },
    classifyStartupTimeout: { value: null },
    proposalsPruneTimer: { value: null },
    languageKeywordsTimer: { value: null },
    languageKeywordsStartupTimeout: { value: null },
    postUpgradeTimeout: { value: null },
    passiveObserverTimer: { value: null },
    watchdogTimer: { value: null },
  };
}
