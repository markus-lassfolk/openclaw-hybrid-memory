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
  /** Reinforcement tracking — number of times this fact was reinforced by user praise. */
  reinforcedCount?: number;
  /** When this fact was last reinforced (epoch seconds). */
  lastReinforcedAt?: number | null;
  /** Array of user praise quotes that reinforced this fact. */
  reinforcedQuotes?: string[] | null;
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
