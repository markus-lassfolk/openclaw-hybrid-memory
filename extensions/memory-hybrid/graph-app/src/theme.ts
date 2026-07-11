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

// --- Decay lens ---------------------------------------------------------------------------------

/** Days of no access after which a fact of this decay class reads as fully stale. */
function staleHorizonDays(decayClass: string): number {
  const dc = decayClass.toLowerCase();
  if (dc.includes("session") || dc.includes("ephemeral") || dc.includes("short")) return 7;
  if (dc.includes("volatile")) return 30;
  return 90;
}

function toEpochMs(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && value > 0) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * 0 = fresh, 1 = fully stale/about to expire. Pinned facts never fade. A scheduled expiry
 * dominates (proximity to expiresAt); otherwise staleness = time since last access (falling back
 * to creation) against the decay class's horizon.
 */
export function decayLevel(
  node: {
    pinned?: boolean | null;
    decayClass: string;
    expiresAt?: number | null;
    lastAccessedAt?: string | number | null;
    createdAt?: number | null;
  },
  nowMs = Date.now(),
): number {
  if (node.pinned) return 0;
  if (node.expiresAt != null && node.expiresAt > 0) {
    const remainingMs = node.expiresAt * 1000 - nowMs;
    if (remainingMs <= 0) return 1;
    const horizonMs = 30 * 86_400_000;
    return Math.max(0, Math.min(1, 1 - remainingMs / horizonMs));
  }
  const last = toEpochMs(node.lastAccessedAt) ?? toEpochMs(node.createdAt ?? null);
  if (last == null) return 0;
  const horizonMs = staleHorizonDays(node.decayClass) * 86_400_000;
  return Math.max(0, Math.min(1, (nowMs - last) / horizonMs));
}

/** Fresh green → amber → fading red, from decayLevel. */
export function decayColor(level: number): string {
  const hue = 152 * (1 - level); // 152 (green) → 0 (red), passing amber ~45
  return `hsl(${hue.toFixed(0)}, 65%, ${58 - level * 6}%)`;
}

/** Legend swatches for the decay lens. */
export const DECAY_LEGEND: Array<{ label: string; level: number }> = [
  { label: "fresh", level: 0 },
  { label: "fading", level: 0.55 },
  { label: "stale / expiring", level: 1 },
];
