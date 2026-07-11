import { useCallback, useEffect, useState } from "react";
import { fetchGraph, fetchRecentRecalls } from "./api/queries";
import { ActivityFeed } from "./components/ActivityFeed";
import { AddFactDialog } from "./components/AddFactDialog";
import { FiltersSidebar } from "./components/FiltersSidebar";
import { GapsPanel } from "./components/GapsPanel";
import { Header } from "./components/Header";
import { InspectorPanel } from "./components/InspectorPanel";
import { TokenSettings } from "./components/TokenSettings";
import { GraphCanvas } from "./graph/GraphCanvas";
import { useClusterLabels, useClustering, useLiveUpdates } from "./live/useLiveUpdates";
import { useGraphStore } from "./store/graphStore";

const MAX_NODES = 2000;

export function App() {
  const loading = useGraphStore((s) => s.loading);
  const error = useGraphStore((s) => s.error);
  const hasNodes = useGraphStore((s) => s.nodes.length > 0);
  const mergeGraph = useGraphStore((s) => s.mergeGraph);
  const setLoading = useGraphStore((s) => s.setLoading);
  const setError = useGraphStore((s) => s.setError);
  const seedActivity = useGraphStore((s) => s.seedActivity);

  // Base graph load, also used as the reconnect resync: merge (not replace) so a background
  // reconcile keeps every settled node exactly where it was, pruning only what the server dropped.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { graph, stats } = await fetchGraph(MAX_NODES);
      mergeGraph(graph.nodes, graph.edges, { stats, prune: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e; // let the live supervisor know the resync failed
    }
  }, [mergeGraph, setLoading, setError]);

  useEffect(() => {
    load().catch(() => {
      // initial-load failure already surfaced via the error overlay
    });
  }, [load]);

  // Hydrate the activity feed with recent recall history (persisted recall_events) so the panel
  // shows what the agent has been recalling lately, not just from-now-on. Best-effort.
  useEffect(() => {
    if (useGraphStore.getState().activity.length > 0) return; // StrictMode double-mount guard
    fetchRecentRecalls(15)
      .then((events) => {
        if (useGraphStore.getState().activity.some((a) => a.kind === "recall")) return;
        seedActivity(
          events.map((ev) => ({
            kind: "recall" as const,
            label: ev.query ? `recall · ${ev.query}` : `recall · ${ev.hits.length} memories`,
            at: ev.occurredAt * 1000,
          })),
        );
      })
      .catch(() => {
        // history is a nicety — the live stream still populates the feed
      });
  }, [seedActivity]);

  // Live overlay (supervised, resyncs via `load` after gaps) + community detection + hull labels.
  useLiveUpdates(load);
  useClustering();
  useClusterLabels();

  const [gapsOpen, setGapsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="app">
      <GraphCanvas />
      <Header />
      <FiltersSidebar />
      <InspectorPanel />
      <ActivityFeed />

      <div className="toolbar">
        <button type="button" onClick={() => setAddOpen(true)}>
          + memory
        </button>
        <button type="button" className={gapsOpen ? "accent" : ""} onClick={() => setGapsOpen((o) => !o)}>
          gaps
        </button>
        <TokenSettings />
      </div>
      {gapsOpen ? <GapsPanel onClose={() => setGapsOpen(false)} /> : null}
      {addOpen ? <AddFactDialog onClose={() => setAddOpen(false)} /> : null}

      {loading && !hasNodes ? <div className="overlay">Charting the constellation…</div> : null}
      {error ? (
        <div className="overlay error-overlay">
          <p>Could not load the graph.</p>
          <p className="muted">{error}</p>
          <button
            type="button"
            onClick={() => {
              load().catch(() => {});
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      {!loading && !error && !hasNodes ? (
        <div className="overlay">No memories yet — store some facts and they will appear here.</div>
      ) : null}
    </div>
  );
}
