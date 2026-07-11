import { useGraphStore } from "../store/graphStore";
import type { ActivityKind } from "../store/graphStore";

const KIND_ICON: Record<ActivityKind, string> = {
  store: "✦",
  recall: "◎",
  link: "⟿",
  update: "✎",
  delete: "✕",
};
const KIND_COLOR: Record<ActivityKind, string> = {
  store: "#60a5fa",
  recall: "#ffffff",
  link: "#a855f7",
  update: "#34d399",
  delete: "#f87171",
};

/** Bottom-left live stream of memory activity (stores, recalls, links) as the agent operates. */
export function ActivityFeed() {
  const activity = useGraphStore((s) => s.activity);
  const connected = useGraphStore((s) => s.connected);

  if (activity.length === 0) {
    return (
      <div className="activity">
        <div className="activity-head">
          <span className={`live-dot ${connected ? "on" : "off"}`} /> live activity
        </div>
        <div className="activity-empty">waiting for the mind to stir…</div>
      </div>
    );
  }

  return (
    <div className="activity">
      <div className="activity-head">
        <span className={`live-dot ${connected ? "on" : "off"}`} /> live activity
      </div>
      <div className="activity-list">
        {activity.slice(0, 18).map((item) => (
          <div key={item.id} className="activity-item">
            <span className="activity-icon" style={{ color: KIND_COLOR[item.kind] }}>
              {KIND_ICON[item.kind]}
            </span>
            <span className="activity-label">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
