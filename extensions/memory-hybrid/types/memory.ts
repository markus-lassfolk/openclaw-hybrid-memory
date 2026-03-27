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
};

export type SearchResult = {
  entry: MemoryEntry;
  score: number;
  backend: "sqlite" | "lancedb";
};

/** Outcome of an episodic event — discriminated literal for type-safe filtering. */
export type EpisodeOutcome = "success" | "failure" | "partial" | "unknown";

/**
 * Episodic memory entry — structured event/outcome storage with timestamps (#781).
 * Episodes are stored in the episodes table (with indexed outcome+timestamp columns)
 * and mirrored as vectors in LanceDB (same table as facts, filtered by category="episode").
 *
 * Episodes with outcome="failure" are auto-boosted to importance >= 0.8 at store time.
 */
export type EpisodeEntry = {
  id: string;
  category: "episode";
  /** What happened (e.g. "deployed openclaw to Doris", "upgraded Doris"). */
  event: string;
  /** Discriminated outcome — used as first-class filter column in SQLite. */
  outcome: EpisodeOutcome;
  /** Unix epoch (seconds) — when the event occurred. */
  timestamp: number;
  /** Optional: how long the event took in milliseconds. */
  duration?: number;
  /** Context: what led up to it, environment state, etc. */
  context?: string;
  /** Related fact IDs for graph traversal. */
  relatedFactIds?: string[];
  /** Procedure that triggered this episode (if applicable). */
  procedureId?: string;
  /** Standard memory fields */
  importance: number;
  decayClass: DecayClass;
  scope: MemoryScope;
  agentId?: string;
  userId?: string;
  sessionId?: string;
  tags: string[];
  createdAt: number;
  verifiedAt?: number;
};
