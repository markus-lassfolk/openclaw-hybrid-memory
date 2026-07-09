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
import type { AgentHealthStore } from "../backends/agent-health-store.js";
import type { ApitapStore } from "../backends/apitap-store.js";
import type { AuditStore } from "../backends/audit-store.js";
import type { CostTracker } from "../backends/cost-tracker.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { EdictStore } from "../backends/edict-store.js";
import type { EventBus } from "../backends/event-bus.js";
import type { EventLog } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { IdentityReflectionStore } from "../backends/identity-reflection-store.js";
import type { IssueStore } from "../backends/issue-store.js";
import type { LearningsDB } from "../backends/learnings-db.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import type { PersonaStateStore } from "../backends/persona-state-store.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { HybridMemoryConfig } from "../config.js";
import type { PendingLLMWarnings } from "../services/chat.js";
import type { VariantGenerationQueue } from "../services/contextual-variants.js";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { ProvenanceService } from "../services/provenance.js";
import type { PythonBridge } from "../services/python-bridge.js";
import type { AliasDB } from "../services/retrieval-aliases.js";
import type { VerificationStore } from "../services/verification-store.js";
import type { ChangeFeed } from "../services/change-feed.js";
import type { SessionState } from "../lifecycle/types.js";
import type { LifecycleHooksHandle } from "../setup/register-hooks.js";
import type { ToolRegistrationHandle } from "../setup/register-tools.js";

/** All mutable per-instance state for the memory-hybrid plugin. */
export interface PluginRuntime {
  // --- Config & resolved paths ---
  cfg: HybridMemoryConfig;
  /** Parse-time config snapshot for hot-reload reuse checks (bootstrap may mutate `cfg`). */
  parsedCfgSnapshot: HybridMemoryConfig;
  resolvedLancePath: string;
  resolvedSqlitePath: string;

  // --- Core backends (always present after init) ---
  factsDb: FactsDB;
  edictStore: EdictStore;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  embeddingRegistry: EmbeddingRegistry;
  openai: OpenAI;

  // --- Optional backends (null when feature disabled) ---
  credentialsDb: CredentialsDB | null;
  wal: WriteAheadLog | null;
  proposalsDb: ProposalsDB | null;
  identityReflectionStore: IdentityReflectionStore | null;
  personaStateStore: PersonaStateStore | null;
  eventLog: EventLog | null;
  narrativesDb: NarrativesDB | null;
  aliasDb: AliasDB | null;
  eventBus: EventBus | null;
  costTracker: CostTracker | null;
  issueStore: IssueStore | null;
  workflowStore: WorkflowStore | null;
  crystallizationStore: CrystallizationStore | null;
  toolProposalStore: ToolProposalStore | null;
  provenanceService: ProvenanceService | null;
  verificationStore: VerificationStore | null;
  apitapStore: ApitapStore | null;
  pythonBridge: PythonBridge | null;
  variantQueue: VariantGenerationQueue | null;
  /** Staged intake buffer for errors, lessons, and feature requests (Issue #617). */
  learningsDb: LearningsDB | null;
  /** Cross-agent audit log (Issue #790). */
  auditStore: AuditStore | null;
  agentHealthStore: AgentHealthStore | null;
  /** Live change feed for operator notifications. */
  changeFeed: ChangeFeed | null;
  /** Multi-vault routing (#1917). */
  resolveVault?: (vaultName?: string) => import("../services/vault-registry.js").VaultHandle;
  resolveAllVaults?: () => import("../services/vault-registry.js").VaultHandle[];
  resolveVaultWal?: (vaultName?: string) => import("../backends/wal.js").WriteAheadLog | null;
  vaultRegistry?: import("../services/vault-registry.js").VaultRegistry | null;
  /** Populated after lifecycle hooks register; used for frustration reset on revert. */
  sessionStateRef: { value: SessionState | null };

  // --- Lifecycle state ---
  /** Handle returned by registerLifecycleHooks; set after hooks are registered, null until then. */
  lifecycleHooksHandle: LifecycleHooksHandle | null;
  /** Handle returned by registerTools; set after tool registration, null until then. */
  toolRegistrationHandle: ToolRegistrationHandle | null;
  /**
   * Resolves when async bootstrap work from `initializeDatabases` finishes (embedding/vault checks, etc.).
   * Used to sequence CLI teardown so we do not close DBs while init I/O is still running (Issue #1039).
   */
  bootstrapAsyncInit: Promise<void>;
  /** Tracks whether bootstrapAsyncInit has settled (used by re-register reuse policy). */
  bootstrapSettledRef?: { value: boolean };
  /** Last bootstrap health snapshot from initializeDatabases() for reuse-databases policy. */
  bootstrapHealth?: {
    embeddingsOk: boolean;
    credentialsVaultOk: boolean;
    lastCheckTime: number;
  };
  /**
   * Registration generation that produced this runtime. The next re-register uses this
   * value to track which donor-runtime teardowns it is waiting on (reload-coordinator
   * `donorGeneration`), so the gate does not deadlock when a re-register overlap-queues
   * another re-register (e.g. rapid voice-call config hot reloads).
   */
  bootRegistrationGeneration?: number;
  pendingLLMWarnings: PendingLLMWarnings;

  // --- Mutable refs (objects so that closures can share mutations) ---
  /** Detected agent for current session; updated on before_agent_start. */
  currentAgentIdRef: { value: string | null };
  /** Set to true once the restart-pending flag has been cleared this session. */
  restartPendingClearedRef: { value: boolean };
  /** Count of in-flight recall operations (degradation / back-pressure). */
  recallInFlightRef: { value: number };
  /** Last user prompt used for interactive auto-recall (issue #957 post-compaction reinjection). */
  lastAutoRecallPromptRef: { value: string | null };
  /** Per-turn shared prepend token budget across before_agent_start hooks. */
  prependBudgetRef: import("../services/prepend-budget.js").PrependBudgetRef;
  /** Turn start timestamp for gateway before_agent_start wall-clock budget (#1979). */
  beforeAgentStartTurnRef: import("../services/before-agent-start-budget.js").BeforeAgentStartTurnRef;
  /** Last progressive index fact IDs (1-based position → fact id). @deprecated use progressiveIndexBySession */
  lastProgressiveIndexIds: string[];
  progressiveIndexBySession: Map<string, string[]>;
  lastAutoRecallPromptBySession: Map<string, string>;
  /** Per-session fact IDs injected this turn (lifecycle + ContextEngine dedup). */
  injectedFactIdsBySession: import("../services/session-injection-dedup.js").InjectedFactIdsBySession;

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
    /** Unified maintenance orchestrator tick (cycle tier). */
    maintenanceTick: { value: ReturnType<typeof setInterval> | null };
    maintenanceStartupTimeout: { value: ReturnType<typeof setTimeout> | null };
    /** Workboard bidirectional sync timer. */
    workboardSync?: { value: ReturnType<typeof setInterval> | null };
    /** Deferred Workboard cold-start probe (#1940). */
    workboardStartupTimeout?: { value: ReturnType<typeof setTimeout> | null };
    /** Wiki workspace markdown mirror export timer. */
    wikiWorkspaceExport?: { value: ReturnType<typeof setInterval> | null };
    /** Plugin service shutdown flag (Issue #1893 re-arm abort guard). */
    shuttingDownRef: { value: boolean };
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
    maintenanceTick: { value: null },
    maintenanceStartupTimeout: { value: null },
    shuttingDownRef: { value: false },
  };
}

/**
 * Clear all runtime timer handles and reset refs.
 * Shared by CLI teardown and hot-reload cleanup paths.
 */
export function clearRuntimeTimers(timers: PluginRuntime["timers"]): void {
  if (timers.pruneTimer.value) {
    clearInterval(timers.pruneTimer.value);
    timers.pruneTimer.value = null;
  }
  if (timers.classifyTimer.value) {
    clearInterval(timers.classifyTimer.value);
    timers.classifyTimer.value = null;
  }
  if (timers.classifyStartupTimeout.value) {
    clearTimeout(timers.classifyStartupTimeout.value);
    timers.classifyStartupTimeout.value = null;
  }
  if (timers.proposalsPruneTimer.value) {
    clearInterval(timers.proposalsPruneTimer.value);
    timers.proposalsPruneTimer.value = null;
  }
  if (timers.languageKeywordsTimer.value) {
    clearInterval(timers.languageKeywordsTimer.value);
    timers.languageKeywordsTimer.value = null;
  }
  if (timers.languageKeywordsStartupTimeout.value) {
    clearTimeout(timers.languageKeywordsStartupTimeout.value);
    timers.languageKeywordsStartupTimeout.value = null;
  }
  if (timers.postUpgradeTimeout.value) {
    clearTimeout(timers.postUpgradeTimeout.value);
    timers.postUpgradeTimeout.value = null;
  }
  if (timers.passiveObserverTimer.value) {
    clearInterval(timers.passiveObserverTimer.value);
    timers.passiveObserverTimer.value = null;
  }
  if (timers.watchdogTimer.value) {
    clearInterval(timers.watchdogTimer.value);
    timers.watchdogTimer.value = null;
  }
  if (timers.maintenanceTick.value) {
    clearInterval(timers.maintenanceTick.value);
    timers.maintenanceTick.value = null;
  }
  if (timers.maintenanceStartupTimeout.value) {
    clearTimeout(timers.maintenanceStartupTimeout.value);
    timers.maintenanceStartupTimeout.value = null;
  }
  if (timers.workboardSync?.value) {
    clearInterval(timers.workboardSync.value);
    timers.workboardSync.value = null;
  }
  if (timers.workboardStartupTimeout?.value) {
    clearTimeout(timers.workboardStartupTimeout.value);
    timers.workboardStartupTimeout.value = null;
  }
  if (timers.wikiWorkspaceExport?.value) {
    clearInterval(timers.wikiWorkspaceExport.value);
    timers.wikiWorkspaceExport.value = null;
  }
}
