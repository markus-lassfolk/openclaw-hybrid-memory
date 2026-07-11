/**
 * React hooks wiring the live SSE overlay to the store: a supervising reconnect loop (so the graph
 * never silently drifts after a gap), client-side clustering, and hull labels.
 */
import { useEffect, useRef } from "react";
import { resetSseClient } from "../api/client";
import { fetchTopicClusters } from "../api/queries";
import { startLiveUpdates } from "../api/subscriptions";
import { detectClusters, labelCommunities } from "../graph/clustering";
import { useGraphStore } from "../store/graphStore";

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/**
 * Subscribe to live memory events and apply them to the store as incremental deltas.
 *
 * Supervision: graphql-sse retries transient drops internally, but once a subscription errors out
 * (server restart, long sleep) events emitted during the gap are gone forever. So on failure we
 * tear everything down, re-subscribe with exponential backoff, and — critically — re-run `resync`
 * (the base graph fetch) so the view reconciles with reality instead of silently drifting.
 * `connected` is only reported true when a (re)subscribe + resync round-trip actually succeeded.
 */
export function useLiveUpdates(resync: () => Promise<void>) {
  const upsertNode = useGraphStore((s) => s.upsertNode);
  const removeNode = useGraphStore((s) => s.removeNode);
  const upsertEdge = useGraphStore((s) => s.upsertEdge);
  const pulse = useGraphStore((s) => s.pulse);
  const addActivity = useGraphStore((s) => s.addActivity);
  const setConnected = useGraphStore((s) => s.setConnected);
  const resyncRef = useRef(resync);
  resyncRef.current = resync;

  useEffect(() => {
    let stopped = false;
    let generation = 0;
    let stopCurrent: (() => void) | null = null;
    let retryTimer: number | null = null;
    let backoffMs = INITIAL_RETRY_MS;

    const scheduleRestart = (fromGeneration: number) => {
      // Errors from a torn-down generation (all six subscriptions fail together) coalesce here.
      if (stopped || fromGeneration !== generation || retryTimer != null) return;
      setConnected(false);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        backoffMs = Math.min(backoffMs * 2, MAX_RETRY_MS);
        void start(true);
      }, backoffMs);
    };

    const start = async (isRestart: boolean) => {
      if (stopped) return;
      const gen = ++generation;
      stopCurrent?.();
      if (isRestart) resetSseClient();
      stopCurrent = startLiveUpdates({
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
        onError: () => scheduleRestart(gen),
      });
      if (isRestart) {
        // Reconcile whatever we missed while down. Only a full success flips us back to live.
        try {
          await resyncRef.current();
          if (stopped || gen !== generation) return;
          backoffMs = INITIAL_RETRY_MS;
          setConnected(true);
        } catch {
          scheduleRestart(gen);
        }
      } else {
        setConnected(true);
      }
    };

    // Waking from sleep or coming back online: don't sit out the remaining backoff, try now.
    const kick = () => {
      if (stopped || useGraphStore.getState().connected) return;
      if (retryTimer != null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      backoffMs = INITIAL_RETRY_MS;
      void start(true);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") kick();
    };
    window.addEventListener("online", kick);
    document.addEventListener("visibilitychange", onVisible);

    void start(false);

    return () => {
      stopped = true;
      window.removeEventListener("online", kick);
      document.removeEventListener("visibilitychange", onVisible);
      if (retryTimer != null) window.clearTimeout(retryTimer);
      stopCurrent?.();
      setConnected(false);
    };
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
    let cancelled = false;
    timer.current = window.setTimeout(() => {
      void detectClusters(nodes, edges).then((clusters) => {
        if (cancelled) return;
        // Stamp clusterId back onto the (stable) node objects so the canvas can read it directly.
        for (const n of nodes) n.clusterId = clusters.get(n.id) ?? null;
        setClusters(clusters);
      });
    }, 400);
    return () => {
      cancelled = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [nodes, edges, setClusters]);
}

const CLUSTER_LABELS_TTL_MS = 60_000;
let lastClusterFetch = 0;
let cachedServerClusters: Awaited<ReturnType<typeof fetchTopicClusters>> = [];

/**
 * Name the Louvain hulls while cluster coloring is on: server topic-cluster labels (plurality per
 * community) with a dominant-entity/tag fallback. Server labels are cached for a minute.
 */
export function useClusterLabels() {
  const colorMode = useGraphStore((s) => s.colorMode);
  const clusters = useGraphStore((s) => s.clusters);
  const setClusterLabels = useGraphStore((s) => s.setClusterLabels);

  useEffect(() => {
    if (colorMode !== "cluster" || clusters.size === 0) return;
    let cancelled = false;
    const label = (server: typeof cachedServerClusters) => {
      if (cancelled) return;
      setClusterLabels(labelCommunities(useGraphStore.getState().nodes, clusters, server));
    };
    if (Date.now() - lastClusterFetch < CLUSTER_LABELS_TTL_MS) {
      label(cachedServerClusters);
    } else {
      fetchTopicClusters(2)
        .then((server) => {
          lastClusterFetch = Date.now();
          cachedServerClusters = server;
          label(server);
        })
        .catch(() => label([])); // fallback terms still label the hulls
    }
    return () => {
      cancelled = true;
    };
  }, [colorMode, clusters, setClusterLabels]);
}
