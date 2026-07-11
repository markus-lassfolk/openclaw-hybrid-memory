/**
 * Central app state (zustand). Holds the constellation (nodes/edges), filters, selection, live
 * activity, and recall pulses.
 *
 * Position preservation: react-force-graph mutates node objects in place with x/y/vx/vy. So on a
 * live upsert of an existing node we MUTATE the stored object (Object.assign) rather than replacing
 * it — the force simulation keeps that node where it was instead of snapping it back to the center.
 * A fresh array wrapper is published each change so React re-renders, but the element identities are
 * stable.
 */
import { create } from "zustand";
import type { GraphEdge, GraphNode, MemoryStats } from "../api/types";

export interface Filters {
  /** Empty set = all categories visible. */
  categories: Set<string>;
  minStrength: number;
  showSuperseded: boolean;
  search: string;
}

export type ActivityKind = "store" | "recall" | "link" | "update" | "delete";
export interface ActivityItem {
  id: number;
  kind: ActivityKind;
  label: string;
  at: number;
}

/**
 * Stable key for an edge in the store index. Real links are keyed by their row `id` so a link-type
 * change (same id, new type) updates the existing edge in place instead of adding a duplicate, and a
 * delete can find it. Synthetic edges without an id (e.g. superseded_by) fall back to endpoints.
 */
export function edgeId(e: Pick<GraphEdge, "id" | "source" | "target" | "linkType">): string {
  return e.id ?? `${e.source}|${e.target}|${e.linkType}`;
}

interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeIndex: Map<string, GraphNode>;
  edgeIndex: Map<string, GraphEdge>;
  stats: MemoryStats | null;
  filters: Filters;
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  /** factId → expiry timestamp (ms) for a live recall pulse ring. */
  pulses: Map<string, number>;
  activity: ActivityItem[];
  /** nodeId → clusterId (client-side Louvain). */
  clusters: Map<string, string>;
  colorByCluster: boolean;
  /** When set, the next node click bonds it to this source fact instead of selecting it. */
  linkingFrom: string | null;

  setGraph: (nodes: GraphNode[], edges: GraphEdge[], stats: MemoryStats | null) => void;
  upsertNode: (node: GraphNode) => void;
  removeNode: (id: string) => void;
  upsertEdge: (edge: GraphEdge) => void;
  removeEdgeById: (id: string) => void;
  setSelected: (id: string | null) => void;
  setFilters: (partial: Partial<Filters>) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setConnected: (connected: boolean) => void;
  setStats: (stats: MemoryStats) => void;
  pulse: (factIds: string[], ttlMs?: number) => void;
  prunePulses: () => void;
  addActivity: (kind: ActivityKind, label: string) => void;
  setClusters: (clusters: Map<string, string>) => void;
  setColorByCluster: (on: boolean) => void;
  setLinkingFrom: (id: string | null) => void;
}

let activitySeq = 0;
const MAX_ACTIVITY = 60;

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  nodeIndex: new Map(),
  edgeIndex: new Map(),
  stats: null,
  filters: { categories: new Set(), minStrength: 0, showSuperseded: false, search: "" },
  selectedId: null,
  loading: false,
  error: null,
  connected: false,
  pulses: new Map(),
  activity: [],
  clusters: new Map(),
  colorByCluster: false,
  linkingFrom: null,

  setGraph: (nodes, edges, stats) => {
    const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
    const edgeIndex = new Map(edges.map((e) => [edgeId(e), e]));
    set({ nodes: [...nodes], edges: [...edges], nodeIndex, edgeIndex, stats, loading: false, error: null });
  },

  upsertNode: (node) => {
    const { nodeIndex, nodes } = get();
    const existing = nodeIndex.get(node.id);
    if (existing) {
      // Preserve force-graph's x/y/vx/vy by mutating in place.
      Object.assign(existing, node);
      set({ nodes: [...nodes] });
    } else {
      nodeIndex.set(node.id, node);
      set({ nodes: [...nodes, node], nodeIndex });
    }
  },

  removeNode: (id) => {
    const { nodeIndex, edgeIndex } = get();
    if (!nodeIndex.has(id)) return;
    nodeIndex.delete(id);
    // Drop incident edges too.
    for (const [key, e] of edgeIndex) {
      if (e.source === id || e.target === id) edgeIndex.delete(key);
    }
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.source !== id && e.target !== id),
      nodeIndex,
      edgeIndex,
      selectedId: s.selectedId === id ? null : s.selectedId,
    }));
  },

  upsertEdge: (edge) => {
    const { edgeIndex, edges, nodeIndex } = get();
    // Only render an edge when both endpoints are present in the current view.
    if (!nodeIndex.has(edge.source) || !nodeIndex.has(edge.target)) return;
    const key = edgeId(edge);
    const existing = edgeIndex.get(key);
    if (existing) {
      // Update in place (a type change carries the same id, so this replaces rather than duplicates)
      // and copy the id from a live echo onto an optimistic edge that lacked it.
      existing.weight = edge.weight;
      existing.linkType = edge.linkType;
      if (edge.id) existing.id = edge.id;
      set({ edges: [...edges] });
    } else {
      edgeIndex.set(key, edge);
      set({ edges: [...edges, edge], edgeIndex });
    }
  },

  removeEdgeById: (id) => {
    set((s) => {
      const edges = s.edges.filter((e) => e.id !== id);
      if (edges.length === s.edges.length) return s;
      const edgeIndex = new Map(edges.map((e) => [edgeId(e), e]));
      return { ...s, edges, edgeIndex };
    });
  },

  setSelected: (id) => set({ selectedId: id }),
  setFilters: (partial) => set((s) => ({ filters: { ...s.filters, ...partial } })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  setConnected: (connected) => set({ connected }),
  setStats: (stats) => set({ stats }),

  pulse: (factIds, ttlMs = 2600) => {
    const { pulses } = get();
    const expiry = performanceNow() + ttlMs;
    for (const id of factIds) pulses.set(id, expiry);
    set({ pulses: new Map(pulses) });
  },

  prunePulses: () => {
    const { pulses } = get();
    const now = performanceNow();
    let changed = false;
    for (const [id, exp] of pulses) {
      if (exp <= now) {
        pulses.delete(id);
        changed = true;
      }
    }
    if (changed) set({ pulses: new Map(pulses) });
  },

  addActivity: (kind, label) => {
    const item: ActivityItem = { id: ++activitySeq, kind, label, at: Date.now() };
    set((s) => ({ activity: [item, ...s.activity].slice(0, MAX_ACTIVITY) }));
  },

  setClusters: (clusters) => set({ clusters }),
  setColorByCluster: (on) => set({ colorByCluster: on }),
  setLinkingFrom: (id) => set({ linkingFrom: id }),
}));

/** performance.now() with a safe fallback (kept out of the store body for testability). */
function performanceNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Derived selector: nodes passing the active filters. */
export function selectVisibleNodes(state: GraphState): GraphNode[] {
  const { categories, minStrength, showSuperseded, search } = state.filters;
  const q = search.trim().toLowerCase();
  return state.nodes.filter((n) => {
    if (categories.size > 0 && !categories.has(n.category)) return false;
    if ((n.strength ?? 0) < minStrength) return false;
    if (!showSuperseded && n.superseded) return false;
    if (q && !n.label.toLowerCase().includes(q) && !(n.entity ?? "").toLowerCase().includes(q)) return false;
    return true;
  });
}
