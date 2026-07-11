/** Visual palette for the constellation — dark background, category-hued stars, typed-edge colors. */

export const CATEGORY_COLORS: Record<string, string> = {
  fact: "#60a5fa",
  preference: "#34d399",
  decision: "#fbbf24",
  entity: "#a78bfa",
  episode: "#c084fc",
  procedure: "#f97316",
  pattern: "#2dd4bf",
  rule: "#f59e0b",
  technical: "#38bdf8",
  project: "#4ade80",
  person: "#f472b6",
  other: "#94a3b8",
};

export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.other;
}

export const LINK_COLORS: Record<string, string> = {
  RELATED_TO: "#4b5563",
  CAUSED_BY: "#a855f7",
  PART_OF: "#3b82f6",
  DEPENDS_ON: "#f97316",
  SUPERSEDES: "#ef4444",
  INSTANCE_OF: "#22c55e",
  CONTRADICTS: "#f43f5e",
  superseded_by: "#ef4444",
};

export function linkColor(linkType: string): string {
  return LINK_COLORS[linkType] ?? LINK_COLORS.RELATED_TO;
}

/** Category legend order (stable) for the sidebar. */
export const LEGEND_CATEGORIES = [
  "fact",
  "preference",
  "decision",
  "entity",
  "episode",
  "procedure",
  "pattern",
  "rule",
  "other",
];

export const COLORS = {
  bg: "#0b0e14",
  panel: "#141821",
  panelBorder: "#232838",
  text: "#e2e8f0",
  muted: "#8792a6",
  accent: "#6ea8fe",
  pulse: "#ffffff",
  pin: "#fbbf24",
  contradiction: "#f43f5e",
};
