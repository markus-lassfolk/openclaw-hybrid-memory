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
  getEdgesForFactIds as getEdgesForFactIdsImpl,
  getFactClusterId as getFactClusterIdImpl,
  saveClusters as saveClustersImpl,
} from "./clusters.js";
import type {
  ApplyContradictionReviewResult,
  ContradictionRecord,
  ContradictionResolutionAuditRow,
  ContradictionReviewDecision,
  ProjectStateLwwResult,
  ResolveContradictionsAutoOptions,
  ResolveContradictionsAutoResult,
} from "./contradictions.js";
import {
  addTag as addTagImpl,
  applyContradictionReviewDecisions as applyContradictionReviewDecisionsImpl,
  type ContradictionDetectionResult,
  contradictionsCount as contradictionsCountImpl,
  detectContradictions as detectContradictionsImpl,
  evaluateLwwEligibility,
  findConflictingFacts as findConflictingFactsImpl,
  getContradictedIds as getContradictedIdsImpl,
  getContradictionResolutionAudit as getContradictionResolutionAuditImpl,
  getContradictions as getContradictionsImpl,
  isContradicted as isContradictedImpl,
  isFactVerified,
  PROJECT_STATE_LWW_KEYS,
  previewResolveContradictionsAuto as previewResolveContradictionsAutoImpl,
  queryContradictionSurface as queryContradictionSurfaceImpl,
  recordContradiction as recordContradictionImpl,
  repairUndetectedContradictions as repairUndetectedContradictionsImpl,
  resolveContradiction as resolveContradictionImpl,
  resolveContradictionsAuto as resolveContradictionsAutoImpl,
  resolveContradictionsAutonomously as resolveContradictionsAutonomouslyImpl,
  resolveProjectStateLww as resolveProjectStateLwwImpl,
  setConfidenceTo as setConfidenceToImpl,
  updateConfidence as updateConfidenceImpl,
} from "./contradictions.js";
import { runWithSqliteBusyRetry } from "./crud.js";
import {
  autoDetectInstanceOf as autoDetectInstanceOfImpl,
  autoLinkEntities as autoLinkEntitiesImpl,
  extractEntitiesFromText as extractEntitiesFromTextImpl,
  findEntityAnchor as findEntityAnchorImpl,
  getKnownEntities as getKnownEntitiesImpl,
} from "./entity-autolink.js";
import {
  type ContactProfileEnrichmentResult,
  type ContactProfileEnrichmentSource,
  type ContactRow,
  type ContactUpdatedBy,
  type EntityEnrichmentBacklogSummary,
  type EntityMentionsAuditSummary,
  type EntityMentionsCleanupSummary,
  applyContactProfileEnrichmentForFact as entityLayerApplyContactProfileEnrichmentForFact,
  auditEntityMentions as entityLayerAuditEntityMentions,
  cleanupEntityMentions as entityLayerCleanupEntityMentions,
  findContactMergeCandidates as entityLayerFindContactMergeCandidates,
  getContactById as entityLayerGetContactById,
  getEntityEnrichmentBacklogSummary as entityLayerGetEntityEnrichmentBacklogSummary,
  getOrganizationById as entityLayerGetOrganizationById,
  listContactsByNamePrefix as entityLayerListContactsByNamePrefix,
  listContactsForOrg as entityLayerListContactsForOrg,
  listFactIdsForOrg as entityLayerListFactIdsForOrg,
  listFactsNeedingEnrichment as entityLayerListFactsNeedingEnrichment,
  mergeContacts as entityLayerMergeContacts,
  resolveContactId as entityLayerResolveContactId,
  upsertContact as entityLayerUpsertContact,
  upsertOrganization as entityLayerUpsertOrganization,
  type ListFactsNeedingEnrichmentOptions,
  getOrganizationByKeyOrName as lookupOrganizationByKeyOrName,
  type OrganizationRow,
  replaceFactEntityMentions,
  type UpsertContactOptions,
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
  checkpointWalTruncate as checkpointWalTruncateImpl,
  countActiveFactsByCategory as countActiveFactsByCategoryImpl,
  countBySource as countBySourceImpl,
  countSupersededFacts as countSupersededFactsImpl,
  countVerifiedFacts as countVerifiedFactsImpl,
  type FtsConsistencySnapshot,
  type FtsTriggerProbeResult,
  findSessionFactsForPromotion as findSessionFactsForPromotionImpl,
  freelistSpaceStats as freelistSpaceStatsImpl,
  getFtsConsistencySnapshot as getFtsConsistencySnapshotImpl,
  languageKeywordsCount as languageKeywordsCountImpl,
  listScopedFactIdsPendingPrune as listScopedFactIdsPendingPruneImpl,
  optimizeFts as optimizeFtsImpl,
  pruneLogTables as pruneLogTablesImpl,
  pruneOrphanedLinks as pruneOrphanedLinksImpl,
  pruneScopedFacts as pruneScopedFactsImpl,
  rebuildFtsIndexFromFacts as rebuildFtsIndexFromFactsImpl,
  recentActivity as recentActivityImpl,
  runFtsTriggerProbe as runFtsTriggerProbeImpl,
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

  /**
   * SQL COUNT of active (non-superseded, non-expired) facts for a given category.
   * More efficient than getByCategory() + in-JS filter for maintenance/reporting.
   */
  countActiveFactsByCategory(category: string): number {
    return countActiveFactsByCategoryImpl(this.liveDb, category);
  }

  /** Alias for backfillDecayClasses() for backward compatibility */
  backfillDecay(options?: {
    onProgress?: (progress: import("./maintenance.js").BackfillDecayProgress) => void;
    reportEvery?: number;
  }): Record<string, number> {
    return this.backfillDecayClasses(options);
  }

  pruneLogTables(retentionDays: number): number {
    return pruneLogTablesImpl(this.liveDb, retentionDays);
  }

  optimizeFts(): void {
    optimizeFtsImpl(this.liveDb);
  }

  /** Snapshot FTS table/trigger/population consistency for doctor/health checks. */
  getFtsConsistencySnapshot(): FtsConsistencySnapshot {
    return getFtsConsistencySnapshotImpl(this.liveDb);
  }

  /** Deep savepointed INSERT/UPDATE/DELETE probe to confirm FTS triggers actually fire. */
  runFtsTriggerProbe(): FtsTriggerProbeResult {
    return runFtsTriggerProbeImpl(this.liveDb);
  }

  /** Rebuild FTS contents from `facts` rows (used by doctor --fix when drift is detected). */
  rebuildFtsIndex(): number {
    return rebuildFtsIndexFromFactsImpl(this.liveDb);
  }

  freelistSpaceStats(): ReturnType<typeof freelistSpaceStatsImpl> {
    return freelistSpaceStatsImpl(this.liveDb);
  }

  checkpointWalTruncate(): void {
    checkpointWalTruncateImpl(this.liveDb);
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

  countBySource(source: string, scopeFilter?: ScopeFilter | null): number {
    return countBySourceImpl(this.liveDb, source, scopeFilter);
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

  /** Prune facts matching scopeFilter; returns the IDs actually deleted (see housekeeping.ts). */
  pruneScopedFacts(scopeFilter: ScopeFilter): string[] {
    return pruneScopedFactsImpl(this.liveDb, scopeFilter);
  }

  /**
   * Return the fact IDs that `pruneScopedFacts(scopeFilter)` would delete, for dry-run previews
   * before a destructive confirmation prompt. For the post-delete vector cleanup, prefer
   * `pruneScopedFacts`'s own return value instead of this snapshot (see its doc comment).
   */
  listScopedFactIdsPendingPrune(scopeFilter: ScopeFilter): string[] {
    return listScopedFactIdsPendingPruneImpl(this.liveDb, scopeFilter);
  }

  findSessionFactsForPromotion(thresholdDays: number, minImportance: number, limit?: number): MemoryEntry[] {
    return findSessionFactsForPromotionImpl(this.liveDb, thresholdDays, minImportance, limit);
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
    ).id;
  }

  detectContradictions(
    newFactId: string,
    entity: string | null | undefined,
    key: string | null | undefined,
    value: string | null | undefined,
    scope?: string | null,
    scopeTarget?: string | null,
    newText?: string | null,
  ): ContradictionDetectionResult[] {
    const results = detectContradictionsImpl(
      this.liveDb,
      newFactId,
      entity,
      key,
      value,
      scope,
      scopeTarget,
      (a, b, t, s) => this.createLink(a, b, t, s ?? 1.0),
      newText,
    );

    // Project-state LWW: immediately resolve contradictions for known mutable keys so
    // active-task/project writes do not leave avoidable unresolved contradictions (#1636).
    if (results.length > 0 && key != null) {
      const keyLower = key.trim().toLowerCase();
      if (PROJECT_STATE_LWW_KEYS.has(keyLower)) {
        const newFact = this.getById(newFactId);
        if (newFact) {
          for (const { contradictionId, oldFactId, oldFactOriginalConfidence } of results) {
            const oldFact = this.getById(oldFactId);
            if (!oldFact) continue;
            const lww = evaluateLwwEligibility(newFact, oldFact, oldFactOriginalConfidence);
            if (lww.eligible && lww.qualifies && !isFactVerified(this.liveDb, oldFactId)) {
              const superseded = this.supersede(oldFactId, newFactId);
              if (superseded) {
                this.resolveContradiction(contradictionId, "superseded");
              }
            }
          }
        }
      }
    }

    return results;
  }

  getContradictions(factId?: string): ContradictionRecord[] {
    return getContradictionsImpl(this.liveDb, factId);
  }

  queryContradictionSurface(
    options: Parameters<typeof queryContradictionSurfaceImpl>[1],
  ): ReturnType<typeof queryContradictionSurfaceImpl> {
    return queryContradictionSurfaceImpl(this.liveDb, options);
  }

  repairUndetectedContradictions(limitGroups?: number): ReturnType<typeof repairUndetectedContradictionsImpl> {
    return repairUndetectedContradictionsImpl(
      this.liveDb,
      (a, b, t, s) => this.createLink(a, b, t, s ?? 1.0),
      limitGroups,
    );
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

  previewResolveContradictions(): ReturnType<typeof previewResolveContradictionsAutoImpl> {
    return previewResolveContradictionsAutoImpl(this.liveDb, (id) => this.getById(id));
  }

  /**
   * Project-state latest-wins resolution pass (Issue #1636).
   * Safely resolves stale `project` contradictions for known mutable keys when the newer
   * trusted fact is strictly newer and has equal or higher confidence.
   *
   * Pass `{ dryRun: true }` to inspect candidates without mutating any data.
   */
  resolveContradictionsProjectStateLww(opts: { dryRun?: boolean } = {}): ProjectStateLwwResult {
    return resolveProjectStateLwwImpl(
      this.liveDb,
      (id) => this.getById(id),
      (o, n) => this.supersede(o, n),
      opts,
    );
  }

  async resolveContradictionsAuto(
    opts: ResolveContradictionsAutoOptions = {},
  ): Promise<ResolveContradictionsAutoResult> {
    return resolveContradictionsAutonomouslyImpl(
      this.liveDb,
      (id) => this.getById(id),
      (o, n) => this.supersede(o, n),
      opts,
    );
  }

  applyContradictionReviewDecisions(
    decisions: ContradictionReviewDecision[],
    opts: { actor?: string; toolVersion?: string | null } = {},
  ): ApplyContradictionReviewResult {
    return applyContradictionReviewDecisionsImpl(
      this.liveDb,
      (id) => this.getById(id),
      (o, n) => this.supersede(o, n),
      decisions,
      opts,
    );
  }

  getContradictionResolutionAudit(contradictionId?: string): ContradictionResolutionAuditRow[] {
    return getContradictionResolutionAuditImpl(this.liveDb, contradictionId);
  }

  contradictionsCount(): number {
    return contradictionsCountImpl(this.liveDb);
  }

  /** Number of facts with `superseded_at IS NOT NULL`. */
  countSupersededFacts(): number {
    return countSupersededFactsImpl(this.liveDb);
  }

  /** Number of rows in `verified_facts` (0 when verification disabled / table absent). */
  countVerifiedFacts(): number {
    return countVerifiedFactsImpl(this.liveDb);
  }

  /** Recent ingestion activity: last 24h / 7d / 30d, plus newest/oldest active timestamps. */
  recentActivity(): ReturnType<typeof recentActivityImpl> {
    return recentActivityImpl(this.liveDb);
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
      (a, b, strength) => this.createOrStrengthenRelatedLink(a, b, strength),
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

  getEdgesForFactIds(ids: string[], limit = 5000): ReturnType<typeof getEdgesForFactIdsImpl> {
    return getEdgesForFactIdsImpl(this.liveDb, ids, limit);
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
    return recordEpisodeImpl(this.liveDb, input, false).episode;
  }

  recordEpisodeWithCausalLinks(input: Parameters<typeof recordEpisodeImpl>[1]): ReturnType<typeof recordEpisodeImpl> {
    return recordEpisodeImpl(this.liveDb, input, true);
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
  applyEntityEnrichment(
    factId: string,
    mentions: ExtractedMention[],
    detectedLang: string,
    opts?: { requireSurnameForNewContacts?: boolean },
  ): void {
    runWithSqliteBusyRetry(this.liveDb, () =>
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
        { requireSurnameForNewContacts: opts?.requireSurnameForNewContacts },
      ),
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
  listFactIdsNeedingEntityEnrichment(
    limit: number,
    minTextLen = 24,
    options?: ListFactsNeedingEnrichmentOptions,
  ): string[] {
    return entityLayerListFactsNeedingEnrichment(this.liveDb, limit, minTextLen, options);
  }

  /** Aggregate pending enrichment backlog by tier for progress reporting and catch-up planning. */
  getEntityEnrichmentBacklogSummary(minTextLen = 24): EntityEnrichmentBacklogSummary {
    return entityLayerGetEntityEnrichmentBacklogSummary(this.liveDb, minTextLen);
  }

  auditEntityMentions(limit = 500): EntityMentionsAuditSummary {
    return entityLayerAuditEntityMentions(this.liveDb, limit);
  }

  cleanupEntityMentions(opts: { limit?: number; apply?: boolean } = {}): EntityMentionsCleanupSummary {
    return entityLayerCleanupEntityMentions(this.liveDb, {
      limit: opts.limit ?? 500,
      apply: opts.apply === true,
    });
  }

  // --- Contact profile enrichment & merge (#2014) ---

  /** Parse email/phone/role/board-status from fact text and merge onto the fact's single PERSON contact. */
  applyContactProfileEnrichment(
    factId: string,
    factText: string,
    source: ContactProfileEnrichmentSource,
  ): ContactProfileEnrichmentResult | null {
    return runWithSqliteBusyRetry(this.liveDb, () =>
      entityLayerApplyContactProfileEnrichmentForFact(this.liveDb, factId, factText, source),
    );
  }

  getContactById(id: string): ContactRow | null {
    return entityLayerGetContactById(this.liveDb, id);
  }

  /** Resolve a contact id or display-name query to a contact id (`contacts merge` CLI). */
  resolveContactId(query: string): string | null {
    return entityLayerResolveContactId(this.liveDb, query);
  }

  getOrganizationById(id: string): OrganizationRow | null {
    return entityLayerGetOrganizationById(this.liveDb, id);
  }

  /** Contacts whose normalized_key is a token prefix/suffix of `normalizedKey` — merge candidates. */
  findContactMergeCandidates(normalizedKey: string, excludeId?: string): ContactRow[] {
    return entityLayerFindContactMergeCandidates(this.liveDb, normalizedKey, excludeId);
  }

  /** Explicitly merge one contact into another (`contacts merge` CLI). Manual source always wins field conflicts. */
  mergeContacts(
    fromId: string,
    intoId: string,
  ): { ok: true; mergedFactMentions: number } | { ok: false; error: string } {
    return runWithSqliteBusyRetry(this.liveDb, () => entityLayerMergeContacts(this.liveDb, fromId, intoId));
  }

  /** Upsert an organization by display name (roster import). */
  upsertOrganization(displayName: string): { id: string; created: boolean } | null {
    return runWithSqliteBusyRetry(this.liveDb, () => entityLayerUpsertOrganization(this.liveDb, displayName));
  }

  /** Upsert a contact with profile fields (roster import / manual CLI). Auto-merges unambiguous partial-name duplicates. */
  upsertContactWithProfile(
    displayName: string,
    primaryOrgId: string | null,
    options: UpsertContactOptions & { updatedBy: ContactUpdatedBy },
  ): { id: string; created: boolean; mergedInto?: string } | null {
    return runWithSqliteBusyRetry(this.liveDb, () =>
      entityLayerUpsertContact(this.liveDb, displayName, primaryOrgId, options),
    );
  }

  /** Link a fact to an organization outside the NER pipeline (roster import uses reason='roster_import'). */
  linkFactToOrganization(orgId: string, factId: string, reason: string): void {
    const now = Math.floor(Date.now() / 1000);
    runWithSqliteBusyRetry(this.liveDb, () =>
      this.liveDb
        .prepare("INSERT OR IGNORE INTO org_fact_links (org_id, fact_id, reason, created_at) VALUES (?, ?, ?, ?)")
        .run(orgId, factId, reason, now),
    );
  }
}
