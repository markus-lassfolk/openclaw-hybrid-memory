/**
 * Client-side community detection (Louvain) over the loaded graph. Assigns each node a clusterId so
 * the canvas can color communities and the app can surface how memories group together — without a
 * server round-trip. Runs on load and after the topology changes materially.
 *
 * graphology + the Louvain algorithm are loaded lazily (dynamic import) so they live in their own
 * chunk: visitors who never turn on cluster coloring don't pay for them in the initial bundle.
 */
import type { GraphEdge, GraphNode, TopicCluster } from "../api/types";

/** Returns a map of nodeId → clusterId (stringified community index). Empty when there are no edges. */
export async function detectClusters(nodes: GraphNode[], edges: GraphEdge[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (nodes.length === 0) return result;

  const [{ default: Graph }, { default: louvain }] = await Promise.all([
    import("graphology"),
    import("graphology-communities-louvain"),
  ]);

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

/**
 * Name each Louvain community. Server topic-cluster labels win (plurality of members, min 2 votes);
 * communities the server doesn't know get a dominant entity / tag fallback so hulls are still
 * readable when maintenance hasn't produced clusters yet.
 */
export function labelCommunities(
  nodes: GraphNode[],
  communities: Map<string, string>,
  serverClusters: TopicCluster[],
): Map<string, string> {
  // Server label votes: community → label → member count.
  const votes = new Map<string, Map<string, number>>();
  for (const sc of serverClusters) {
    for (const factId of sc.factIds) {
      const community = communities.get(factId);
      if (!community) continue;
      const byLabel = votes.get(community) ?? new Map<string, number>();
      byLabel.set(sc.label, (byLabel.get(sc.label) ?? 0) + 1);
      votes.set(community, byLabel);
    }
  }

  const labels = new Map<string, string>();
  for (const [community, byLabel] of votes) {
    let best: string | null = null;
    let bestCount = 0;
    for (const [label, count] of byLabel) {
      if (count > bestCount) {
        best = label;
        bestCount = count;
      }
    }
    if (best && bestCount >= 2) labels.set(community, best);
  }

  // Fallback: dominant entity (then tag) among the community's nodes.
  const term = new Map<string, Map<string, number>>();
  for (const n of nodes) {
    const community = communities.get(n.id);
    if (!community || labels.has(community)) continue;
    const key = n.entity ?? n.tags?.[0];
    if (!key) continue;
    const byTerm = term.get(community) ?? new Map<string, number>();
    byTerm.set(key, (byTerm.get(key) ?? 0) + 1);
    term.set(community, byTerm);
  }
  for (const [community, byTerm] of term) {
    let best: string | null = null;
    let bestCount = 0;
    for (const [t, count] of byTerm) {
      if (count > bestCount) {
        best = t;
        bestCount = count;
      }
    }
    if (best && bestCount >= 2) labels.set(community, best);
  }

  return labels;
}
