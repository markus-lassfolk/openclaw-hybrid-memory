/**
 * FactsDB — layer 1: open, variants/embeddings, search/CRUD, graph links (through expandGraphWithCTE).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { MemoryEntry, MemoryTier, ScopeFilter, SearchResult } from "../../types/memory.js";
import { BaseSqliteStore } from "../base-sqlite-store.js";
import { runFactsMigrations } from "../migrations/facts-migrations.js";
import { SupersededTextsCache } from "./cache-manager.js";
import {
  type StoreFactInput,
  deleteFact,
  hasDuplicateText,
  refreshAccessedFacts as refreshAccessedFactsImpl,
  storeFact,
} from "./crud.js";
import { verifyFts5Support } from "./db-connection.js";
import {
  findSimilarForClassification as findSimilarForClassificationImpl,
  getById as getByIdImpl,
  getByIds as getByIdsImpl,
  getFactsForConsolidation as getFactsForConsolidationImpl,
  getHotFacts as getHotFactsImpl,
} from "./fact-read-queries.js";
import {
  createLink as createLinkHelper,
  createOrStrengthenRelatedLink as createOrStrengthenRelatedLinkHelper,
  expandGraphWithCTE as expandGraphWithCTEHelper,
  getConnectedFactIds as getConnectedFactIdsHelper,
  getLinksFrom as getLinksFromHelper,
  getLinksTo as getLinksToHelper,
  strengthenRelatedLinksBatch as strengthenRelatedLinksBatchHelper,
} from "./links.js";
import {
  logRecall as logRecallImpl,
  pruneRecallLog as pruneRecallLogImpl,
  runCompaction as runCompactionImpl,
  setFactTier,
  setPreserveTags as setPreserveTagsImpl,
  setPreserveUntil as setPreserveUntilImpl,
  trimToBudget as trimToBudgetImpl,
} from "./maintenance.js";
import { getScanCursor as getScanCursorHelper, updateScanCursor as updateScanCursorHelper } from "./scan-cursors.js";
import { bootstrapFactsCoreSchema } from "./schema-bootstrap.js";
import { findByIdPrefix as findByIdPrefixImpl, lookupFacts, searchFacts } from "./search.js";
import { getTokenBudgetStatus as getTokenBudgetStatusImpl } from "./stats.js";
import type { MemoryLinkType } from "./types.js";
import {
  countCanonicalEmbeddings as countCanonicalEmbeddingsImpl,
  deleteEmbeddings as deleteEmbeddingsImpl,
  estimateStorageBytesOnDisk,
  getEmbeddingsByModel as getEmbeddingsByModelImpl,
  getEmbeddings as getEmbeddingsImpl,
  getVariants as getVariantsImpl,
  hasVariants as hasVariantsImpl,
  storeEmbedding as storeEmbeddingImpl,
  storeVariant as storeVariantImpl,
  deleteVariants as deleteVariantsImpl,
} from "./variants.js";
import { tryRestrictSqliteDbFileMode } from "../../utils/sqlite-file-perms.js";

export class FactsDBLayer1 extends BaseSqliteStore {
  // Responsibility note:
  // - This class is the stable API boundary.
  // - Extracted implementation modules under backends/facts-db/ own links/reinforcement/scan-cursor logic.
  protected readonly dbPath: string;
  protected readonly fuzzyDedupe: boolean;
  protected readonly supersededTextsCacheMgr = new SupersededTextsCache(5 * 60_000);

  constructor(dbPath: string, options?: { fuzzyDedupe?: boolean }) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);

    try {
      FactsDBLayer1.verifyFts5Support(db);
    } catch (err) {
      try {
        db.close();
      } catch {
        // Ignore close errors during failure cleanup
      }
      throw err;
    }

    super(db, {
      foreignKeys: true,
      customPragmas: [
        "PRAGMA synchronous = NORMAL",
        "PRAGMA wal_autocheckpoint = 1000",
        // Perf: 64MB page cache (up from 2MB default) — avoids repeated disk reads for
        // the ~192MB facts DB during FTS two-phase lookups.  Single-connection model so
        // this is the only consumer.  Env: OPENCLAW_FACTS_CACHE_SIZE_KB to override.
        `PRAGMA cache_size = -${process.env.OPENCLAW_FACTS_CACHE_SIZE_KB ?? "64000"}`,
        // Perf: 256MB memory-mapped I/O — lets the OS page cache serve reads without
        // crossing the user/kernel boundary.  Env: OPENCLAW_FACTS_MMAP_SIZE to override.
        `PRAGMA mmap_size = ${process.env.OPENCLAW_FACTS_MMAP_SIZE ?? "268435456"}`,
        "PRAGMA temp_store = MEMORY",
      ],
    });
    this.dbPath = dbPath;
    tryRestrictSqliteDbFileMode(dbPath);
    this.fuzzyDedupe = options?.fuzzyDedupe ?? false;

    bootstrapFactsCoreSchema(this.liveDb);

    // Run all schema migrations
    runFactsMigrations(this.liveDb);
  }

  /**
   * Hard-startup guard for SQLite FTS5 support.
   *
   * Some Node.js/SQLite builds can run without FTS5 enabled, which would cause
   * hybrid retrieval to silently degrade to vector-only once the FTS strategy
   * starts failing. Probe FTS5 explicitly and fail fast with an actionable error.
   */
  /** @deprecated Prefer importing `verifyFts5Support` from `./facts-db/db-connection.js` (kept for tests). */
  static verifyFts5Support(db: DatabaseSync): void {
    verifyFts5Support(db);
  }

  /** Return the cursor for the given scan type, or null if never run. */
  getScanCursor(scanType: string): {
    lastSessionTs: number;
    lastRunAt: number;
    sessionsProcessed: number;
  } | null {
    return getScanCursorHelper(this.liveDb, scanType);
  }

  /**
   * Upsert the cursor after a successful incremental scan.
   * @param lastSessionTs Timestamp of the newest session processed (file mtime). Pass `Date.now()`
   *   when no session watermark is available (e.g. self-correction). Pass `0` when no sessions
   *   were processed — `last_session_ts` will not be updated in that case.
   * @param sessionsProcessed Number of sessions processed in this run.
   */
  updateScanCursor(scanType: string, lastSessionTs: number, sessionsProcessed: number): void {
    updateScanCursorHelper(this.liveDb, scanType, lastSessionTs, sessionsProcessed);
  }

  /**
   * Store a contextual variant text for a fact.
   * Returns the new row id.
   */
  storeVariant(factId: string, variantType: string, variantText: string): number {
    return storeVariantImpl(this.liveDb, factId, variantType, variantText);
  }

  getVariants(factId: string): Array<{
    id: number;
    variantType: string;
    variantText: string;
    createdAt: string;
  }> {
    return getVariantsImpl(this.liveDb, factId);
  }

  hasVariants(factId: string): boolean {
    return hasVariantsImpl(this.liveDb, factId);
  }

  deleteVariants(factId: string): void {
    deleteVariantsImpl(this.liveDb, factId);
  }

  storeEmbedding(factId: string, model: string, variant: string, embedding: Float32Array, dimensions: number): void {
    storeEmbeddingImpl(this.liveDb, factId, model, variant, embedding, dimensions);
  }

  getEmbeddings(factId: string): Array<{ model: string; variant: string; embedding: Float32Array }> {
    return getEmbeddingsImpl(this.liveDb, factId);
  }

  getEmbeddingsByModel(model: string, limit?: number): Array<{ factId: string; embedding: Float32Array }> {
    return getEmbeddingsByModelImpl(this.liveDb, model, limit);
  }

  deleteEmbeddings(factId: string): void {
    deleteEmbeddingsImpl(this.liveDb, factId);
  }

  /** Re-apply connection pragmas (used on initial open and auto-reopen). */
  protected getSubsystemName(): string {
    return "facts-db";
  }

  countCanonicalEmbeddings(): number {
    return countCanonicalEmbeddingsImpl(this.liveDb);
  }

  estimateStorageBytes(): {
    sqliteBytes: number;
    walBytes: number;
    shmBytes: number;
  } {
    return estimateStorageBytesOnDisk(this.dbPath);
  }

  store(entry: StoreFactInput): MemoryEntry {
    return storeFact(
      {
        db: this.liveDb,
        fuzzyDedupe: this.fuzzyDedupe,
        getById: (id) => this.getById(id),
        invalidateSupersededCache: () => {
          this.supersededTextsCacheMgr.invalidate();
        },
      },
      entry,
    );
  }

  /** Update recall_count and last_accessed for facts (public for progressive disclosure). Bulk UPDATE to avoid N+1. */
  refreshAccessedFacts(ids: string[]): void {
    refreshAccessedFactsImpl(this.liveDb, ids);
  }

  /** Record a memory_recall invocation outcome for hit-rate tracking (Issue #148). */
  logRecall(hit: boolean, occurredAtSec?: number): void {
    logRecallImpl(this.liveDb, hit, occurredAtSec);
  }

  /** Prune recall_log entries older than N days to prevent unbounded growth (Issue #148). */
  pruneRecallLog(olderThanDays = 30): number {
    return pruneRecallLogImpl(this.liveDb, olderThanDays);
  }

  /** Read the last stored embedding provider+model metadata (Issue #153). */
  getEmbeddingMeta(): { provider: string; model: string } | null {
    const row = this.liveDb.prepare("SELECT provider, model FROM embedding_meta WHERE id = 1").get() as
      | { provider: string; model: string }
      | undefined;
    if (!row) return null;
    return { provider: row.provider, model: row.model };
  }

  /** Persist the active embedding provider+model metadata (Issue #153). */
  setEmbeddingMeta(provider: string, model: string): void {
    const nowSec = Math.floor(Date.now() / 1000);
    this.liveDb
      .prepare(
        `INSERT INTO embedding_meta (id, provider, model, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, model = excluded.model, updated_at = excluded.updated_at`,
      )
      .run(provider, model, nowSec);
  }

  /** Record which embedding model generated the stored vector for a fact (Issue #153). */
  setEmbeddingModel(id: string, model: string | null): void {
    this.liveDb.prepare("UPDATE facts SET embedding_model = ? WHERE id = ?").run(model, id);
  }

  /** Get HOT-tier facts for session context, capped by token budget. */
  getHotFacts(maxTokens: number, scopeFilter?: ScopeFilter | null): SearchResult[] {
    return getHotFactsImpl(this.liveDb, maxTokens, scopeFilter);
  }

  /** Set a fact's tier. */
  setTier(id: string, tier: MemoryTier): boolean {
    return setFactTier(this.liveDb, id, tier);
  }

  /** Compaction — migrate facts between tiers. Completed tasks -> COLD, inactive preferences -> WARM, active blockers -> HOT. */
  runCompaction(opts: {
    inactivePreferenceDays: number;
    hotMaxTokens: number;
    hotMaxFacts: number;
  }): {
    hot: number;
    warm: number;
    cold: number;
  } {
    return runCompactionImpl(this.liveDb, opts);
  }

  /**
   * Token-budget tiered trimming for context compaction (Issue #792).
   *
   * Retention tiers (never trimmed = P0):
   *  - Edict-tagged facts (tag 'edict')
   *  - Verified facts (present in verified_facts table)
   *  - Facts with active preserveUntil (epoch seconds in future)
   *  - Facts with non-empty preserveTags
   *
   * Remaining facts sorted by trim priority:
   *  - P1: importance > 0.8 AND created within the last hour
   *  - P2: importance 0.5 – 0.8
   *  - P3: importance < 0.5
   *
   * Trimming proceeds P3 → P2 → P1 until within budget.
   * Token estimate: Math.ceil(chars / 3.8)
   *
   * Returns a summary of what would be / was trimmed.
   */
  trimToBudget(
    tokenBudget: number,
    simulate = false,
  ): {
    simulate: boolean;
    budget: number;
    beforeTokens: number;
    afterTokens: number;
    trimmed: Array<{
      id: string;
      textPreview: string;
      tier: string;
      importance: number;
      tokenCost: number;
    }>;
    preserved: Array<{ id: string; reason: string }>;
    error?: string;
  } {
    return trimToBudgetImpl(this.liveDb, tokenBudget, simulate);
  }

  /**
   * Set or clear preserve_until on a fact.
   * If untilSec is null, clears any existing preserve_until.
   * Returns the updated MemoryEntry or null if not found.
   */
  setPreserveUntil(id: string, untilSec: number | null): MemoryEntry | null {
    return setPreserveUntilImpl(this.liveDb, (i) => this.getById(i), id, untilSec);
  }

  /**
   * Add or remove preserve_tags on a fact.
   * mode 'set': replaces all tags with the given array.
   * mode 'add': adds the given tags (deduped).
   * mode 'remove': removes the given tags.
   * Returns the updated MemoryEntry or null if not found.
   */
  setPreserveTags(id: string, tags: string[], mode: "set" | "add" | "remove"): MemoryEntry | null {
    return setPreserveTagsImpl(this.liveDb, (i) => this.getById(i), id, tags, mode);
  }

  /**
   * Compute current token estimate for all non-superseded, non-expired facts.
   * Returns { totalTokens, byTier: { p0, p1, p2, p3 }, factCount: { p0, p1, p2, p3 } }.
   */
  getTokenBudgetStatus(): {
    totalTokens: number;
    budget: number;
    overflow: number;
    byTier: { p0: number; p1: number; p2: number; p3: number };
    factCount: { p0: number; p1: number; p2: number; p3: number };
  } {
    return getTokenBudgetStatusImpl(this.liveDb);
  }

  search(
    query: string,
    limit = 5,
    options: {
      includeExpired?: boolean;
      tag?: string;
      includeSuperseded?: boolean;
      /** Point-in-time: only facts valid at this epoch second. */
      asOf?: number;
      /** 'warm' = only warm tier (default), 'all' = warm + cold. */
      tierFilter?: "warm" | "all";
      /** Scope filter — only return global + matching user/agent/session. */
      scopeFilter?: ScopeFilter | null;
      /** Reinforcement boost — added to score when reinforced_count > 0 (default: 0.1). */
      reinforcementBoost?: number;
      /** Weight applied to diversity score when calculating effective boost (default: 1.0). */
      diversityWeight?: number;
      /**
       * Interactive auto-recall hot path: cap FTS OR-term explosion and avoid loading full fact rows
       * until top matches are chosen (reduces WhatsApp/gateway stalls from huge MATCH + wide SELECT f.*).
       */
      interactiveFtsFastPath?: boolean;
    } = {},
  ): SearchResult[] {
    return searchFacts(this.liveDb, query, limit, options);
  }

  lookup(
    entity: string,
    key?: string,
    tag?: string,
    options?: {
      includeSuperseded?: boolean;
      asOf?: number;
      scopeFilter?: ScopeFilter | null;
      limit?: number;
    },
  ): SearchResult[] {
    return lookupFacts(this.liveDb, entity, key, tag, options);
  }

  /** Find a fact ID by prefix (for truncated ID resolution).
   * Returns { id } for unique match, { ambiguous, count } for multiple, or null for no match.
   * Requires at least 4 hex chars to prevent full-table scans and reduce ambiguity. */
  findByIdPrefix(prefix: string): { id: string } | { ambiguous: true; count: number } | null {
    return findByIdPrefixImpl(this.liveDb, prefix);
  }

  delete(id: string): boolean {
    return deleteFact(this.liveDb, id);
  }

  /** Exact or (if fuzzyDedupe) normalized-text duplicate. */
  hasDuplicate(text: string): boolean {
    return hasDuplicateText(this.liveDb, this.fuzzyDedupe, text);
  }

  /** Mark a fact as superseded by a new fact. Sets superseded_at, superseded_by, and valid_until (bi-temporal). */
  supersede(oldId: string, newId: string | null): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = this.liveDb
      .prepare(
        "UPDATE facts SET superseded_at = ?, superseded_by = ?, valid_until = ? WHERE id = ? AND superseded_at IS NULL",
      )
      .run(nowSec, newId, nowSec, oldId);
    if (result.changes > 0) {
      this.invalidateSupersededCache();
    }
    return result.changes > 0;
  }

  /** Find top-N most similar existing facts by entity+key overlap and normalized text. Used for ADD/UPDATE/DELETE classification. */
  findSimilarForClassification(text: string, entity: string | null, key: string | null, limit = 5): MemoryEntry[] {
    return findSimilarForClassificationImpl(this.liveDb, text, entity, key, limit);
  }

  /** For consolidation (2.4): fetch facts with id, text, category, entity, key. Order by created_at DESC. Excludes superseded. */
  getFactsForConsolidation(limit: number): Array<{
    id: string;
    text: string;
    category: string;
    entity: string | null;
    key: string | null;
  }> {
    return getFactsForConsolidationImpl(this.liveDb, limit);
  }

  /** Alias for getById for CLI compatibility. */
  get(id: string): MemoryEntry | null {
    return this.getById(id);
  }

  /** Get one fact by id (for merge category). Returns null if not found. When asOf is set, returns null if the fact was not valid at that time. When scopeFilter is set, returns null if the fact is not in scope. */
  getById(id: string, options?: { asOf?: number; scopeFilter?: ScopeFilter | null }): MemoryEntry | null {
    return getByIdImpl(this.liveDb, id, options);
  }

  /** Batch get facts by id. Returns a Map of id → entry after asOf/scope filtering. */
  getByIds(ids: string[], options?: { asOf?: number; scopeFilter?: ScopeFilter | null }): Map<string, MemoryEntry> {
    return getByIdsImpl(this.liveDb, ids, options);
  }

  /** Create a typed link between two facts. Returns link id. */
  createLink(sourceFactId: string, targetFactId: string, linkType: MemoryLinkType, strength = 1.0): string {
    return createLinkHelper(this.liveDb, sourceFactId, targetFactId, linkType, strength);
  }

  /** Hebbian: Create or strengthen RELATED_TO link between two facts recalled together. */
  createOrStrengthenRelatedLink(factIdA: string, factIdB: string, deltaStrength = 0.1): void {
    createOrStrengthenRelatedLinkHelper(this.liveDb, factIdA, factIdB, deltaStrength);
  }

  /**
   * Hebbian batch: strengthen RELATED_TO links for all pairs in a single SQLite transaction.
   * Reduces O(n²) individual round-trips to 1 transaction regardless of pair count.
   */
  strengthenRelatedLinksBatch(pairs: [string, string][], deltaStrength = 0.1): void {
    strengthenRelatedLinksBatchHelper(this.liveDb, pairs, deltaStrength);
  }

  /** Get links from a fact (outgoing). */
  getLinksFrom(factId: string): Array<{
    id: string;
    targetFactId: string;
    linkType: string;
    strength: number;
  }> {
    return getLinksFromHelper(this.liveDb, factId);
  }

  /** Get links to a fact (incoming). */
  getLinksTo(factId: string): Array<{
    id: string;
    sourceFactId: string;
    linkType: string;
    strength: number;
  }> {
    return getLinksToHelper(this.liveDb, factId);
  }

  /** BFS from given fact IDs up to maxDepth hops. Returns all connected fact IDs (including the seed set).
   * CONTRADICTS links are excluded from traversal — they would otherwise pollute graph-based recall
   * with unrelated contradicted facts and cause traversal explosion when a fact has many contradictions.
   */
  getConnectedFactIds(factIds: string[], maxDepth: number): string[] {
    return getConnectedFactIdsHelper(this.liveDb, factIds, maxDepth);
  }

  /**
   * Perform graph expansion using a recursive CTE, returning expanded nodes with hop count and path info.
   * This is used by graph-retrieval.ts to avoid N+1 query patterns.
   *
   * @param seedFactIds - Array of seed fact IDs to start expansion from
   * @param maxDepth - Maximum traversal depth
   * @returns Array of expanded nodes with factId, seedId, hopCount, and path (JSON array of link steps)
   */
  expandGraphWithCTE(
    seedFactIds: string[],
    maxDepth: number,
    options?: {
      asOf?: number;
      scopeFilter?: { userId?: string; agentId?: string; sessionId?: string };
    },
  ): Array<{
    factId: string;
    seedId: string;
    hopCount: number;
    path: string;
  }> {
    return expandGraphWithCTEHelper(this.liveDb, seedFactIds, maxDepth, options);
  }

  /** Invalidate superseded texts cache (called after supersede operations). */
  protected invalidateSupersededCache(): void {
    this.supersededTextsCacheMgr.invalidate();
  }
}
