/**
 * Live overlay: wire GraphQL SSE subscriptions to the store so the constellation updates in real
 * time as the agent stores, links, supersedes, and recalls memories.
 */
import { gqlSubscribe } from "./client";
import {
  FACT_CREATED_SUBSCRIPTION,
  FACT_DELETED_SUBSCRIPTION,
  FACT_UPDATED_SUBSCRIPTION,
  LINK_CREATED_SUBSCRIPTION,
  LINK_UPDATED_SUBSCRIPTION,
  RECALL_OCCURRED_SUBSCRIPTION,
} from "./documents";
import { estimateStrength } from "./strength";
import type { GraphEdge, GraphNode, RecallEvent } from "./types";

interface SubFact {
  id: string;
  text: string;
  category: string;
  importance: number;
  confidence: number;
  decayClass: string;
  tags?: string[] | null;
  entity?: string | null;
  createdAt?: number | null;
  expiresAt?: number | null;
  recallCount?: number | null;
  accessCount?: number | null;
  lastAccessedAt?: string | number | null;
  reinforcedCount?: number | null;
  pinned?: boolean | null;
  supersededBy?: string | null;
}

interface SubLink {
  id: string;
  sourceId: string;
  targetId: string;
  linkType: string;
  weight: number;
}

export function factToNode(f: SubFact): GraphNode {
  // NOTE: a Fact subscription payload does NOT carry the server-computed degree / contradicted /
  // clusterId. Those are deliberately OMITTED here so that upsertNode's Object.assign onto an
  // existing node preserves the values from the last full graph load instead of resetting them
  // (degree→0, contradicted→false, clusterId→null) on every live update. A brand-new node simply
  // starts without them, which the canvas + inspector already treat as sensible defaults.
  return {
    id: f.id,
    label: f.text.length > 50 ? `${f.text.slice(0, 50)}…` : f.text,
    category: f.category,
    importance: f.importance,
    confidence: f.confidence,
    decayClass: f.decayClass,
    strength: estimateStrength({
      importance: f.importance,
      confidence: f.confidence,
      recallCount: f.recallCount,
      lastAccessedAt: f.lastAccessedAt,
      createdAt: f.createdAt,
      textLength: f.text.length,
      pinned: f.pinned,
    }),
    recallCount: f.recallCount ?? 0,
    accessCount: f.accessCount ?? 0,
    lastAccessedAt: f.lastAccessedAt ?? null,
    reinforcedCount: f.reinforcedCount ?? 0,
    pinned: Boolean(f.pinned),
    superseded: Boolean(f.supersededBy),
    tags: f.tags ?? [],
    entity: f.entity ?? null,
    expiresAt: f.expiresAt ?? null,
    createdAt: f.createdAt ?? null,
  };
}

function linkToEdge(l: SubLink): GraphEdge & { id: string } {
  return { id: l.id, source: l.sourceId, target: l.targetId, linkType: l.linkType, weight: l.weight };
}

export interface LiveHandlers {
  onFactUpsert: (node: GraphNode, kind: "store" | "update") => void;
  onFactDelete: (id: string) => void;
  onLinkUpsert: (edge: GraphEdge & { id: string }, kind: "create" | "update") => void;
  onRecall: (event: RecallEvent) => void;
  /** A subscription transport failed (after graphql-sse's own retries). The supervisor restarts. */
  onError: (err: unknown) => void;
}

/** Start every live subscription; returns a function that tears them all down. */
export function startLiveUpdates(h: LiveHandlers): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    gqlSubscribe<{ factCreated: SubFact }>(FACT_CREATED_SUBSCRIPTION, {
      onData: (d) => h.onFactUpsert(factToNode(d.factCreated), "store"),
      onError: h.onError,
    }),
  );
  unsubs.push(
    gqlSubscribe<{ factUpdated: SubFact }>(FACT_UPDATED_SUBSCRIPTION, {
      onData: (d) => h.onFactUpsert(factToNode(d.factUpdated), "update"),
      onError: h.onError,
    }),
  );
  unsubs.push(
    gqlSubscribe<{ factDeleted: string }>(FACT_DELETED_SUBSCRIPTION, {
      onData: (d) => h.onFactDelete(d.factDeleted),
      onError: h.onError,
    }),
  );
  unsubs.push(
    gqlSubscribe<{ linkCreated: SubLink }>(LINK_CREATED_SUBSCRIPTION, {
      onData: (d) => h.onLinkUpsert(linkToEdge(d.linkCreated), "create"),
      onError: h.onError,
    }),
  );
  unsubs.push(
    gqlSubscribe<{ linkUpdated: SubLink }>(LINK_UPDATED_SUBSCRIPTION, {
      onData: (d) => h.onLinkUpsert(linkToEdge(d.linkUpdated), "update"),
      onError: h.onError,
    }),
  );
  unsubs.push(
    gqlSubscribe<{ recallOccurred: RecallEvent }>(RECALL_OCCURRED_SUBSCRIPTION, {
      onData: (d) => h.onRecall(d.recallOccurred),
      onError: h.onError,
    }),
  );

  return () => {
    for (const u of unsubs) {
      try {
        u();
      } catch {
        // ignore teardown errors
      }
    }
  };
}
