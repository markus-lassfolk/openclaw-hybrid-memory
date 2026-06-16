/**
 * Lifecycle stage types (Phase 2.3).
 * Shared context and stage result types for the staged pipeline.
 */

import type OpenAI from "openai";
import type { AuditStore } from "../backends/audit-store.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { EdictStore } from "../backends/edict-store.js";
import type { EventLog } from "../backends/event-log.js";
import type { FactsDB } from "../backends/facts-db.js";
import type { CrystallizationStore } from "../backends/crystallization-store.js";
import type { ProposalsDB } from "../backends/proposals-db.js";
import type { ToolProposalStore } from "../backends/tool-proposal-store.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { HybridMemoryConfig, MemoryCategory } from "../config.js";
import type { SessionSeenFacts } from "../services/ambient-retrieval.js";
import type { PendingLLMWarnings } from "../services/chat.js";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { FrustrationConversationTurn } from "../services/frustration-detector.js";
import type { PrependBudgetRef } from "../services/prepend-budget.js";
import type { ChangeFeed } from "../services/change-feed.js";
import type { WorkflowTracker } from "../services/workflow-tracker.js";
import type { MemoryEntry, MemoryScope, SearchResult } from "../types/memory.js";

/**
 * Subset of OpenClaw `PluginHookAgentContext` read at the hook boundary (#1005).
 * Parsed by `sliceHookAgentContext` in `hook-resolution-api.ts`.
 *
 * After `withHookResolutionApi`, values appear on `api.context`. Resolvers still prefer
 * structured event/session fields over `api.context`, so the event payload wins when both differ.
 */
export type HookAgentContextSlice = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export interface LifecycleContext {
  factsDb: FactsDB;
  edictStore: EdictStore;
  vectorDb: VectorDB;
  embeddings: EmbeddingProvider;
  embeddingRegistry: EmbeddingRegistry | null;
  openai: OpenAI;
  cfg: HybridMemoryConfig;
  credentialsDb: CredentialsDB | null;
  aliasDb: import("../services/retrieval-aliases.js").AliasDB | null;
  wal: WriteAheadLog | null;
  eventLog: EventLog | null;
  narrativesDb: NarrativesDB | null;
  workflowStore: WorkflowStore | null;
  workflowTracker?: WorkflowTracker;
  currentAgentIdRef: { value: string | null };
  /** @deprecated Use progressiveIndexBySession — kept for test harness compatibility. */
  lastProgressiveIndexIds: string[];
  /** Session-scoped progressive index (1-based memory_recall id → fact id). */
  progressiveIndexBySession: Map<string, string[]>;
  /** Session-scoped last auto-recall prompt for post-compaction reinjection (#957). */
  lastAutoRecallPromptBySession: Map<string, string>;
  restartPendingClearedRef: { value: boolean };
  resolvedSqlitePath: string;
  walWrite: (
    operation: "store" | "update",
    data: Record<string, unknown>,
    logger: { warn: (msg: string) => void },
    supersedeTargetId?: string,
  ) => Promise<string | null>;
  walRemove: (id: string, logger: { warn: (msg: string) => void }) => Promise<void>;
  findSimilarByEmbedding: (
    vectorDb: VectorDB,
    factsDb: { getById(id: string): MemoryEntry | null },
    vector: number[],
    limit: number,
    minScore?: number,
    options?: { scope?: MemoryScope; scopeTarget?: string | null },
  ) => Promise<MemoryEntry[]>;
  shouldCapture: (text: string) => boolean;
  detectCategory: (text: string) => MemoryCategory;
  pendingLLMWarnings: PendingLLMWarnings;
  auditStore: AuditStore | null;
  issueStore: import("../backends/issue-store.js").IssueStore | null;
  recallInFlightRef: { value: number };
  /** @deprecated Use lastAutoRecallPromptBySession. */
  lastAutoRecallPromptRef: { value: string | null };
  /** Registration generation that owns this lifecycle context; used to detect stale in-flight hooks. */
  registrationGeneration?: number;
  /** Shared current generation ref; differs from registrationGeneration after plugin re-registration. */
  currentRegistrationGenerationRef?: { value: number };
  /** Per-turn shared prepend token budget (initialized by recall, consumed by downstream hooks). */
  prependBudgetRef?: PrependBudgetRef;
  /** Fact IDs already injected this turn (lifecycle + ContextEngine dedup). */
  injectedFactIdsBySession?: import("../services/session-injection-dedup.js").InjectedFactIdsBySession;
  /** Live change feed for operator notifications. */
  changeFeed?: ChangeFeed | null;
  /** Workshop stores for in-chat revert (persona, crystallization, tool). */
  proposalsDb?: ProposalsDB | null;
  crystallizationStore?: CrystallizationStore | null;
  toolProposalStore?: ToolProposalStore | null;
  /** Multi-vault fan-out for auto-recall (#1917). */
  resolveAllVaults?: () => import("../services/vault-registry.js").VaultHandle[];
}

/** Per-session state shared across stages (owned by dispatcher). */
export interface SessionState {
  sessionStartSeen: Set<string>;
  ambientSeenFactsMap: Map<string, SessionSeenFacts>;
  ambientLastEmbeddingMap: Map<string, number[] | null>;
  frustrationStateMap: Map<string, { level: number; turns: FrustrationConversationTurn[] }>;
  /** Last frustration adaptation band emitted to change feed per session. */
  frustrationThresholdBandMap: Map<string, "none" | "medium" | "high" | "critical">;
  /** Last ordinals through which change events were injected in-chat per session key. */
  changeNotifyStateMap: Map<string, { lastNotifiedOrdinal: number; lastNotifiedBroadcastOrdinal: number }>;
  /** Maps in-chat display numbers (#N in notices) to change event ids per chat session. */
  displayRevertMap: Map<string, Map<number, string>>;
  authFailureRecallsThisSession: Map<string, number>;
  sessionLastActivity: Map<string, number>;
  capabilityHintsSessionsSeen: Set<string>;
  /** Per-session in-flight recall count for queue degradation (avoids cross-session bleed). */
  recallInFlightBySession: Map<string, number>;
  touchSession: (sessionKey: string) => void;
  clearSessionState: (sessionKey: string) => void;
  clearInjectedFactIdsForSession: (
    injectedFactIdsBySession: Map<string, Set<string>> | undefined,
    sessionKey: string,
  ) => void;
  pruneSessionMaps: (injectedFactIdsBySession?: Map<string, Set<string>>) => void;
  resolveSessionKey: (event: unknown, api?: { context?: { sessionId?: string; sessionKey?: string } }) => string | null;
  MAX_TRACKED_SESSIONS: number;
  /** Optional: clear all session maps (used by dispose). Set by hooks when creating sessionState. */
  clearAll?: (injectedFactIdsBySession?: Map<string, Set<string>>) => void;
}

/** Result of recall stage (candidates + blocks for injection). */
export interface RecallResult {
  candidates: SearchResult[];
  issueBlock: string;
  narrativeBlock: string;
  hotBlock: string;
  procedureBlock: string;
  withProcedures: (s: string) => string;
  recallSpan: string;
  recallStartMs: number;
  degradationMaxLatencyMs: number;
  injectionFormat: "full" | "short" | "minimal" | "progressive" | "progressive_hybrid";
  maxTokens: number;
  maxPerMemoryChars: number;
  useSummaryInInjection: boolean;
  indexCap: number;
  summarizeWhenOverBudget: boolean;
  summarizeModel: string | undefined;
  groupByCategory: boolean;
  pinnedRecallThreshold: number;
  progressiveIndexSessionKey: string;
  progressiveIndexBySession: Map<string, string[]>;
  ambientCfg: { enabled: boolean; multiQuery?: boolean };
  /** When ambient multiQuery is on, the session's seen-facts for topic-shift deduplication. */
  ambientSeenFacts: SessionSeenFacts | null;
  /** True when the main recall pipeline fell back to FTS-only (vector timeout/error/Lance unavailable). */
  semanticDegraded?: boolean;
  /** Total interactive prepend token ceiling (min of autoRecall.maxTokens and ambientBudgetTokens). */
  totalBudget: number;
}

/** Result of injection stage. */
interface InjectionResult {
  prependContext: string;
}

/** Return type of runRecallStage: degraded/empty return prependContext; full goes to injection. */
export type RecallStageResult =
  | { kind: "degraded"; prependContext: string }
  | { kind: "empty"; prependContext: string | undefined }
  | { kind: "full"; result: RecallResult };
