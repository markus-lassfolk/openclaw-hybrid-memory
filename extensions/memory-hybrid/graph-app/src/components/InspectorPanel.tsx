import { useEffect, useState } from "react";
import { GraphQLAuthError } from "../api/client";
import { type FactWithLinks, fetchFact, pinFact, unpinFact } from "../api/queries";
import { useGraphStore } from "../store/graphStore";
import { categoryColor, COLORS, linkColor } from "../theme";

/** Right panel: detail for the selected star — text, provenance, metrics, neighbors, pin toggle. */
export function InspectorPanel() {
  const selectedId = useGraphStore((s) => s.selectedId);
  const setSelected = useGraphStore((s) => s.setSelected);
  const nodeIndex = useGraphStore((s) => s.nodeIndex);
  const upsertNode = useGraphStore((s) => s.upsertNode);

  const [fact, setFact] = useState<FactWithLinks | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setFact(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFact(selectedId)
      .then((f) => {
        if (!cancelled) setFact(f);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  if (!selectedId) return null;

  const node = nodeIndex.get(selectedId);
  const pinned = Boolean(fact?.pinned ?? node?.pinned);

  const togglePin = async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      if (pinned) await unpinFact(selectedId);
      else await pinFact(selectedId, "pinned from graph");
      // Optimistic local update (the live subscription also reflects it).
      if (node) upsertNode({ ...node, pinned: !pinned });
      setFact((f) => (f ? { ...f, pinned: !pinned } : f));
    } catch (e) {
      setError(e instanceof GraphQLAuthError ? "A dashboard token is required to pin." : String(e));
    } finally {
      setBusy(false);
    }
  };

  const neighbors = [...(fact?.links ?? []), ...(fact?.linkedFrom ?? [])];

  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className="cat-tag" style={{ background: categoryColor(node?.category ?? "other") }}>
          {node?.category ?? fact?.category ?? "fact"}
        </span>
        <button type="button" className="close" onClick={() => setSelected(null)} aria-label="Close">
          ✕
        </button>
      </div>

      {loading ? <p className="muted">Loading…</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {fact ? (
        <>
          <p className="fact-text">{fact.text}</p>
          {fact.why ? <p className="fact-why">“{fact.why}”</p> : null}

          <div className="metrics">
            <Metric label="strength" value={(node?.strength ?? 0).toFixed(2)} />
            <Metric label="importance" value={fact.importance.toFixed(2)} />
            <Metric label="confidence" value={fact.confidence.toFixed(2)} />
            <Metric label="degree" value={String(node?.degree ?? neighbors.length)} />
            <Metric label="recalls" value={String(node?.recallCount ?? 0)} />
            <Metric label="decay" value={fact.decayClass} />
          </div>

          {fact.tags.length ? (
            <div className="tags">
              {fact.tags.map((t) => (
                <span key={t} className="tag">
                  #{t}
                </span>
              ))}
            </div>
          ) : null}

          <div className="actions">
            <button type="button" onClick={togglePin} disabled={busy}>
              {pinned ? "Unpin" : "Pin"}
            </button>
          </div>

          <div className="neighbors">
            <div className="neighbors-head">Bonds · {neighbors.length}</div>
            {neighbors.slice(0, 24).map((l) => {
              const otherId = l.sourceId === selectedId ? l.targetId : l.sourceId;
              const other = nodeIndex.get(otherId);
              return (
                <button
                  type="button"
                  key={l.id}
                  className="neighbor"
                  onClick={() => setSelected(otherId)}
                  title={other?.label ?? otherId}
                >
                  <span className="neighbor-type" style={{ color: linkColor(l.linkType) }}>
                    {l.linkType}
                  </span>
                  <span className="neighbor-label">{other?.label ?? otherId.slice(0, 8)}</span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span className="metric-value" style={{ color: COLORS.text }}>
        {value}
      </span>
      <span className="metric-label">{label}</span>
    </div>
  );
}
