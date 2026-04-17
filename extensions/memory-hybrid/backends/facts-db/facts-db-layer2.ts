/**
 * FactsDB — layer 2: bulk reads, maintenance, stats, procedures.
 */

import type { DatabaseSync } from "node:sqlite";

import type {
	MemoryEntry,
	ProcedureEntry,
	ScopeFilter,
} from "../../types/memory.js";
import {
	getAllIds as getAllIdsImpl,
	getAll as getAllImpl,
	getBatch as getBatchImpl,
	getByCategory as getByCategoryImpl,
	getCount as getCountImpl,
	getRecentFacts as getRecentFactsImpl,
	listDirectives as listDirectivesImpl,
	listFactsByCategory as listFactsByCategoryImpl,
	listFacts as listFactsImpl,
	updateCategory as updateCategoryImpl,
} from "./fact-read-queries.js";
import { FactsDBLayer1 } from "./facts-db-layer1.js";
import {
	backfillDecayClasses as backfillDecayClassesImpl,
	confirmFact as confirmFactImpl,
	decayConfidence as decayConfidenceImpl,
	promoteScope as promoteScopeImpl,
	pruneExpired as pruneExpiredImpl,
	pruneSessionScope as pruneSessionScopeImpl,
	restoreCheckpoint as restoreCheckpointImpl,
	saveCheckpoint as saveCheckpointImpl,
} from "./maintenance.js";
import {
	findProcedureByTaskPattern as findProcedureByTaskPatternImpl,
	getNegativeProceduresMatching as getNegativeProceduresMatchingImpl,
	getProcedureById as getProcedureByIdImpl,
	getProcedureFailures as getProcedureFailuresImpl,
	getProcedureVersions as getProcedureVersionsImpl,
	getProceduresForAudit as getProceduresForAuditImpl,
	getProceduresReadyForSkill as getProceduresReadyForSkillImpl,
	getStaleProcedures as getStaleProceduresImpl,
	listProcedures as listProceduresImpl,
	listProceduresUpdatedInLastNDays as listProceduresUpdatedInLastNDaysImpl,
	markProcedurePromoted as markProcedurePromotedImpl,
	procedureFeedback as procedureFeedbackImpl,
	proceduresCount as proceduresCountImpl,
	proceduresPromotedCount as proceduresPromotedCountImpl,
	proceduresValidatedCount as proceduresValidatedCountImpl,
	recordProcedureFailure as recordProcedureFailureImpl,
	recordProcedureSuccess as recordProcedureSuccessImpl,
	searchProcedures as searchProceduresImpl,
	searchProceduresRanked as searchProceduresRankedImpl,
	upsertProcedure as upsertProcedureImpl,
} from "./procedures.js";
import {
	boostConfidence as boostConfidenceHelper,
	calculateDiversityScore as calculateDiversityScoreHelper,
	getReinforcementEvents as getReinforcementEventsHelper,
	reinforceFact as reinforceFactHelper,
	reinforceProcedure as reinforceProcedureHelper,
} from "./reinforcement.js";
import { getSupersededTextsSnapshot } from "./search.js";
import {
	countExpiredFacts as countExpiredFactsImpl,
	countFacts as countFactsImpl,
	directivesCount as directivesCountImpl,
	entityCount as entityCountImpl,
	estimateStoredTokensByTier as estimateStoredTokensByTierImpl,
	estimateStoredTokens as estimateStoredTokensImpl,
	linksCount as linksCountImpl,
	listForDashboard as listForDashboardImpl,
	metaPatternsCount as metaPatternsCountImpl,
	statsBreakdownByCategory as statsBreakdownByCategoryImpl,
	statsBreakdownByDecayClass as statsBreakdownByDecayClassImpl,
	statsBreakdownBySource as statsBreakdownBySourceImpl,
	statsBreakdownByTier as statsBreakdownByTierImpl,
	statsBreakdown as statsBreakdownImpl,
	uniqueMemoryCategories as uniqueMemoryCategoriesImpl,
} from "./stats.js";
import type { ReinforcementContext, ReinforcementEvent } from "./types.js";

export class FactsDBLayer2 extends FactsDBLayer1 {
	/** Get facts from the last N days (for reflection). Excludes pattern/rule by default. More efficient than getAll+filter. */
	getRecentFacts(
		days: number,
		options?: { excludeCategories?: string[] },
	): MemoryEntry[] {
		return getRecentFactsImpl(this.liveDb, days, options);
	}

	/** Get all non-expired facts (for reflection). Optional point-in-time / include superseded. Optional scope filter. */
	getAll(options?: {
		includeSuperseded?: boolean;
		asOf?: number;
		scopeFilter?: ScopeFilter | null;
	}): MemoryEntry[] {
		return getAllImpl(this.liveDb, options);
	}

	/**
	 * Count non-expired facts (for migration progress). Same filter as getAll with includeSuperseded.
	 */
	getCount(options?: { includeSuperseded?: boolean }): number {
		return getCountImpl(this.liveDb, options);
	}

	/**
	 * Return all active fact IDs.
	 * Active = not expired and not superseded (same filter as getAll() default).
	 * Keeping this filter in sync with getAll() ensures that the set of IDs
	 * returned here is consistent with what callers expect to be "live" facts.
	 * Used by the reconcile command to detect orphan entries.
	 * IDs are normalized to lowercase to match VectorDB.getAllIds() normalization.
	 */
	getAllIds(): string[] {
		return getAllIdsImpl(this.liveDb);
	}

	/**
	 * Get a batch of non-expired facts (for migration without loading all into memory).
	 * Same ordering and filter as getAll; offset/limit applied.
	 */
	getBatch(
		offset: number,
		limit: number,
		options?: { includeSuperseded?: boolean },
	): MemoryEntry[] {
		return getBatchImpl(this.liveDb, offset, limit, options);
	}

	/** List recent facts with optional filters (for CLI list command). Order: created_at DESC. */
	list(
		limit: number,
		filters?: {
			category?: string;
			entity?: string;
			key?: string;
			source?: string;
			tier?: string;
		},
	): MemoryEntry[] {
		return listFactsImpl(this.liveDb, limit, filters);
	}

	/** Get texts of superseded facts (for filtering LanceDB results). Cached to avoid repeated full scans. */
	getSupersededTexts(): Set<string> {
		return getSupersededTextsSnapshot(
			this.supersededTextsCacheMgr,
			this.liveDb,
		);
	}

	count(): number {
		return countFactsImpl(this.liveDb);
	}

	pruneExpired(): number {
		return pruneExpiredImpl(this.liveDb);
	}

	/** Prune session-scoped memories for a given session (cleared on session end). Returns count deleted. */
	pruneSessionScope(sessionId: string): number {
		return pruneSessionScopeImpl(this.liveDb, sessionId);
	}

	/** Promote a fact's scope (e.g. session → global or agent). Returns true if updated. */
	promoteScope(
		factId: string,
		newScope: "global" | "user" | "agent" | "session",
		newScopeTarget: string | null,
	): boolean {
		return promoteScopeImpl(this.liveDb, factId, newScope, newScopeTarget);
	}

	decayConfidence(): number {
		return decayConfidenceImpl(this.liveDb);
	}

	confirmFact(id: string): boolean {
		return confirmFactImpl(this.liveDb, id);
	}

	/**
	 * Boost the confidence of a fact by a delta, clamped at maxConfidence.
	 * Also increments reinforced_count and updates last_reinforced_at.
	 * Returns true if the fact was found and updated.
	 */
	boostConfidence(id: string, delta: number, maxConfidence = 1.0): boolean {
		return boostConfidenceHelper(this.liveDb, id, delta, maxConfidence);
	}

	/**
	 * Annotate a fact with reinforcement from user praise.
	 * Increments reinforced_count, updates last_reinforced_at, appends quote (max 10 quotes kept).
	 * Optionally records a rich context event in reinforcement_log (#259).
	 * Wraps read-modify-write in a transaction to prevent race conditions.
	 * Returns true if fact was updated.
	 */
	reinforceFact(
		id: string,
		quoteSnippet: string,
		context?: ReinforcementContext,
		opts?: {
			trackContext?: boolean;
			maxEventsPerFact?: number;
			boostAmount?: number;
		},
	): boolean {
		return reinforceFactHelper(this.liveDb, id, quoteSnippet, context, opts);
	}

	/**
	 * Get all reinforcement events for a fact from reinforcement_log (#259).
	 */
	getReinforcementEvents(factId: string): ReinforcementEvent[] {
		return getReinforcementEventsHelper(this.liveDb, factId);
	}

	/**
	 * Calculate diversity score for a fact: unique query stems / total events.
	 * Score 1.0 = all events from different queries; 0.0 = all from same query (#259).
	 */
	calculateDiversityScore(factId: string): number {
		return calculateDiversityScoreHelper(this.liveDb, factId);
	}

	/**
	 * Phase 2: Annotate a procedure with reinforcement from user praise.
	 * Increments reinforced_count, updates last_reinforced_at, appends quote (max 10 quotes kept).
	 * Checks if reinforced_count reaches promotion threshold and auto-promotes if needed.
	 * Wraps read-modify-write in a transaction to prevent race conditions.
	 * Returns true if procedure was updated.
	 */
	reinforceProcedure(
		id: string,
		quoteSnippet: string,
		promotionThreshold = 2,
	): boolean {
		return reinforceProcedureHelper(
			this.liveDb,
			id,
			quoteSnippet,
			promotionThreshold,
		);
	}

	saveCheckpoint(context: {
		intent: string;
		state: string;
		expectedOutcome?: string;
		workingFiles?: string[];
	}): string {
		return saveCheckpointImpl((entry) => this.store(entry), context);
	}

	restoreCheckpoint(): {
		id: string;
		intent: string;
		state: string;
		expectedOutcome?: string;
		workingFiles?: string[];
		savedAt: string;
	} | null {
		return restoreCheckpointImpl(this.liveDb);
	}

	statsBreakdown(): Record<string, number> {
		return statsBreakdownImpl(this.liveDb);
	}

	/** Tier breakdown (hot/warm/cold) for non-superseded facts. */
	statsBreakdownByTier(): Record<string, number> {
		return statsBreakdownByTierImpl(this.liveDb);
	}

	/** Source breakdown (conversation, cli, distillation, reflection, etc.) for non-superseded facts. */
	statsBreakdownBySource(): Record<string, number> {
		return statsBreakdownBySourceImpl(this.liveDb);
	}

	/** Category breakdown for non-superseded facts (for rich stats). */
	statsBreakdownByCategory(): Record<string, number> {
		return statsBreakdownByCategoryImpl(this.liveDb);
	}

	/** Decay class breakdown for non-superseded facts (for dashboard stats). */
	statsBreakdownByDecayClass(): Record<string, number> {
		return statsBreakdownByDecayClassImpl(this.liveDb);
	}

	/**
	 * List facts for dashboard/API: paginated, filterable by category/tier/entity, optional FTS search.
	 * Returns entries in dashboard shape (snake_case for JSON) and total count.
	 */
	listForDashboard(opts: {
		limit: number;
		offset: number;
		category?: string;
		tier?: string;
		decayClass?: string;
		entity?: string;
		search?: string;
	}): { facts: Array<Record<string, unknown>>; total: number } {
		return listForDashboardImpl(this.liveDb, opts);
	}

	/** Distinct memory categories present in non-superseded facts (for CLI stats/categories). */
	uniqueMemoryCategories(): string[] {
		return uniqueMemoryCategoriesImpl(this.liveDb);
	}

	/** Snapshot of top procedures for context-audit (sorted by confidence). */
	getProceduresForAudit(
		limit = 5,
	): ReturnType<typeof getProceduresForAuditImpl> {
		return getProceduresForAuditImpl(this.liveDb, limit);
	}

	/** Count of procedures (from procedures table). Returns 0 if table does not exist. */
	proceduresCount(): number {
		return proceduresCountImpl(this.liveDb);
	}

	/** Count of procedures with last_validated set (validated at least once). */
	proceduresValidatedCount(): number {
		return proceduresValidatedCountImpl(this.liveDb);
	}

	/** Count of procedures promoted to skill (promoted_to_skill = 1). */
	proceduresPromotedCount(): number {
		return proceduresPromotedCountImpl(this.liveDb);
	}

	/** Count of rows in memory_links (graph connections). Returns 0 if table does not exist. */
	linksCount(): number {
		return linksCountImpl(this.liveDb);
	}

	/** Count of facts with source LIKE 'directive:%' (extracted directives). */
	directivesCount(): number {
		return directivesCountImpl(this.liveDb);
	}

	/** Count of facts with category = 'pattern' and tag 'meta' (meta-patterns). */
	metaPatternsCount(): number {
		return metaPatternsCountImpl(this.liveDb);
	}

	/** Distinct entity count (non-null, non-empty entity values). */
	entityCount(): number {
		return entityCountImpl(this.liveDb);
	}

	/** Estimated total tokens stored (summary or text) for non-superseded facts. Uses same heuristic as auto-recall. */
	estimateStoredTokens(): number {
		return estimateStoredTokensImpl(this.liveDb);
	}

	/** Estimated tokens by tier (hot/warm/cold) for non-superseded facts. */
	estimateStoredTokensByTier(): { hot: number; warm: number; cold: number } {
		return estimateStoredTokensByTierImpl(this.liveDb);
	}

	countExpired(): number {
		return countExpiredFactsImpl(this.liveDb);
	}

	backfillDecayClasses(): Record<string, number> {
		return backfillDecayClassesImpl(this.liveDb);
	}

	getByCategory(category: string): MemoryEntry[] {
		return getByCategoryImpl(this.liveDb, category);
	}

	/** List non-superseded facts by category (for CLI list command). */
	listFactsByCategory(category: string, limit = 100): MemoryEntry[] {
		return listFactsByCategoryImpl(this.liveDb, category, limit);
	}

	/** List directive facts (source LIKE 'directive:%'), non-superseded, by created_at DESC. */
	listDirectives(limit = 100): MemoryEntry[] {
		return listDirectivesImpl(this.liveDb, limit);
	}

	updateCategory(id: string, category: string): boolean {
		return updateCategoryImpl(this.liveDb, id, category);
	}

	/** Get the live DB handle, reopening if closed after a SIGUSR1 restart. */
	/**
	 * Expose the underlying node:sqlite DatabaseSync for services that require direct
	 * SQL access (e.g. the FTS5 search service used by the RRF retrieval pipeline).
	 * Returned instance is the same live handle used internally (with auto-reopen).
	 */
	getRawDb(): DatabaseSync {
		return this.liveDb;
	}

	// ---------- Procedural memory (see facts-db/procedures.ts) ----------

	procedureFeedback(
		input: Parameters<typeof procedureFeedbackImpl>[1],
	): ProcedureEntry | null {
		return procedureFeedbackImpl(this.liveDb, input);
	}

	getProcedureVersions(
		procedureId: string,
	): ReturnType<typeof getProcedureVersionsImpl> {
		return getProcedureVersionsImpl(this.liveDb, procedureId);
	}

	getProcedureFailures(
		procedureId: string,
	): ReturnType<typeof getProcedureFailuresImpl> {
		return getProcedureFailuresImpl(this.liveDb, procedureId);
	}

	upsertProcedure(
		proc: Parameters<typeof upsertProcedureImpl>[1],
	): ProcedureEntry {
		return upsertProcedureImpl(this.liveDb, proc);
	}

	listProcedures(limit = 100): ProcedureEntry[] {
		return listProceduresImpl(this.liveDb, limit);
	}

	listProceduresUpdatedInLastNDays(
		days: number,
		limit = 500,
	): ProcedureEntry[] {
		return listProceduresUpdatedInLastNDaysImpl(this.liveDb, days, limit);
	}

	getProcedureById(id: string): ProcedureEntry | null {
		return getProcedureByIdImpl(this.liveDb, id);
	}

	findProcedureByTaskPattern(taskPattern: string, limit = 5): ProcedureEntry[] {
		return findProcedureByTaskPatternImpl(this.liveDb, taskPattern, limit);
	}

	searchProcedures(
		taskDescription: string,
		limit = 10,
		reinforcementBoost = 0.1,
		scopeFilter?: ScopeFilter,
	): ProcedureEntry[] {
		return searchProceduresImpl(
			this.liveDb,
			taskDescription,
			limit,
			reinforcementBoost,
			scopeFilter,
		);
	}

	searchProceduresRanked(
		taskDescription: string,
		limit = 10,
		reinforcementBoost = 0.1,
		scopeFilter?: ScopeFilter,
	): Array<ProcedureEntry & { relevanceScore: number }> {
		return searchProceduresRankedImpl(
			this.liveDb,
			taskDescription,
			limit,
			reinforcementBoost,
			scopeFilter,
		);
	}

	getNegativeProceduresMatching(
		taskDescription: string,
		limit = 5,
		scopeFilter?: ScopeFilter,
	): ProcedureEntry[] {
		return getNegativeProceduresMatchingImpl(
			this.liveDb,
			taskDescription,
			limit,
			scopeFilter,
		);
	}

	recordProcedureSuccess(
		id: string,
		recipeJson?: string,
		sessionId?: string,
	): boolean {
		return recordProcedureSuccessImpl(this.liveDb, id, recipeJson, sessionId);
	}

	recordProcedureFailure(
		id: string,
		recipeJson?: string,
		sessionId?: string,
	): boolean {
		return recordProcedureFailureImpl(this.liveDb, id, recipeJson, sessionId);
	}

	getProceduresReadyForSkill(
		validationThreshold: number,
		limit = 50,
	): ProcedureEntry[] {
		return getProceduresReadyForSkillImpl(
			this.liveDb,
			validationThreshold,
			limit,
		);
	}

	markProcedurePromoted(id: string, skillPath: string): boolean {
		return markProcedurePromotedImpl(this.liveDb, id, skillPath);
	}

	getStaleProcedures(ttlDays: number, limit = 100): ProcedureEntry[] {
		return getStaleProceduresImpl(this.liveDb, ttlDays, limit);
	}
}
