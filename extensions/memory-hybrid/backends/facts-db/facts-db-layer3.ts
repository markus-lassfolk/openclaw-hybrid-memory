/**
 * FactsDB — layer 3: housekeeping, contradictions, autolink, clusters, episodes, entity layer.
 */

import type { ExtractedMention } from "../../services/entity-enrichment.js";
import type { Episode, EpisodeOutcome, MemoryEntry, ScopeFilter } from "../../types/memory.js";
import {
  getAllEdges as getAllEdgesImpl,
  getAllLinkedFactIds as getAllLinkedFactIdsImpl,
  getAllLinks as getAllLinksImpl,
  getClusterMembers as getClusterMembersImpl,
  getClusters as getClustersImpl,
  getFactClusterId as getFactClusterIdImpl,
  saveClusters as saveClustersImpl,
} from "./clusters.js";
import {
  addTag as addTagImpl,
  contradictionsCount as contradictionsCountImpl,
  detectContradictions as detectContradictionsImpl,
  findConflictingFacts as findConflictingFactsImpl,
  getContradictedIds as getContradictedIdsImpl,
  getContradictions as getContradictionsImpl,
  isContradicted as isContradictedImpl,
  recordContradiction as recordContradictionImpl,
  resolveContradiction as resolveContradictionImpl,
  resolveContradictionsAuto as resolveContradictionsAutoImpl,
  setConfidenceTo as setConfidenceToImpl,
  updateConfidence as updateConfidenceImpl,
} from "./contradictions.js";
import type { ContradictionRecord } from "./contradictions.js";
import {
  autoDetectInstanceOf as autoDetectInstanceOfImpl,
  autoLinkEntities as autoLinkEntitiesImpl,
  extractEntitiesFromText as extractEntitiesFromTextImpl,
  findEntityAnchor as findEntityAnchorImpl,
  getKnownEntities as getKnownEntitiesImpl,
} from "./entity-autolink.js";
import {
  type ContactRow,
  type OrganizationRow,
  listContactsByNamePrefix as entityLayerListContactsByNamePrefix,
  listContactsForOrg as entityLayerListContactsForOrg,
  listFactIdsForOrg as entityLayerListFactIdsForOrg,
  listFactsNeedingEnrichment as entityLayerListFactsNeedingEnrichment,
  getOrganizationByKeyOrName as lookupOrganizationByKeyOrName,
  replaceFactEntityMentions,
} from "./entity-layer.js";
import {
  deleteEpisode as deleteEpisodeImpl,
  episodesCount as episodesCountImpl,
  getEpisode as getEpisodeImpl,
  recordEpisode as recordEpisodeImpl,
  searchEpisodes as searchEpisodesImpl,
} from "./episodes.js";
import { FactsDBLayer2 } from "./facts-db-layer2.js";
import {
  countBySource as countBySourceImpl,
  findSessionFactsForPromotion as findSessionFactsForPromotionImpl,
  languageKeywordsCount as languageKeywordsCountImpl,
  optimizeFts as optimizeFtsImpl,
  pruneLogTables as pruneLogTablesImpl,
  pruneOrphanedLinks as pruneOrphanedLinksImpl,
  pruneScopedFacts as pruneScopedFactsImpl,
  scopeStats as scopeStatsImpl,
  selfCorrectionIncidentsCount as selfCorrectionIncidentsCountImpl,
  statsBySource as statsBySourceImpl,
  statsReflection as statsReflectionImpl,
  uniqueScopes as uniqueScopesImpl,
  vacuumAndCheckpoint as vacuumAndCheckpointImpl,
} from "./housekeeping.js";

export class FactsDB extends FactsDBLayer2 {
  /** Alias for pruneExpired() for backward compatibility */
  prune(): number {
    return this.pruneExpired();
  }

  /**
   * Remove orphaned rows from memory_links where source_fact_id or
   * target_fact_id no longer reference an existing fact.
   * Returns the number of deleted rows.
   */
  pruneOrphanedLinks(): number {
    return pruneOrphanedLinksImpl(this.liveDb);
  }

  /** Alias for backfillDecayClasses() for backward compatibility */
  backfillDecay(): Record<string, number> {
    return this.backfillDecayClasses();
  }

  pruneLogTables(retentionDays: number): number {
    return pruneLogTablesImpl(this.liveDb, retentionDays);
  }

  optimizeFts(): void {
    optimizeFtsImpl(this.liveDb);
  }

  vacuumAndCheckpoint(): void {
    vacuumAndCheckpointImpl(this.liveDb);
  }

  statsReflection(): ReturnType<typeof statsReflectionImpl> {
    return statsReflectionImpl(this.liveDb);
  }

  selfCorrectionIncidentsCount(): number {
    return selfCorrectionIncidentsCountImpl(this.liveDb);
  }

  countBySource(source: string): number {
    return countBySourceImpl(this.liveDb, source);
  }

  languageKeywordsCount(): number {
    return languageKeywordsCountImpl();
  }

  statsBySource(): Record<string, number> {
    return statsBySourceImpl(this.liveDb);
  }

  uniqueScopes(): Array<{ scope: string; scopeTarget: string | null }> {
    return uniqueScopesImpl(this.liveDb);
  }

  scopeStats(): ReturnType<typeof scopeStatsImpl> {
    return scopeStatsImpl(this.liveDb);
  }

  pruneScopedFacts(scopeFilter: ScopeFilter): number {
    return pruneScopedFactsImpl(this.liveDb, scopeFilter);
  }

  findSessionFactsForPromotion(thresholdDays: number, minImportance: number): MemoryEntry[] {
    return findSessionFactsForPromotionImpl(this.liveDb, thresholdDays, minImportance);
  }

  // ============================================================================
  // Contradiction Detection (Issue #157)
  // ============================================================================

  updateConfidence(id: string, delta: number): number | null {
    return updateConfidenceImpl(this.liveDb, id, delta);
  }

  setConfidenceTo(id: string, value: number): number | null {
    return setConfidenceToImpl(this.liveDb, id, value);
  }

  addTag(id: string, tag: string): void {
    addTagImpl(this.liveDb, id, tag);
  }

  findConflictingFacts(
    entity: string,
    key: string,
    value: string,
    excludeFactId: string,
    scope?: string | null,
    scopeTarget?: string | null,
  ): MemoryEntry[] {
    return findConflictingFactsImpl(this.liveDb, entity, key, value, excludeFactId, scope, scopeTarget);
  }

  recordContradiction(factIdNew: string, factIdOld: string): string {
    return recordContradictionImpl(this.liveDb, factIdNew, factIdOld, (a, b, t, s) =>
      this.createLink(a, b, t, s ?? 1.0),
    );
  }

  detectContradictions(
    newFactId: string,
    entity: string | null | undefined,
    key: string | null | undefined,
    value: string | null | undefined,
    scope?: string | null,
    scopeTarget?: string | null,
  ): Array<{ contradictionId: string; oldFactId: string }> {
    return detectContradictionsImpl(this.liveDb, newFactId, entity, key, value, scope, scopeTarget, (a, b, t, s) =>
      this.createLink(a, b, t, s ?? 1.0),
    );
  }

  getContradictions(factId?: string): ContradictionRecord[] {
    return getContradictionsImpl(this.liveDb, factId);
  }

  resolveContradiction(contradictionId: string, resolution: "superseded" | "kept" | "merged"): boolean {
    return resolveContradictionImpl(this.liveDb, contradictionId, resolution);
  }

  isContradicted(factId: string): boolean {
    return isContradictedImpl(this.liveDb, factId);
  }

  getContradictedIds(factIds: string[]): Set<string> {
    return getContradictedIdsImpl(this.liveDb, factIds);
  }

  resolveContradictions(): ReturnType<typeof resolveContradictionsAutoImpl> {
    return resolveContradictionsAutoImpl(
      this.liveDb,
      (id) => this.getById(id),
      (o, n) => this.supersede(o, n),
    );
  }

  contradictionsCount(): number {
    return contradictionsCountImpl(this.liveDb);
  }

  // ---------------------------------------------------------------------------
  // Auto-linking helpers (Issue #154)
  // ---------------------------------------------------------------------------

  getKnownEntities(): string[] {
    return getKnownEntitiesImpl(this.liveDb);
  }

  extractEntitiesFromText(text: string, knownEntities: string[]): Array<{ entity: string; weight: number }> {
    return extractEntitiesFromTextImpl(text, knownEntities);
  }

  findEntityAnchor(entity: string, excludeId?: string): MemoryEntry | null {
    return findEntityAnchorImpl(this.liveDb, entity, excludeId);
  }

  autoDetectInstanceOf(newFactId: string, text: string, knownEntities?: string[]): number {
    return autoDetectInstanceOfImpl(
      this.liveDb,
      newFactId,
      text,
      knownEntities,
      (a, b, t, s) => this.createLink(a, b, t, s ?? 1.0),
      getKnownEntitiesImpl,
    );
  }

  autoLinkEntities(
    newFactId: string,
    text: string,
    entity: string | null,
    key: string | null,
    sessionId: string | null,
    cfg: { coOccurrenceWeight: number; autoSupersede: boolean },
    scope?: string | null,
    scopeTarget?: string | null,
  ): { linkedCount: number; supersededIds: string[] } {
    return autoLinkEntitiesImpl(
      this.liveDb,
      newFactId,
      text,
      entity,
      key,
      sessionId,
      cfg,
      scope,
      scopeTarget,
      (a, b, t, s) => this.createLink(a, b, t, s ?? 1.0),
      (o, n) => this.supersede(o, n),
    );
  }

  // ---------------------------------------------------------------------------
  // Topic cluster storage (Issue #146)
  // ---------------------------------------------------------------------------

  getAllLinkedFactIds(): string[] {
    return getAllLinkedFactIdsImpl(this.liveDb);
  }

  getAllLinks(): Array<{ sourceFactId: string; targetFactId: string }> {
    return getAllLinksImpl(this.liveDb);
  }

  getAllEdges(limit = 5000): ReturnType<typeof getAllEdgesImpl> {
    return getAllEdgesImpl(this.liveDb, limit);
  }

  saveClusters(
    clusters: Array<{
      id: string;
      label: string;
      factIds: string[];
      factCount: number;
      createdAt: number;
      updatedAt: number;
    }>,
  ): void {
    saveClustersImpl(this.liveDb, clusters);
  }

  getClusters(): ReturnType<typeof getClustersImpl> {
    return getClustersImpl(this.liveDb);
  }

  getClusterMembers(clusterId: string): string[] {
    return getClusterMembersImpl(this.liveDb, clusterId);
  }

  getFactClusterId(factId: string): string | null {
    return getFactClusterIdImpl(this.liveDb, factId);
  }

  // ============================================================================
  // Episodic Memory (#781)
  // ============================================================================

  recordEpisode(input: Parameters<typeof recordEpisodeImpl>[1]): Episode {
    return recordEpisodeImpl(this.liveDb, input);
  }

  searchEpisodes(
    options: {
      query?: string;
      outcome?: EpisodeOutcome[];
      since?: number;
      until?: number;
      procedureId?: string;
      limit?: number;
      scopeFilter?: ScopeFilter | null;
    } = {},
  ): Episode[] {
    return searchEpisodesImpl(this.liveDb, options);
  }

  getEpisode(id: string): Episode | null {
    return getEpisodeImpl(this.liveDb, id);
  }

  deleteEpisode(id: string): boolean {
    return deleteEpisodeImpl(this.liveDb, id);
  }

  episodesCount(): number {
    return episodesCountImpl(this.liveDb);
  }

  // --- Entity layer: NER mentions, organizations, contacts (#985–#987) ---

  /** Replace stored NER rows for a fact (typically after LLM extraction). */
  applyEntityEnrichment(factId: string, mentions: ExtractedMention[], detectedLang: string): void {
    replaceFactEntityMentions(
      this.liveDb,
      factId,
      mentions.map((m) => ({
        label: m.label,
        surfaceText: m.surfaceText,
        normalizedSurface: m.normalizedSurface,
        startOffset: m.startOffset,
        endOffset: m.endOffset,
        confidence: m.confidence,
        detectedLang,
        source: "llm",
      })),
    );
  }

  /** Resolve an organization by canonical key or fuzzy display name. */
  lookupOrganization(query: string): OrganizationRow | null {
    return lookupOrganizationByKeyOrName(this.liveDb, query);
  }

  /** Contacts with primary_org_id = org. */
  listContactsForOrganization(orgId: string, limit: number): ContactRow[] {
    return entityLayerListContactsForOrg(this.liveDb, orgId, limit);
  }

  /** List contacts by optional name prefix (empty = recent alphabetical cap). */
  listContactsByNamePrefix(prefix: string, limit: number): ContactRow[] {
    return entityLayerListContactsByNamePrefix(this.liveDb, prefix, limit);
  }

  /** Fact ids linked to an org via NER/org_fact_links. */
  listFactIdsLinkedToOrg(orgId: string, limit: number): string[] {
    return entityLayerListFactIdsForOrg(this.liveDb, orgId, limit);
  }

  /** Facts not yet processed by entity enrichment (see `facts.entity_enrichment_at`). */
  listFactIdsNeedingEntityEnrichment(limit: number, minTextLen = 24): string[] {
    return entityLayerListFactsNeedingEnrichment(this.liveDb, limit, minTextLen);
  }
}
