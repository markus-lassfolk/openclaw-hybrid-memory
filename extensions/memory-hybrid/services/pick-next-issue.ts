/**
 * Task Queue — Pick Next Issue (Issue #635)
 *
 * Implements a 3-tier priority system for picking the next autonomous issue:
 *   1. queue:high    — picked first
 *   2. (no queue label) — picked second (normal/medium priority)
 *   3. queue:low     — picked last
 *
 * Eligible issues must carry both the `autonomous` and `enriched` labels.
 * Issues already running (present in current.json) are excluded.
 *
 * Addresses Product Goal 4: Autonomous Maintenance
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Three-tier priority derived from queue labels. */
export type IssueQueuePriority = "high" | "normal" | "low";

/** Numeric rank for sorting (lower = higher priority). */
const PRIORITY_RANK: Record<IssueQueuePriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

/** Minimal representation of a GitHub issue. */
export interface GitHubIssueRaw {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
}

/** A pickable issue enriched with its computed queue priority. */
export interface PickableIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
  priority: IssueQueuePriority;
}

/** Successful pick result. */
export interface PickSuccess {
  picked: true;
  issue: PickableIssue;
}

/** Skip result when no eligible issue is available. */
export interface PickSkip {
  picked: false;
  reason: string;
}

export type PickResult = PickSuccess | PickSkip;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit-testing)
// ---------------------------------------------------------------------------

/**
 * Build `gh issue list` args for task-queue picking.
 *
 * Important: required eligibility labels are applied before `--limit` so the
 * limit is evaluated on the eligible issue set.
 */
export function buildPickNextGhIssueListArgs(repo?: string, limit = 50): string[] {
  const repoArgs = repo ? ["--repo", repo] : [];
  return [
    "issue",
    "list",
    ...repoArgs,
    "--state",
    "open",
    "--label",
    "autonomous",
    "--label",
    "enriched",
    "--limit",
    String(limit),
    "--json",
    "number,title,url,labels",
  ];
}

/**
 * Derive the queue priority tier for an issue from its label names.
 *
 * - Returns `"high"` if the `queue:high` label is present.
 * - Returns `"low"` if the `queue:low` label is present (and `queue:high` is not).
 * - Returns `"normal"` when neither `queue:high` nor `queue:low` is present.
 */
export function getQueuePriority(labels: string[]): IssueQueuePriority {
  if (labels.includes("queue:high")) return "high";
  if (labels.includes("queue:low")) return "low";
  return "normal";
}

/**
 * Return true when an issue is eligible to be picked.
 *
 * Eligibility requires both the `autonomous` and `enriched` labels.
 */
export function isEligible(labels: string[]): boolean {
  return labels.includes("autonomous") && labels.includes("enriched");
}

/**
 * Sort an array of pickable issues by priority (high → normal → low).
 * Issues of equal priority retain their original relative order (stable sort).
 */
export function sortByQueuePriority(issues: PickableIssue[]): PickableIssue[] {
  return [...issues].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

/**
 * Convert a raw GitHub issue (from `gh issue list --json`) into a
 * PickableIssue, or return null if the issue is not eligible.
 */
export function toPickable(raw: GitHubIssueRaw): PickableIssue | null {
  const labels = raw.labels.map((l) => l.name);
  if (!isEligible(labels)) return null;
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    labels,
    priority: getQueuePriority(labels),
  };
}

/**
 * Given an array of raw GitHub issues and the set of issue numbers already
 * running in the task queue, return the next issue to pick, or a skip
 * sentinel if none is available.
 *
 * The skip sentinel carries the message `"SKIP: No more autonomous issues available"`.
 */
export function pickNextIssue(rawIssues: GitHubIssueRaw[], excludedNumbers: Set<number>): PickResult {
  const pickable = rawIssues.flatMap((raw) => {
    const p = toPickable(raw);
    return p !== null ? [p] : [];
  });

  const eligible = pickable.filter((i) => !excludedNumbers.has(i.number));

  if (eligible.length === 0) {
    return { picked: false, reason: "SKIP: No more autonomous issues available" };
  }

  const sorted = sortByQueuePriority(eligible);
  return { picked: true, issue: sorted[0] };
}
