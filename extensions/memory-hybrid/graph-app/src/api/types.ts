/** Shared domain types mirroring the plugin's GraphQL schema (routes/graphql-schema.ts). */

export interface GraphNode {
  id: string;
  label: string;
  category: string;
  importance: number;
  confidence: number;
  decayClass: string;
  strength: number;
  recallCount?: number | null;
  accessCount?: number | null;
  lastAccessedAt?: string | number | null;
  reinforcedCount?: number | null;
  pinned?: boolean | null;
  degree?: number | null;
  superseded?: boolean | null;
  contradicted?: boolean | null;
  clusterId?: string | null;
  tags?: string[] | null;
  entity?: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  linkType: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface MemoryStats {
  totalFacts: number;
  activeFactsCount: number;
  supersededFactsCount: number;
  totalLinks: number;
  factsByCategory: Array<{ category: string; count: number }>;
}

export interface FactDetail {
  id: string;
  text: string;
  why?: string | null;
  category: string;
  importance: number;
  confidence: number;
  decayClass: string;
  source?: string | null;
  tags: string[];
  entity?: string | null;
  createdAt: number;
  pinned?: boolean | null;
}

export interface LinkRecord {
  id: string;
  sourceId: string;
  targetId: string;
  linkType: string;
  weight: number;
}

export interface SuggestedLink {
  sourceId: string;
  targetId: string;
  sourceText: string;
  targetText: string;
  similarity: number;
}

export interface ContradictionPair {
  id: string;
  factNew?: { id: string; text: string } | null;
  factOld?: { id: string; text: string } | null;
  detectedAt?: string | number | null;
}

export interface GraphInsights {
  orphanFacts: FactDetail[];
  weakLinks: LinkRecord[];
  contradictions: ContradictionPair[];
  staleImportantFacts: FactDetail[];
}

/** Live recall event (subscription payload). */
export interface RecallEvent {
  query?: string | null;
  source: string;
  sessionKey?: string | null;
  occurredAt: number;
  hits: Array<{ factId: string; score: number }>;
}

/** Known typed link kinds + a stable color per kind (kept in sync with the plugin). */
export const LINK_TYPES = [
  "RELATED_TO",
  "CAUSED_BY",
  "PART_OF",
  "DEPENDS_ON",
  "SUPERSEDES",
  "INSTANCE_OF",
  "CONTRADICTS",
] as const;
export type LinkType = (typeof LINK_TYPES)[number];
