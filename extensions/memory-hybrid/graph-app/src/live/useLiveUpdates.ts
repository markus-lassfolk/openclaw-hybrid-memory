/**
 * React hook: connect the live SSE overlay to the store, and keep client-side clusters fresh.
 */
import { useEffect, useRef } from "react";
import { startLiveUpdates } from "../api/subscriptions";
import { detectClusters } from "../graph/clustering";
import { useGraphStore } from "../store/graphStore";

/** Subscribe to live memory events and apply them to the store as incremental deltas. */
export function useLiveUpdates() {
  const upsertNode = useGraphStore((s) => s.upsertNode);
  const removeNode = useGraphStore((s) => s.removeNode);
  const upsertEdge = useGraphStore((s) => s.upsertEdge);
  const pulse = useGraphStore((s) => s.pulse);
  const addActivity = useGraphStore((s) => s.addActivity);
  const setConnected = useGraphStore((s) => s.setConnected);

  useEffect(() => {
    const stop = startLiveUpdates({
      onFactUpsert: (node, kind) => {
        upsertNode(node);
        addActivity(kind === "store" ? "store" : "update", node.label);
      },
      onFactDelete: (id) => {
        removeNode(id);
        addActivity("delete", id.slice(0, 8));
      },
      onLinkUpsert: (edge, kind) => {
        upsertEdge(edge);
        if (kind === "create") addActivity("link", `${edge.linkType} bond`);
      },
      onRecall: (event) => {
        const ids = event.hits.map((h) => h.factId);
        pulse(ids);
        addActivity("recall", event.query ? `recall · ${event.query}` : `recall · ${ids.length} memories`);
      },
      onConnected: setConnected,
      onError: () => setConnected(false),
    });
    return stop;
  }, [upsertNode, removeNode, upsertEdge, pulse, addActivity, setConnected]);
}

/** Recompute Louvain clusters when the topology changes (debounced), keeping node.clusterId fresh. */
export function useClustering() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const setClusters = useGraphStore((s) => s.setClusters);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const clusters = detectClusters(nodes, edges);
      // Stamp clusterId back onto the (stable) node objects so the canvas can read it directly.
      for (const n of nodes) n.clusterId = clusters.get(n.id) ?? null;
      setClusters(clusters);
    }, 400);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [nodes, edges, setClusters]);
}
