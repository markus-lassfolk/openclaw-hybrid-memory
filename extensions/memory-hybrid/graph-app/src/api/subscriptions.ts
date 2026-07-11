/**
 * Live overlay: wire GraphQL SSE subscriptions to the store so the constellation updates in real
 * time as the agent stores, links, supersedes, and recalls memories.
 */
import { gqlSubscribe } from "./client";
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

const FACT_FIELDS = `
  id text category importance confidence decayClass tags entity createdAt
  recallCount accessCount lastAccessedAt reinforcedCount pinned supersededBy
`;
const LINK_FIELDS = `id sourceId targetId linkType weight`;

export function factToNode(f: SubFact): GraphNode {
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
    degree: 0,
    superseded: Boolean(f.supersededBy),
    contradicted: false,
    clusterId: null,
    tags: f.tags ?? [],
    entity: f.entity ?? null,
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
  onConnected: (connected: boolean) => void;
  onError: (err: unknown) => void;
}

/** Start every live subscription; returns a function that tears them all down. */
export function startLiveUpdates(h: LiveHandlers): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    gqlSubscribe<{ factCreated: SubFact }>(`subscription { factCreated { ${FACT_FIELDS} } }`, {
      onData: (d) => h.onFactUpsert(factToNode(d.factCreated), "store"),
      onError: h.onError,
    }),
  );
  unsubs.push(
    gqlSubscribe<{ factUpdated: SubFact }>(`subscription { factUpdated { ${FACT_FIELDS} } }`, {
      onData: (d) => h.onFactUpsert(factToNode(d.factUpdated), "update"),
      onError: h.onError,
    }),
  );
  unsubs.push(
    gqlSubscribe<{ factDeleted: string }>(`subscription { factDeleted }`, {
      onData: (d) => h.onFactDelete(d.factDeleted),
      onError: h.onError,
    }),
  );
  unsubs.push(
    gqlSubscribe<{ linkCreated: SubLink }>(`subscription { linkCreated { ${LINK_FIELDS} } }`, {
      onData: (d) => h.onLinkUpsert(linkToEdge(d.linkCreated), "create"),
      onError: h.onError,
    }),
  );
  unsubs.push(
    gqlSubscribe<{ linkUpdated: SubLink }>(`subscription { linkUpdated { ${LINK_FIELDS} } }`, {
      onData: (d) => h.onLinkUpsert(linkToEdge(d.linkUpdated), "update"),
      onError: h.onError,
    }),
  );
  unsubs.push(
    gqlSubscribe<{ recallOccurred: RecallEvent }>(
      `subscription { recallOccurred { query source sessionKey occurredAt hits { factId score } } }`,
      { onData: (d) => h.onRecall(d.recallOccurred), onError: h.onError },
    ),
  );

  // The SSE clients connect lazily; assume connected once subscriptions are registered.
  h.onConnected(true);

  return () => {
    for (const u of unsubs) {
      try {
        u();
      } catch {
        // ignore teardown errors
      }
    }
    h.onConnected(false);
  };
}
