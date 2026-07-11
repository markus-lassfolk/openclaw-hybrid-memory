/**
 * Client-side community detection (Louvain) over the loaded graph. Assigns each node a clusterId so
 * the canvas can color communities and the app can surface how memories group together — without a
 * server round-trip. Runs on load and after the topology changes materially.
 */
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { GraphEdge, GraphNode } from "../api/types";

/** Returns a map of nodeId → clusterId (stringified community index). Empty when there are no edges. */
export function detectClusters(nodes: GraphNode[], edges: GraphEdge[]): Map<string, string> {
  const result = new Map<string, string>();
  if (nodes.length === 0) return result;

  const g = new Graph({ type: "undirected", multi: false, allowSelfLoops: false });
  for (const n of nodes) g.addNode(n.id);
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
    if (g.hasEdge(e.source, e.target)) continue;
    g.addEdge(e.source, e.target, { weight: Math.max(0.01, e.weight) });
  }

  // Louvain needs edges to find structure; with none, every node is its own trivial cluster.
  if (g.size === 0) {
    for (const n of nodes) result.set(n.id, n.id);
    return result;
  }

  const communities = louvain(g, { getEdgeWeight: "weight" }) as Record<string, number>;
  for (const [id, community] of Object.entries(communities)) result.set(id, String(community));
  return result;
}

/** Stable-ish color for a cluster id (golden-angle hue rotation). */
export function clusterColor(clusterId: string | null | undefined): string {
  if (!clusterId) return "#64748b";
  let hash = 0;
  for (let i = 0; i < clusterId.length; i++) hash = (hash * 31 + clusterId.charCodeAt(i)) | 0;
  const hue = Math.abs(hash * 137.508) % 360;
  return `hsl(${hue.toFixed(0)}, 62%, 60%)`;
}
