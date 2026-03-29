/**
 * Lifecycle stage types (Phase 2.3).
 * Shared context and stage result types for the staged pipeline.
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { EdictStore } from "../backends/edict-store.js";
import type { VectorDB } from "../backends/vector-db.js";
import type { EmbeddingProvider } from "../services/embeddings.js";
import type { EmbeddingRegistry } from "../services/embedding-registry.js";
import type { WriteAheadLog } from "../backends/wal.js";
import type { CredentialsDB } from "../backends/credentials-db.js";
import type { EventLog } from "../backends/event-log.js";
import type { NarrativesDB } from "../backends/narratives-db.js";
import type { WorkflowStore } from "../backends/workflow-store.js";
import type { WorkflowTracker } from "../services/workflow-tracker.js";
import type OpenAI from "openai";
import type { HybridMemoryConfig, MemoryCategory } from "../config.js";
import type { MemoryEntry, ScopeFilter, SearchResult } from "../types/memory.js";
import type { PendingLLMWarnings } from "../services/chat.js";
import type { SessionSeenFacts } from "../services/ambient-retrieval.js";
import type { FrustrationConversationTurn } from "../services/frustration-detector.js";

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
  lastProgressiveIndexIds: string[];
  restartPendingClearedRef: { value: boolean };
  resolvedSqlitePath: string;
  walWrite: (
    operation: "store" | "update",
    data: Record<string, unknown>,
    logger: { warn: (msg: string) => void },
    supersedeTargetId?: string,
  ) => Promise<string>;
  walRemove: (id: string, logger: { warn: (msg: string) => void }) => Promise<void>;
  findSimilarByEmbedding: (
    vectorDb: VectorDB,
    factsDb: { getById(id: string): MemoryEntry | null },
    vector: number[],
    limit: number,
    minScore?: number,
  ) => Promise<MemoryEntry[]>;
  shouldCapture: (text: string) => boolean;
  detectCategory: (text: string) => MemoryCategory;
  pendingLLMWarnings: PendingLLMWarnings;
  issueStore: import("../backends/issue-store.js").IssueStore | null;
  recallInFlightRef: { value: number };
}

/** Per-session state shared across stages (owned by dispatcher). */
export interface SessionState {
  sessionStartSeen: Set<string>;
  ambientSeenFactsMap: Map<string, SessionSeenFacts>;
  ambientLastEmbeddingMap: Map<string, number[] | null>;
  frustrationStateMap: Map<string, { level: number; turns: FrustrationConversationTurn[] }>;
  authFailureRecallsThisSession: Map<string, number>;
  sessionLastActivity: Map<string, number>;
  touchSession: (sessionKey: string) => void;
  clearSessionState: (sessionKey: string) => void;
  pruneSessionMaps: () => void;
  resolveSessionKey: (event: unknown, api?: { context?: { sessionId?: string } }) => string | null;
  MAX_TRACKED_SESSIONS: number;
  /** Optional: clear all session maps (used by dispose). Set by hooks when creating sessionState. */
  clearAll?: () => void;
}

/** Result of recall stage (candidates + blocks for injection). */
export interface RecallResult {
  candidates: SearchResult[];
  issueBlock: string;
  narrativeBlock: string;
  hotBlock: string;
  procedureBlock: string;
  withProcedures: (s: string) => string;
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
  lastProgressiveIndexIdsRef: string[];
  ambientCfg: { enabled: boolean; multiQuery?: boolean };
  /** When ambient multiQuery is on, the session's seen-facts for topic-shift deduplication. */
  ambientSeenFacts: SessionSeenFacts | null;
}

/** Result of injection stage. */
export interface InjectionResult {
  prependContext: string;
}

/** Return type of runRecallStage: degraded/empty return prependContext; full goes to injection. */
export type RecallStageResult =
  | { kind: "degraded"; prependContext: string }
  | { kind: "empty"; prependContext: string | undefined }
  | { kind: "full"; result: RecallResult };
