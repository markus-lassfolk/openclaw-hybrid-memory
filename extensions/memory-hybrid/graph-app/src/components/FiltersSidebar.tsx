import { useEffect, useMemo, useRef, useState } from "react";
import { searchMemories } from "../api/queries";
import type { SearchHit } from "../api/types";
import { expandNeighborhood } from "../live/curation";
import { type ColorMode, useGraphStore } from "../store/graphStore";
import { categoryColor } from "../theme";

const COLOR_MODES: Array<{ key: ColorMode; label: string; hint: string }> = [
  { key: "category", label: "category", hint: "hue by memory kind" },
  { key: "cluster", label: "cluster", hint: "hue by community, labeled hulls" },
  { key: "decay", label: "decay", hint: "green fresh → red stale/expiring" },
];

/** Left controls: search (view filter + full-store find), color mode, category toggles, sliders. */
export function FiltersSidebar() {
  const nodes = useGraphStore((s) => s.nodes);
  const filters = useGraphStore((s) => s.filters);
  const setFilters = useGraphStore((s) => s.setFilters);
  const colorMode = useGraphStore((s) => s.colorMode);
  const setColorMode = useGraphStore((s) => s.setColorMode);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) set.add(n.category);
    return [...set].sort();
  }, [nodes]);

  const toggleCategory = (cat: string) => {
    const next = new Set(filters.categories);
    if (next.has(cat)) next.delete(cat);
    else next.add(cat);
    setFilters({ categories: next });
  };

  return (
    <div className="sidebar">
      <label className="control">
        <span>search</span>
        <input
          type="search"
          placeholder="text or entity…"
          value={filters.search}
          onChange={(e) => setFilters({ search: e.target.value })}
        />
      </label>
      <ServerSearchResults query={filters.search} />

      <div className="control">
        <span>color by</span>
        <div className="seg">
          {COLOR_MODES.map((m) => (
            <button
              type="button"
              key={m.key}
              title={m.hint}
              className={colorMode === m.key ? "active" : ""}
              onClick={() => setColorMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="control">
        <span>min strength · {filters.minStrength.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.02}
          value={filters.minStrength}
          onChange={(e) => setFilters({ minStrength: Number(e.target.value) })}
        />
      </div>

      <label className="control checkbox">
        <input
          type="checkbox"
          checked={filters.showSuperseded}
          onChange={(e) => setFilters({ showSuperseded: e.target.checked })}
        />
        <span>show superseded</span>
      </label>

      <div className="control">
        <span>categories {filters.categories.size > 0 ? `(${filters.categories.size})` : "(all)"}</span>
        <div className="chips">
          {categories.map((cat) => {
            const active = filters.categories.size === 0 || filters.categories.has(cat);
            return (
              <button
                type="button"
                key={cat}
                className={`chip ${active ? "active" : ""}`}
                onClick={() => toggleCategory(cat)}
                style={active ? { borderColor: categoryColor(cat) } : undefined}
              >
                <span className="legend-dot" style={{ background: categoryColor(cat) }} />
                {cat}
              </button>
            );
          })}
        </div>
      </div>
      <p className="hint">scroll to zoom · drag to pan · click a star for detail · double-click to expand</p>
    </div>
  );
}

/**
 * Full-store results under the search box: the input already narrows the LOADED view live; these
 * are server-side hits (scope-filtered, whole store), so memories outside the loaded top-N are
 * findable too. Picking one merges its neighborhood into the view and flies to it.
 */
function ServerSearchResults({ query }: { query: string }) {
  const nodeIndex = useGraphStore((s) => s.nodeIndex);
  const setFocusNode = useGraphStore((s) => s.setFocusNode);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const mySeq = ++seq.current;
    const timer = window.setTimeout(() => {
      searchMemories(q, 6)
        .then((results) => {
          if (seq.current === mySeq) setHits(results);
        })
        .catch(() => {
          if (seq.current === mySeq) setHits([]);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  if (query.trim().length < 2 || hits.length === 0) return null;

  const jump = async (id: string) => {
    if (!nodeIndex.has(id)) {
      // Outside the loaded view: pull the node + its immediate neighbors in first.
      setBusy(true);
      await expandNeighborhood(id);
      setBusy(false);
    }
    setFocusNode(id);
  };

  return (
    <div className="search-results">
      <span className="search-results-head">in the full store{busy ? " · fetching…" : ""}</span>
      {hits.map((h) => (
        <button type="button" key={h.fact.id} className="search-result" onClick={() => void jump(h.fact.id)}>
          <span className="legend-dot" style={{ background: categoryColor(h.fact.category) }} />
          <span className="search-result-text">
            {h.fact.text.length > 60 ? `${h.fact.text.slice(0, 60)}…` : h.fact.text}
          </span>
          {!nodeIndex.has(h.fact.id) ? <span className="search-result-out">outside view</span> : null}
        </button>
      ))}
    </div>
  );
}
