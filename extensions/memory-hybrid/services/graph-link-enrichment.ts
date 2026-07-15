/**
 * Bounded, safe graph-link enrichment (#2127).
 *
 * Live memory_health data has shown explicit graph links covering as little as ~12% of active
 * facts, even when semantic retrieval and provenance tracking are healthy — the graph layer
 * simply never materializes those latent relationships as edges. This module promotes ONE
 * deterministic, already-computed signal into the explicit graph: facts that share a recorded
 * source event (facts.provenance_json.sourceEventIds, the same field memory_health already
 * reports as "Provenance (JSON): N facts cover M source events"). It does not compute any new
 * similarity/relatedness judgment and never creates a link where one (of any type) already
 * exists between the pair — bad links are worse than no links.
 */

import { parseFactProvenanceJson } from "../backends/facts-db/provenance-json.js";
import type { FactsDB } from "../backends/facts-db.js";

export interface GraphLinkEnrichmentResult {
  factsScanned: number;
  sourceEventGroups: number;
  linksCreated: number;
  dryRun: boolean;
  createdLinks: Array<{ sourceFactId: string; targetFactId: string; sharedSourceEventId: string }>;
}

const DEFAULT_LINK_STRENGTH = 0.6;

export function enrichOrphanFactLinksBySharedSourceEvent(
  factsDb: FactsDB,
  opts: { limit?: number; dryRun?: boolean } = {},
): GraphLinkEnrichmentResult {
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 500));
  // Dry-run by default (opt-in mutation via dryRun: false) — mirrors the CLI's --apply flag.
  const dryRun = opts.dryRun ?? true;
  const db = factsDb.getRawDb();

  // Orphan (no explicit link at all, either direction), active facts with provenance present.
  // Because the scan is scoped to orphans, no pair drawn from `rows` can already be linked to
  // each other — a fact with any existing link (of any type) is excluded up front, so there is
  // no risk of this enrichment adding a redundant edge alongside an existing relationship.
  // Oldest-first so repeated bounded runs make steady forward progress across the whole backlog
  // instead of re-scanning the same head of the table every time. Excludes expired-but-not-yet-
  // pruned facts (like every other "active fact" query in this codebase) — pinned/verified facts
  // are exempt from expiry-pruning forever, so without this filter they can dominate the oldest-
  // first scan and exhaust a bounded --limit run before reaching the active orphans memory_health's
  // orphanRate warning is actually about (#2134 QA follow-up).
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(
      `SELECT id, provenance_json FROM facts
       WHERE superseded_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
         AND provenance_json IS NOT NULL
         AND id NOT IN (SELECT source_fact_id FROM memory_links UNION SELECT target_fact_id FROM memory_links)
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(nowSec, limit) as Array<{ id: string; provenance_json: string | null }>;

  const bySourceEvent = new Map<string, string[]>();
  for (const row of rows) {
    const provenance = parseFactProvenanceJson(row.provenance_json);
    for (const eventId of provenance.sourceEventIds ?? []) {
      const bucket = bySourceEvent.get(eventId);
      if (bucket) bucket.push(row.id);
      else bySourceEvent.set(eventId, [row.id]);
    }
  }

  let linksCreated = 0;
  let sourceEventGroups = 0;
  const createdLinks: GraphLinkEnrichmentResult["createdLinks"] = [];
  // A fact with multiple sourceEventIds can appear in more than one group; dedupe by pair across
  // the whole run so a repeated (anchor, target) pairing across groups is only counted/created once.
  const seenPairs = new Set<string>();

  for (const [eventId, factIds] of bySourceEvent) {
    if (factIds.length < 2) continue;
    sourceEventGroups++;
    // Star topology anchored on the oldest fact in the group (facts arrive in created_at ASC
    // order above) — every fact in the group becomes graph-reachable via one hop, without the
    // O(n^2) edge blowup a fully-connected clique would produce for a large shared-event group.
    const [anchor, ...rest] = factIds;
    if (!anchor) continue;
    for (const targetId of rest) {
      const pairKey = anchor < targetId ? `${anchor}\0${targetId}` : `${targetId}\0${anchor}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      if (!dryRun) {
        factsDb.createOrStrengthenRelatedLink(anchor, targetId, DEFAULT_LINK_STRENGTH);
      }
      linksCreated++;
      createdLinks.push({ sourceFactId: anchor, targetFactId: targetId, sharedSourceEventId: eventId });
    }
  }

  return {
    factsScanned: rows.length,
    sourceEventGroups,
    linksCreated,
    dryRun,
    createdLinks,
  };
}
