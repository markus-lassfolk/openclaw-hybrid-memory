import { useEffect, useState } from "react";
import { type FactWithLinks, fetchFact } from "../api/queries";
import { changeLink, editFactText, removeFact, removeLink, setPinned } from "../live/curation";
import { useGraphStore } from "../store/graphStore";
import { categoryColor, COLORS, linkColor } from "../theme";
import { LINK_TYPES } from "../api/types";

/** Right panel: detail + full curation for the selected star. */
export function InspectorPanel() {
  const selectedId = useGraphStore((s) => s.selectedId);
  const setSelected = useGraphStore((s) => s.setSelected);
  const nodeIndex = useGraphStore((s) => s.nodeIndex);
  const linkingFrom = useGraphStore((s) => s.linkingFrom);
  const setLinkingFrom = useGraphStore((s) => s.setLinkingFrom);

  const [fact, setFact] = useState<FactWithLinks | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!selectedId) {
      setFact(null);
      setEditing(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFact(selectedId)
      .then((f) => {
        if (!cancelled) {
          setFact(f);
          setDraft(f?.text ?? "");
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId, reloadKey]);

  if (!selectedId) return null;
  const node = nodeIndex.get(selectedId);
  const pinned = Boolean(fact?.pinned ?? node?.pinned);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) setError(res.error ?? "Action failed");
    else after?.();
  };

  const neighbors = [...(fact?.links ?? []), ...(fact?.linkedFrom ?? [])];

  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className="cat-tag" style={{ background: categoryColor(node?.category ?? fact?.category ?? "other") }}>
          {node?.category ?? fact?.category ?? "fact"}
        </span>
        <button type="button" className="close" onClick={() => setSelected(null)} aria-label="Close">
          ✕
        </button>
      </div>

      {loading ? <p className="muted">Loading…</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {linkingFrom === selectedId ? <p className="linking-hint">Click another star to bond it here…</p> : null}

      {fact ? (
        <>
          {editing ? (
            <div className="edit-box">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
              <div className="actions">
                <button
                  type="button"
                  className="accent"
                  disabled={busy || !draft.trim()}
                  onClick={() => run(() => editFactText(selectedId, draft.trim()), () => setEditing(false))}
                >
                  Save
                </button>
                <button type="button" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
              <p className="muted small">Saving supersedes the old text and re-embeds it.</p>
            </div>
          ) : (
            <p className="fact-text">{fact.text}</p>
          )}

          <div className="metrics">
            <Metric label="strength" value={(node?.strength ?? 0).toFixed(2)} />
            <Metric label="importance" value={fact.importance.toFixed(2)} />
            <Metric label="confidence" value={fact.confidence.toFixed(2)} />
            <Metric label="degree" value={String(node?.degree ?? neighbors.length)} />
            <Metric label="recalls" value={String(node?.recallCount ?? 0)} />
            <Metric label="decay" value={fact.decayClass} />
          </div>

          {!editing ? (
            <div className="actions wrap">
              <button type="button" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" disabled={busy} onClick={() => run(() => setPinned(selectedId, !pinned))}>
                {pinned ? "Unpin" : "Pin"}
              </button>
              <button
                type="button"
                disabled={busy}
                className={linkingFrom === selectedId ? "accent" : ""}
                onClick={() => setLinkingFrom(linkingFrom === selectedId ? null : selectedId)}
              >
                {linkingFrom === selectedId ? "Cancel bond" : "Add bond"}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  if (confirm("Delete this memory? This cannot be undone.")) {
                    void run(() => removeFact(selectedId), () => setSelected(null));
                  }
                }}
              >
                Delete
              </button>
            </div>
          ) : null}

          <div className="neighbors">
            <div className="neighbors-head">Bonds · {neighbors.length}</div>
            {neighbors.slice(0, 24).map((l) => {
              const otherId = l.sourceId === selectedId ? l.targetId : l.sourceId;
              const other = nodeIndex.get(otherId);
              return (
                <div key={l.id} className="neighbor-row">
                  <button type="button" className="neighbor grow" onClick={() => setSelected(otherId)}>
                    <span className="neighbor-label">{other?.label ?? otherId.slice(0, 10)}</span>
                  </button>
                  <select
                    className="link-type"
                    value={l.linkType}
                    style={{ color: linkColor(l.linkType) }}
                    disabled={busy}
                    onChange={(e) => run(() => changeLink(l.id, e.target.value), () => setReloadKey((k) => k + 1))}
                  >
                    {LINK_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="danger mini"
                    title="Remove bond"
                    disabled={busy}
                    onClick={() => run(() => removeLink(l.id), () => setReloadKey((k) => k + 1))}
                  >
                    ✕
                  </button>
                </div>
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
