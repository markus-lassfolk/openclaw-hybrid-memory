/**
 * Issue-aware retrieval for RRF fusion and constrained recall (#1802).
 */

import type { IssueStore } from "../backends/issue-store.js";
import type { Issue, IssueSeverity } from "../types/issue-types.js";
import { shouldTriggerIssueAmbientSearch } from "./ambient-retrieval.js";
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
  const queryTokens = queryLower.split(/\s+/).filter((t) => t.length >= 3);
  for (const token of queryTokens) {
    if (issue.title.toLowerCase().includes(token)) score += 1;
    for (const symptom of issue.symptoms) {
      if (symptom.toLowerCase().includes(token)) score += 1;
    }
  }
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
  factsDb?: { getById(id: string): { supersededAt?: number | null } | null } | null,
): RankedResult[] {
  const q = query.trim();
  if (!q) return [];

  const queryLower = q.toLowerCase();
  const matched = issueStore.search(q);
  const matchedIds = new Set(matched.map((issue) => issue.id));
  const includeCriticalBaseline = shouldTriggerIssueAmbientSearch(q);
  const criticalOpen = includeCriticalBaseline ? getOpenCriticalAndHighIssues(issueStore, 5) : [];

  const byId = new Map<string, Issue>();
  for (const issue of matched) {
    byId.set(issue.id, issue);
  }
  // Phrase LIKE search can miss multi-token queries (e.g. "memory leak OOM" vs "Critical memory leak").
  const queryTokens = queryLower.split(/\s+/).filter((t) => t.length >= 3);
  for (const token of queryTokens.slice(0, 5)) {
    for (const issue of issueStore.search(token)) {
      byId.set(issue.id, issue);
      matchedIds.add(issue.id);
    }
  }
  for (const issue of criticalOpen) {
    byId.set(issue.id, issue);
  }

  const scoredIssues = [...byId.values()]
    .map((issue) => ({ issue, score: scoreIssueRelevance(issue, queryLower) }))
    .filter(
      (row) =>
        matchedIds.has(row.issue.id) || row.score > 0 || (includeCriticalBaseline && row.issue.severity === "critical"),
    )
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
    .filter(([factId]) => {
      if (!factsDb) return true;
      const entry = factsDb.getById(factId);
      return entry != null && entry.supersededAt == null;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([factId], index) => ({
      factId,
      rank: index + 1,
      source: "issues" as const,
    }));
}
