import { useCallback, useEffect, useState } from "react";
import { fetchInsights, fetchSuggestedLinks } from "../api/queries";
import type { ContradictionPair, FactDetail, GraphInsights, LinkRecord, SuggestedLink } from "../api/types";
import { acceptSuggested, removeFact, removeLink, resolveConflict } from "../live/curation";
import { useGraphStore } from "../store/graphStore";
import { linkColor } from "../theme";

type Tab = "orphans" | "suggested" | "contradictions" | "weak" | "stale";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "orphans", label: "orphans" },
  { key: "suggested", label: "suggested" },
  { key: "contradictions", label: "conflicts" },
  { key: "weak", label: "weak" },
  { key: "stale", label: "stale" },
];

/** Curation / gap analysis: surface where the graph is thin, conflicting, or drifting, and act on it. */
export function GapsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("orphans");
  const [insights, setInsights] = useState<GraphInsights | null>(null);
  const [suggested, setSuggested] = useState<SuggestedLink[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setSelected = useGraphStore((s) => s.setSelected);

  const loadInsights = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchInsights(25)
      .then(setInsights)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadInsights();
  }, [loadInsights]);

  const loadSuggested = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchSuggestedLinks(0.8, 20)
      .then(setSuggested)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (tab === "suggested" && suggested === null) loadSuggested();
  }, [tab, suggested, loadSuggested]);

  const jump = (id: string) => setSelected(id);

  return (
    <div className="gaps">
      <div className="gaps-head">
        <strong>Gaps &amp; anomalies</strong>
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="gaps-tabs">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            className={`gaps-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">Loading…</p> : null}

      <div className="gaps-body">
        {tab === "orphans" ? (
          <OrphanList facts={insights?.orphanFacts ?? []} onJump={jump} onReload={loadInsights} />
        ) : null}
        {tab === "suggested" ? <SuggestedList items={suggested ?? []} onJump={jump} onReload={loadSuggested} /> : null}
        {tab === "contradictions" ? (
          <ContradictionList items={insights?.contradictions ?? []} onJump={jump} onReload={loadInsights} />
        ) : null}
        {tab === "weak" ? <WeakList links={insights?.weakLinks ?? []} onJump={jump} onReload={loadInsights} /> : null}
        {tab === "stale" ? (
          <FactList facts={insights?.staleImportantFacts ?? []} onJump={jump} empty="No stale important memories." />
        ) : null}
      </div>
    </div>
  );
}

function FactList({ facts, onJump, empty }: { facts: FactDetail[]; onJump: (id: string) => void; empty: string }) {
  if (facts.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="gaps-list">
      {facts.map((f) => (
        <button type="button" key={f.id} className="gaps-item" onClick={() => onJump(f.id)}>
          <span className="gaps-item-text">{f.text}</span>
          <span className="gaps-item-meta">{f.category}</span>
        </button>
      ))}
    </div>
  );
}

function OrphanList({
  facts,
  onJump,
  onReload,
}: {
  facts: FactDetail[];
  onJump: (id: string) => void;
  onReload: () => void;
}) {
  if (facts.length === 0) return <p className="muted">No orphaned memories — everything is connected.</p>;
  return (
    <div className="gaps-list">
      {facts.map((f) => (
        <div key={f.id} className="gaps-item-row">
          <button type="button" className="gaps-item grow" onClick={() => onJump(f.id)}>
            <span className="gaps-item-text">{f.text}</span>
            <span className="gaps-item-meta">{f.category}</span>
          </button>
          <button
            type="button"
            className="danger"
            title="Prune this orphaned memory"
            onClick={async () => {
              if (confirm("Delete this orphaned memory?")) {
                await removeFact(f.id);
                onReload();
              }
            }}
          >
            prune
          </button>
        </div>
      ))}
    </div>
  );
}

function SuggestedList({
  items,
  onJump,
  onReload,
}: {
  items: SuggestedLink[];
  onJump: (id: string) => void;
  onReload: () => void;
}) {
  if (items.length === 0)
    return <p className="muted">No suggested links (needs embeddings + similar unlinked facts).</p>;
  return (
    <div className="gaps-list">
      {items.map((s) => (
        <div key={`${s.sourceId}-${s.targetId}`} className="gaps-suggested">
          <div className="gaps-suggested-pair">
            <button type="button" className="gaps-mini" onClick={() => onJump(s.sourceId)}>
              {s.sourceText.slice(0, 40)}
            </button>
            <span className="gaps-sim">≈ {(s.similarity * 100).toFixed(0)}%</span>
            <button type="button" className="gaps-mini" onClick={() => onJump(s.targetId)}>
              {s.targetText.slice(0, 40)}
            </button>
          </div>
          <button
            type="button"
            className="accent"
            onClick={async () => {
              await acceptSuggested(s.sourceId, s.targetId);
              onReload();
            }}
          >
            link
          </button>
        </div>
      ))}
    </div>
  );
}

function ContradictionList({
  items,
  onJump,
  onReload,
}: {
  items: ContradictionPair[];
  onJump: (id: string) => void;
  onReload: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  if (items.length === 0) return <p className="muted">No unresolved contradictions.</p>;

  const resolve = async (id: string, keepFactId?: string, loserFactId?: string) => {
    setError(null);
    const res = await resolveConflict(id, keepFactId, loserFactId);
    if (!res.ok) setError(res.error ?? "Could not resolve");
    else onReload();
  };

  return (
    <div className="gaps-list">
      {error ? <p className="error">{error}</p> : null}
      {items.map((c) => (
        <div key={c.id} className="gaps-conflict-block">
          <div className="gaps-conflict">
            {c.factNew ? (
              <button type="button" className="gaps-mini" onClick={() => c.factNew && onJump(c.factNew.id)}>
                {c.factNew.text.slice(0, 46)}
              </button>
            ) : null}
            <span className="gaps-vs">⚔</span>
            {c.factOld ? (
              <button type="button" className="gaps-mini" onClick={() => c.factOld && onJump(c.factOld.id)}>
                {c.factOld.text.slice(0, 46)}
              </button>
            ) : null}
          </div>
          <div className="gaps-conflict-actions">
            {c.factNew && c.factOld ? (
              <>
                <button
                  type="button"
                  className="accent"
                  title="Keep the newer fact; the older one is superseded by it"
                  onClick={() => c.factNew && c.factOld && void resolve(c.id, c.factNew.id, c.factOld.id)}
                >
                  keep new
                </button>
                <button
                  type="button"
                  title="Keep the older fact; the newer one is superseded by it"
                  onClick={() => c.factNew && c.factOld && void resolve(c.id, c.factOld.id, c.factNew.id)}
                >
                  keep old
                </button>
              </>
            ) : null}
            <button
              type="button"
              title="Both facts stand — mark the conflict reviewed"
              onClick={() => void resolve(c.id)}
            >
              both fine
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function WeakList({
  links,
  onJump,
  onReload,
}: {
  links: LinkRecord[];
  onJump: (id: string) => void;
  onReload: () => void;
}) {
  const nodeIndex = useGraphStore((s) => s.nodeIndex);
  if (links.length === 0) return <p className="muted">No weak links below the threshold.</p>;
  return (
    <div className="gaps-list">
      {links.map((l) => (
        <div key={l.id} className="gaps-item-row">
          <button type="button" className="gaps-item grow" onClick={() => onJump(l.sourceId)}>
            <span className="gaps-item-text">
              {nodeIndex.get(l.sourceId)?.label ?? l.sourceId.slice(0, 8)} →{" "}
              {nodeIndex.get(l.targetId)?.label ?? l.targetId.slice(0, 8)}
            </span>
            <span className="gaps-item-meta" style={{ color: linkColor(l.linkType) }}>
              {l.linkType} · {l.weight.toFixed(2)}
            </span>
          </button>
          <button
            type="button"
            className="danger"
            onClick={async () => {
              await removeLink(l.id);
              onReload();
            }}
          >
            cut
          </button>
        </div>
      ))}
    </div>
  );
}
