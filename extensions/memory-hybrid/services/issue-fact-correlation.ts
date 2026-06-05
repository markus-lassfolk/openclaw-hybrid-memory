/**
 * Auto-link issues to related facts and graph edges (#1802).
 */

import type { FactsDB } from "../backends/facts-db.js";
import type { IssueStore } from "../backends/issue-store.js";
import type { Issue } from "../types/issue-types.js";
import type { MemoryLinkType } from "../backends/facts-db/types.js";

export type IssueCorrelationResult = {
  linkedFactIds: string[];
  graphLinksCreated: number;
};

export function buildIssueSearchText(issue: Pick<Issue, "title" | "symptoms" | "rootCause" | "fix">): string {
  return [issue.title, ...issue.symptoms, issue.rootCause, issue.fix].filter(Boolean).join(" ");
}

function linkIfMissing(
  factsDb: FactsDB,
  sourceId: string,
  targetId: string,
  linkType: MemoryLinkType,
  strength: number,
): boolean {
  if (sourceId === targetId) return false;
  try {
    factsDb.createLink(sourceId, targetId, linkType, strength);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create RELATED_TO / CAUSED_BY edges between facts linked to an issue.
 */
export function createGraphLinksForIssueFacts(
  factIds: string[],
  factsDb: FactsDB,
  context?: { rootCause?: string; fix?: string },
): number {
  const unique = [...new Set(factIds.filter(Boolean))];
  if (unique.length < 2) return 0;

  let created = 0;
  const anchorId = unique[0];

  for (let i = 1; i < unique.length; i++) {
    if (linkIfMissing(factsDb, anchorId, unique[i], "RELATED_TO", 0.75)) created++;
  }

  if (context?.rootCause?.trim() && context.fix?.trim() && unique.length >= 2) {
    const rootIdx = unique.findIndex((id) => {
      const entry = factsDb.getById(id);
      if (!entry) return false;
      const lower = entry.text.toLowerCase();
      return lower.includes(context.rootCause!.trim().toLowerCase().slice(0, 40));
    });
    const fixIdx = unique.findIndex((id) => {
      const entry = factsDb.getById(id);
      if (!entry) return false;
      const lower = entry.text.toLowerCase();
      return lower.includes(context.fix!.trim().toLowerCase().slice(0, 40));
    });
    if (rootIdx >= 0 && fixIdx >= 0 && rootIdx !== fixIdx) {
      if (linkIfMissing(factsDb, unique[fixIdx], unique[rootIdx], "CAUSED_BY", 0.9)) created++;
    }
  }

  return created;
}

/**
 * FTS-search for semantically related facts, link them to the issue, and wire graph edges.
 */
export function autoLinkIssueToFacts(
  issue: Issue,
  factsDb: FactsDB,
  issueStore: IssueStore,
  options?: { maxLinks?: number },
): IssueCorrelationResult {
  const maxLinks = options?.maxLinks ?? 5;
  const searchText = buildIssueSearchText(issue);
  if (!searchText.trim()) {
    return { linkedFactIds: [...issue.relatedFacts], graphLinksCreated: 0 };
  }

  const results = factsDb.search(searchText, maxLinks * 3, {
    reinforcementBoost: 0,
    diversityWeight: 0,
  });

  const linked = new Set(issue.relatedFacts);
  for (const r of results) {
    if (linked.size >= maxLinks + issue.relatedFacts.length) break;
    if (linked.has(r.entry.id)) continue;
    issueStore.linkFact(issue.id, r.entry.id);
    linked.add(r.entry.id);
  }

  const allLinked = [...linked];
  const graphLinksCreated = createGraphLinksForIssueFacts(allLinked, factsDb, {
    rootCause: issue.rootCause,
    fix: issue.fix,
  });

  return { linkedFactIds: allLinked, graphLinksCreated };
}
