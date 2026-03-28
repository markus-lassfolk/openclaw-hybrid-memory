/**
 * Shared memory types used by backends and plugin.
 */

import type { MemoryCategory, DecayClass } from "../config.js";

// Re-export types that are commonly needed
export type { MemoryCategory, DecayClass };

/** Memory tier for dynamic tiering (hot = always loaded, warm = semantic search, cold = archived). */
export type MemoryTier = "hot" | "warm" | "cold";

export type MemoryEntry = {
  id: string;
  text: string;
  /** Optional lineage context describing why this fact/decision was stored. */
  why?: string | null;
  category: MemoryCategory;
  importance: number;
  entity: string | null;
  key: string | null;
  value: string | null;
  source: string;
  createdAt: number;
  sourceDate?: number | null;
  decayClass: DecayClass;
  expiresAt: number | null;
  lastConfirmedAt: number;
  confidence: number;
  summary?: string | null;
  tags?: string[] | null;
  recallCount?: number;
  lastAccessed?: number | null;
  /** Incremented on every memory_recall hit (#237). */
  accessCount?: number;
  /** ISO 8601 timestamp of last recall hit (#237). */
  lastAccessedAt?: string | null;
  supersededAt?: number | null;
  supersededBy?: string | null;
  /** When the fact became true in the real world (epoch seconds). */
  validFrom?: number | null;
  /** When the fact stopped being true (epoch seconds); null if still current. */
  validUntil?: number | null;
  /** Id of the fact this one supersedes (replaces). */
  supersedesId?: string | null;
  /** Dynamic tier — hot (session), warm (recent), cold (archived). */
  tier?: MemoryTier | null;
  /** Memory scope — global, user, agent, or session. */
  scope?: MemoryScope;
  /** Scope target (e.g. userId for user scope, agentId for agent scope, sessionId for session scope). Null for global. */
  scopeTarget?: string | null;
  /** Procedural memory: fact is a procedure summary. */
  procedureType?: "positive" | "negative" | null;
  successCount?: number;
  lastValidated?: number | null;
  sourceSessions?: string | null;
  /** Embedding model used to generate this fact's vector (if stored). */
  embeddingModel?: string | null;
  /** Provenance: session id associated with extraction or store. */
  provenanceSession?: string | null;
  /** Provenance: conversation turn number within the source session, when known. */
  sourceTurn?: number | null;
  /** Provenance: extraction path used to create the fact. */
  extractionMethod?: string | null;
  /** Provenance: confidence score for the extraction path (0-1). */
  extractionConfidence?: number | null;
  /** Reinforcement tracking — number of times this fact was reinforced by user praise. */
  reinforcedCount?: number;
  /** When this fact was last reinforced (epoch seconds). */
  lastReinforcedAt?: number | null;
  /** Array of user praise quotes that reinforced this fact. */
  reinforcedQuotes?: string[] | null;
  /**
   * Future-date decay freeze: epoch seconds until which confidence decay is paused.
   * Set when the fact text contains a future date (reminder, deadline, event).
   * Null = no freeze (normal decay applies).
   */
  decayFreezeUntil?: number | null;
  /**
   * Force-preservation: epoch seconds until which this fact MUST NOT be trimmed.
   * Null = no forced preservation (normal tier-based retention applies).
   * Implemented by trimToBudget().
   */
  preserveUntil?: number | null;
  /**
   * Force-preservation tags: if any of these tags are present, the fact is
   * protected from trimming regardless of importance tier.
   * Set via `memory preserve <id> --tag <tag>`.
   */
  preserveTags?: string[] | null;
};

/** Memory scoping — global (all), user (per-user), agent (per-agent), session (ephemeral). */
export const MEMORY_SCOPES = ["global", "user", "agent", "session"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Scope filter for recall — include global + matching user/agent/session. Empty = all (backward compat). */
export type ScopeFilter = {
  userId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
};

/** One step in a procedure recipe. */
export type ProcedureStep = {
  tool: string;
  args?: Record<string, unknown>;
  summary?: string;
};

/** Stored procedure (procedures table). */
export type ProcedureEntry = {
  id: string;
  taskPattern: string;
  recipeJson: string;
  procedureType: "positive" | "negative";
  successCount: number;
  failureCount: number;
  lastValidated: number | null;
  lastFailed: number | null;
  confidence: number;
  ttlDays: number;
  promotedToSkill: number;
  skillPath: string | null;
  createdAt: number;
  updatedAt: number;
  sourceSessions?: string;
  /** Phase 2: Reinforcement tracking — number of times this procedure was reinforced by user praise. */
  reinforcedCount?: number;
  /** Phase 2: When this procedure was last reinforced (epoch seconds). */
  lastReinforcedAt?: number | null;
  /** Phase 2: Array of user praise quotes that reinforced this procedure. */
  reinforcedQuotes?: string[] | null;
  /** Phase 2: When this procedure was auto-promoted via reinforcement (epoch seconds). */
  promotedAt?: number | null;
  /** Memory scope (global, user, agent, session). */
  scope?: string;
  /** Scope target (userId, agentId, or sessionId). */
  scopeTarget?: string | null;
  /** Procedure feedback loop (#782): highest version number for this procedure. */
  version?: number;
  /** Procedure feedback loop (#782): last known outcome — 'success' | 'failure' | 'unknown'. */
  lastOutcome?: "success" | "failure" | "unknown";
  /** Procedure feedback loop (#782): success rate as a fraction [0,1] (total successes / total attempts). */
  successRate?: number;
  /** Procedure feedback loop (#782): avoidance notes across all versions. */
  avoidanceNotes?: string[];
};

export type SearchResult = {
  entry: MemoryEntry;
  score: number;
  backend: "sqlite" | "lancedb";
};

/** Valid outcome values for an episodic memory record (#781). */
export type EpisodeOutcome = "success" | "failure" | "partial" | "unknown";

/**
 * Episodic memory record — a structured event with an explicit outcome and timestamp (#781).
 * Episodes are stored in the separate `episodes` SQLite table (not in `facts`).
 * They are indexed in LanceDB with category="episode" for semantic search.
 */
export type Episode = {
  id: string;
  /** Discriminated literal — always "episode". */
  category: "episode";
  /** What happened (e.g. "deployed openclaw to production"). */
  event: string;
  /** Outcome of the event. Failures are auto-boosted to importance >= 0.8. */
  outcome: EpisodeOutcome;
  /** Unix epoch seconds — when the event occurred. Defaults to now. */
  timestamp: number;
  /** Optional duration in milliseconds. */
  duration?: number;
  /** Context: environment state, what led up to it, etc. */
  context?: string;
  /** IDs of related facts (linked via memory_links). */
  relatedFactIds?: string[];
  /** ID of the procedure that triggered this episode, if any. */
  procedureId?: string;
  /** Memory scope — global, user, agent, or session. */
  scope: "global" | "user" | "agent" | "session";
  /** Scope target (userId, agentId, or sessionId). Null for global scope. */
  scopeTarget?: string | null;
  agentId?: string;
  userId?: string;
  sessionId?: string;
  importance: number;
  tags: string[];
  decayClass: DecayClass;
  createdAt: number;
  verifiedAt?: number;
};
