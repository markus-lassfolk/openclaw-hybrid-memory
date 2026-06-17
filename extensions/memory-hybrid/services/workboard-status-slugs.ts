/**
 * OpenClaw Workboard card status slugs (OpenClaw 6.8+).
 * @see workboard.cards.create / workboard.cards.update `status` field
 */

export const WORKBOARD_STATUS_SLUGS = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const;

export type WorkboardStatusSlug = (typeof WORKBOARD_STATUS_SLUGS)[number];

const SLUG_SET = new Set<string>(WORKBOARD_STATUS_SLUGS);

/** Legacy display names and aliases → Workboard status slug. */
const LEGACY_COLUMN_TO_SLUG: Record<string, WorkboardStatusSlug> = {
  "in progress": "running",
  in_progress: "running",
  active: "running",
  running: "running",
  waiting: "scheduled",
  scheduled: "scheduled",
  backlog: "backlog",
  stalled: "backlog",
  parked: "backlog",
  done: "done",
  completed: "done",
  failed: "blocked",
  blocked: "blocked",
  review: "review",
  ready: "ready",
  todo: "todo",
  triage: "triage",
};

export function isValidWorkboardStatusSlug(value: string): value is WorkboardStatusSlug {
  return SLUG_SET.has(value.toLowerCase());
}

/** Map configured column name (slug or legacy label) to a Workboard API status slug. */
export function toWorkboardStatusSlug(column: string): WorkboardStatusSlug {
  const lower = column.trim().toLowerCase();
  if (SLUG_SET.has(lower)) return lower as WorkboardStatusSlug;
  return LEGACY_COLUMN_TO_SLUG[lower] ?? "backlog";
}

/** Map column name (slug or legacy label) to slug, returning null if unrecognized. */
export function tryToWorkboardStatusSlug(column: string): WorkboardStatusSlug | null {
  const lower = column.trim().toLowerCase();
  if (SLUG_SET.has(lower)) return lower as WorkboardStatusSlug;
  return LEGACY_COLUMN_TO_SLUG[lower] ?? null;
}
