import { selectVisibleNodes, useGraphStore } from "../store/graphStore";
import { categoryColor, LEGEND_CATEGORIES } from "../theme";

/** Top-left overlay: title, live counts, connection state, and the category legend. */
export function Header() {
  const stats = useGraphStore((s) => s.stats);
  const nodes = useGraphStore((s) => s.nodes);
  const filters = useGraphStore((s) => s.filters);
  const connected = useGraphStore((s) => s.connected);
  const visible = selectVisibleNodes(useGraphStore.getState());
  // touch nodes/filters so the count re-renders on change
  void nodes;
  void filters;

  return (
    <div className="header">
      <div className="title-row">
        <h1>
          Her mind <span className="subtitle">— a living constellation</span>
        </h1>
        <span className={`live-dot ${connected ? "on" : "off"}`} title={connected ? "Live" : "Offline"} />
      </div>
      <div className="counts">
        {visible.length.toLocaleString()} stars
        {stats ? (
          <>
            {" · "}
            {stats.totalLinks.toLocaleString()} bonds
            {" · "}
            {stats.totalFacts.toLocaleString()} memories in all
          </>
        ) : null}
      </div>
      <div className="legend">
        {LEGEND_CATEGORIES.map((cat) => (
          <span key={cat} className="legend-item">
            <span className="legend-dot" style={{ background: categoryColor(cat) }} />
            {cat}
          </span>
        ))}
      </div>
    </div>
  );
}
