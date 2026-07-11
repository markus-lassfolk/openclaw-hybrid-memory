import { useCallback, useEffect, useState } from "react";
import { fetchGraph } from "./api/queries";
import { ActivityFeed } from "./components/ActivityFeed";
import { AddFactDialog } from "./components/AddFactDialog";
import { FiltersSidebar } from "./components/FiltersSidebar";
import { GapsPanel } from "./components/GapsPanel";
import { Header } from "./components/Header";
import { InspectorPanel } from "./components/InspectorPanel";
import { TokenSettings } from "./components/TokenSettings";
import { GraphCanvas } from "./graph/GraphCanvas";
import { useClustering, useLiveUpdates } from "./live/useLiveUpdates";
import { useGraphStore } from "./store/graphStore";

const MAX_NODES = 2000;

export function App() {
  const loading = useGraphStore((s) => s.loading);
  const error = useGraphStore((s) => s.error);
  const hasNodes = useGraphStore((s) => s.nodes.length > 0);
  const setGraph = useGraphStore((s) => s.setGraph);
  const setLoading = useGraphStore((s) => s.setLoading);
  const setError = useGraphStore((s) => s.setError);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { graph, stats } = await fetchGraph(MAX_NODES);
      setGraph(graph.nodes, graph.edges, stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [setGraph, setLoading, setError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live overlay + client-side community detection.
  useLiveUpdates();
  useClustering();

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
          <button type="button" onClick={() => void load()}>
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
