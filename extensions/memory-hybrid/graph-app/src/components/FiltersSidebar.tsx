import { useMemo } from "react";
import { useGraphStore } from "../store/graphStore";
import { categoryColor } from "../theme";

/** Left controls: search, category toggles, min-strength slider, superseded toggle. */
export function FiltersSidebar() {
  const nodes = useGraphStore((s) => s.nodes);
  const filters = useGraphStore((s) => s.filters);
  const setFilters = useGraphStore((s) => s.setFilters);

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
      <p className="hint">scroll to zoom · drag to pan · click a star for detail</p>
    </div>
  );
}
