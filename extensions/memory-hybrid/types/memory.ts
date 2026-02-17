/**
 * Shared memory types used by backends and plugin.
 */

import type { MemoryCategory, DecayClass } from "../config.js";

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
  /** FR-010: When the fact became true in the real world (epoch seconds). */
  validFrom?: number | null;
  /** FR-010: When the fact stopped being true (epoch seconds); null if still current. */
  validUntil?: number | null;
  /** FR-010: Id of the fact this one supersedes (replaces). */
  supersedesId?: string | null;
};

export type SearchResult = {
  entry: MemoryEntry;
  score: number;
  backend: "sqlite" | "lancedb";
};
