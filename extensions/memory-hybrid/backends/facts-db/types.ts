/** Shared types/constants for FactsDB submodules. */
export const MEMORY_LINK_TYPES = [
  "SUPERSEDES",
  "CAUSED_BY",
  "PART_OF",
  "RELATED_TO",
  "DEPENDS_ON",
  "CONTRADICTS",
  "INSTANCE_OF",
  "DERIVED_FROM",
] as const;

export type MemoryLinkType = (typeof MEMORY_LINK_TYPES)[number];

/** Optional context metadata captured alongside a reinforcement event (#259). */
export interface ReinforcementContext {
  querySnippet?: string;
  topic?: string;
  toolSequence?: string[];
  sessionFile?: string;
}

/** A single entry in the reinforcement_log table (#259). */
export interface ReinforcementEvent {
  id: string;
  factId: string;
  signal: "positive" | "negative";
  querySnippet: string | null;
  topic: string | null;
  toolSequence: string[] | null;
  sessionFile: string | null;
  occurredAt: number;
}
