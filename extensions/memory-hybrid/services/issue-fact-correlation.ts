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
  const db = factsDb.getRawDb();
  const existing = db
    .prepare(
      `SELECT id FROM memory_links
         WHERE source_fact_id = ? AND target_fact_id = ? AND link_type = ?`,
    )
    .get(sourceId, targetId, linkType);
  if (existing) return false;
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

  if (context?.rootCause?.trim() && unique.length >= 2) {
    const rootIdx = unique.findIndex((id) => {
      const entry = factsDb.getById(id);
      if (!entry) return false;
      const lower = entry.text.toLowerCase();
      return lower.includes(context.rootCause!.trim().toLowerCase().slice(0, 40));
    });
    // Effect CAUSED_BY cause: anchor symptom/fact was caused by root-cause fact.
    if (rootIdx >= 0 && anchorId !== unique[rootIdx]) {
      if (linkIfMissing(factsDb, anchorId, unique[rootIdx], "CAUSED_BY", 0.9)) created++;
    }
    if (context.fix?.trim()) {
      const fixIdx = unique.findIndex((id) => {
        const entry = factsDb.getById(id);
        if (!entry) return false;
        const lower = entry.text.toLowerCase();
        return lower.includes(context.fix!.trim().toLowerCase().slice(0, 40));
      });
      if (fixIdx >= 0 && rootIdx >= 0 && fixIdx !== rootIdx) {
        if (linkIfMissing(factsDb, unique[fixIdx], unique[rootIdx], "RELATED_TO", 0.85)) created++;
      }
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
  let newLinks = 0;
  for (const r of results) {
    if (newLinks >= maxLinks) break;
    const factId = r.entry.id;
    if (linked.has(factId)) continue;
    const live = factsDb.getById(factId);
    if (!live || live.supersededAt != null) continue;
    issueStore.linkFact(issue.id, factId);
    linked.add(factId);
    newLinks++;
  }

  const allLinked = [...linked];
  const graphLinksCreated = createGraphLinksForIssueFacts(allLinked, factsDb, {
    rootCause: issue.rootCause,
    fix: issue.fix,
  });

  return { linkedFactIds: allLinked, graphLinksCreated };
}
