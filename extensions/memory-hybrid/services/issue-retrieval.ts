/**
 * Issue-aware retrieval for RRF fusion and constrained recall (#1802).
 */

import type { IssueStore } from "../backends/issue-store.js";
import type { Issue, IssueSeverity } from "../types/issue-types.js";
import type { RankedResult } from "./rrf-fusion.js";

const OPEN_STATUSES = new Set(["open", "diagnosed", "fix-attempted"]);
const HIGH_SEVERITIES: IssueSeverity[] = ["critical", "high"];

export function getOpenCriticalAndHighIssues(issueStore: IssueStore, limit = 10): Issue[] {
  return issueStore
    .list({
      status: ["open", "diagnosed", "fix-attempted"],
      severity: HIGH_SEVERITIES,
      limit,
    })
    .sort((a, b) => {
      const sev = (s: IssueSeverity) => (s === "critical" ? 2 : s === "high" ? 1 : 0);
      return sev(b.severity) - sev(a.severity);
    });
}

export function collectRelatedFactIdsFromIssues(issues: Issue[]): string[] {
  const ids = new Set<string>();
  for (const issue of issues) {
    for (const factId of issue.relatedFacts) {
      if (factId) ids.add(factId);
    }
  }
  return [...ids];
}

export function getCriticalOpenIssueFactIds(issueStore: IssueStore, limit = 10): string[] {
  return collectRelatedFactIdsFromIssues(getOpenCriticalAndHighIssues(issueStore, limit));
}

function scoreIssueRelevance(issue: Issue, queryLower: string): number {
  let score = 0;
  if (queryLower.includes(issue.title.toLowerCase())) score += 3;
  for (const symptom of issue.symptoms) {
    if (queryLower.includes(symptom.toLowerCase())) score += 2;
  }
  for (const tag of issue.tags) {
    if (queryLower.includes(tag.toLowerCase())) score += 1;
  }
  if (issue.rootCause && queryLower.includes(issue.rootCause.toLowerCase().slice(0, 30))) score += 2;
  if (OPEN_STATUSES.has(issue.status)) score += 0.5;
  if (issue.severity === "critical") score += 2;
  else if (issue.severity === "high") score += 1;
  return score;
}

/**
 * Search issues and return related fact IDs ranked for RRF fusion.
 */
export function runIssueRetrievalStrategy(
  query: string,
  issueStore: IssueStore,
  topK = 10,
): RankedResult[] {
  const q = query.trim();
  if (!q) return [];

  const queryLower = q.toLowerCase();
  const matched = issueStore.search(q);
  const criticalOpen = getOpenCriticalAndHighIssues(issueStore, 5);

  const byId = new Map<string, Issue>();
  for (const issue of [...matched, ...criticalOpen]) {
    byId.set(issue.id, issue);
  }

  const scoredIssues = [...byId.values()]
    .map((issue) => ({ issue, score: scoreIssueRelevance(issue, queryLower) }))
    .filter((row) => row.score > 0 || HIGH_SEVERITIES.includes(row.issue.severity))
    .sort((a, b) => b.score - a.score);

  const factScores = new Map<string, number>();
  let rank = 0;
  for (const { issue, score } of scoredIssues) {
    for (const factId of issue.relatedFacts) {
      if (!factId) continue;
      rank++;
      const existing = factScores.get(factId) ?? 0;
      factScores.set(factId, Math.max(existing, score / rank));
    }
    if (factScores.size >= topK) break;
  }

  return [...factScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([factId], index) => ({
      factId,
      rank: index + 1,
      source: "issues" as const,
    }));
}
