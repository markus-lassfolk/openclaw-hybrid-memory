// GraphQL resolver map for the dashboard API.
// Keep this module conservative: it must compile against the real FactsDB API and
// return safe placeholders for schema areas that are not implemented yet.

import type { FactsDB } from "../backends/facts-db.js";
import { isPreStoreGuardBlocked } from "../backends/facts-db/crud.js";
import type { VectorDB } from "../backends/vector-db.js";
import { DECAY_CLASSES, type DecayClass } from "../config.js";
import type { MemoryLinkType } from "../backends/facts-db/types.js";
import { isPromptArtifactOrReasoningTrace } from "../services/capture-utils.js";
import type { MemoryEntry, ScopeFilter } from "../types/memory.js";
import type { EmbeddingProvider } from "../services/embeddings/types.js";
import { capturePluginError } from "../services/error-reporter.js";
import { cleanupEvictedVector, deleteVectorForFactId } from "../services/vector-maintenance.js";
import { persistCanonicalFactEmbedding } from "../utils/fact-embeddings.js";
import { pluginLogger } from "../utils/logger.js";
import { scopeFieldsFromFilter } from "../utils/scope-filter.js";
import {
  notifyGraphqlFactCreated,
  notifyGraphqlFactDeleted,
  notifyGraphqlFactUpdated,
  notifyGraphqlLinkCreated,
} from "./graphql-pubsub.js";

export type GraphQLContext = {
  factsDb: FactsDB;
  vectorDb?: VectorDB;
  pluginContext: Record<string, unknown>;
  /** Caller's resolved scope, derived from identity headers. Every read resolver must apply this. */
  scopeFilter: ScopeFilter;
};

type ResolverFn = (parent: unknown, args: unknown, context: GraphQLContext) => unknown;
type ResolverGroup = Record<string, ResolverFn>;

type GraphQLResolvers = {
  Query: ResolverGroup;
  Mutation: ResolverGroup;
  Fact: ResolverGroup;
  Link: ResolverGroup;
  Episode: ResolverGroup;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function getGraphqlEmbeddings(context: GraphQLContext): EmbeddingProvider | undefined {
  const candidate = context.pluginContext?.embeddings;
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof (candidate as EmbeddingProvider).embed === "function" &&
    typeof (candidate as EmbeddingProvider).modelName === "string"
  ) {
    return candidate as EmbeddingProvider;
  }
  return undefined;
}

function parsePruneOlderThan(value: unknown): number {
  const asNum = asNumber(value);
  if (asNum !== undefined) return asNum;
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  throw new Error("pruneFacts requires valid olderThan (unix seconds or ISO DateTime)");
}

async function indexGraphqlFactVector(context: GraphQLContext, entry: MemoryEntry): Promise<void> {
  const embeddings = getGraphqlEmbeddings(context);
  if (!context.vectorDb || !embeddings) return;
  try {
    const vector = await embeddings.embed(entry.text);
    context.factsDb.setEmbeddingModel(entry.id, embeddings.modelName);
    if (!(await context.vectorDb.hasDuplicate(vector))) {
      await context.vectorDb.store({
        text: entry.text,
        vector,
        importance: entry.importance,
        category: entry.category,
        id: entry.id,
      });
    }
    persistCanonicalFactEmbedding(
      context.factsDb,
      entry.id,
      embeddings.modelName,
      vector,
      "graphql-mutation-index",
      "graphql",
      (msg) => pluginLogger.warn(msg),
    );
  } catch (err) {
    capturePluginError(err instanceof Error ? err : new Error(String(err)), {
      subsystem: "graphql",
      operation: "indexGraphqlFactVector",
      factId: entry.id,
    });
    pluginLogger.warn(`memory-hybrid: GraphQL vector index failed for ${entry.id}: ${err}`);
  }
}

function allFacts(context: GraphQLContext, includeSuperseded = false): MemoryEntry[] {
  return context.factsDb.getAll({ includeSuperseded, scopeFilter: context.scopeFilter });
}

function isActiveFact(fact: MemoryEntry, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const notSuperseded = (fact.supersededAt == null || fact.supersededAt <= 0) && fact.supersededBy == null;
  const notExpired = fact.expiresAt == null || fact.expiresAt <= 0 || fact.expiresAt > nowSec;
  return notSuperseded && notExpired;
}

function scoreFact(fact: MemoryEntry, query: string): number {
  const q = query.toLowerCase();
  const haystack = [fact.text, fact.entity, fact.key, fact.value, fact.category, ...(fact.tags ?? [])]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (!q) return 0;
  if (haystack.includes(q)) return 1;
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  return terms.filter((term) => haystack.includes(term)).length / terms.length;
}

function searchFacts(
  context: GraphQLContext,
  input: Record<string, unknown>,
): Array<{
  fact: MemoryEntry;
  score: number;
  matchType: string;
  snippet: string;
}> {
  const query = asString(input.query) ?? "";
  const limit = Math.max(1, Math.min(100, asNumber(input.limit) ?? 20));
  const offset = Math.max(0, asNumber(input.offset) ?? 0);
  const categories = asStringArray(input.categories);
  const tags = asStringArray(input.tags);
  const minImportance = asNumber(input.minImportance);
  const minConfidence = asNumber(input.minConfidence);
  const scope = asString(input.scope);
  const includeSuperseded = input.includeSuperseded === true;
  const includeExpired = input.includeExpired === true;
  const nowSec = Math.floor(Date.now() / 1000);

  let facts = allFacts(context, includeSuperseded);
  if (!includeExpired) facts = facts.filter((fact) => isActiveFact(fact, nowSec));
  if (scope) facts = facts.filter((fact) => fact.scope === scope);
  if (categories?.length) facts = facts.filter((fact) => categories.includes(fact.category));
  if (tags?.length) facts = facts.filter((fact) => tags.some((tag) => fact.tags?.includes(tag)));
  if (minImportance !== undefined) facts = facts.filter((fact) => fact.importance >= minImportance);
  if (minConfidence !== undefined) facts = facts.filter((fact) => fact.confidence >= minConfidence);

  return facts
    .map((fact) => ({ fact, score: scoreFact(fact, query) }))
    .filter((result) => query.length === 0 || result.score > 0)
    .sort((a, b) => b.score - a.score || b.fact.createdAt - a.fact.createdAt)
    .slice(offset, offset + limit)
    .map(({ fact, score }) => ({
      fact,
      score,
      matchType: "fts",
      snippet: fact.text.slice(0, 200),
    }));
}

type GraphQLLink = {
  id: string;
  sourceId: string;
  targetId: string;
  linkType: string;
  weight: number;
  createdAt: number;
};

function normalizeLink(row: Record<string, unknown>): GraphQLLink {
  return {
    id: String(row.id ?? ""),
    sourceId: String(row.source_fact_id ?? row.sourceFactId ?? ""),
    targetId: String(row.target_fact_id ?? row.targetFactId ?? ""),
    linkType: String(row.link_type ?? row.linkType ?? "RELATED_TO"),
    weight: Number(row.strength ?? row.weight ?? 1),
    createdAt: Number(row.created_at ?? row.createdAt ?? 0),
  };
}

function getAllLinks(factsDb: FactsDB): GraphQLLink[] {
  const rows = factsDb
    .getRawDb()
    .prepare(
      "SELECT id, source_fact_id, target_fact_id, link_type, strength, created_at FROM memory_links ORDER BY created_at DESC",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(normalizeLink);
}

/**
 * SECURITY: a link is only visible to a caller if BOTH endpoints are facts they can read.
 * memory_links carries no scope column of its own — it connects two potentially
 * differently-scoped facts — so scoping must be derived from the endpoints, not skipped.
 */
export function isLinkVisible(
  factsDb: FactsDB,
  link: { sourceId: string; targetId: string },
  scopeFilter: ScopeFilter,
): boolean {
  return (
    factsDb.getById(link.sourceId, { scopeFilter }) != null && factsDb.getById(link.targetId, { scopeFilter }) != null
  );
}

function isMemoryLinkType(value: string): value is MemoryLinkType {
  return ["SUPERSEDES", "CAUSED_BY", "PART_OF", "RELATED_TO", "DEPENDS_ON", "CONTRADICTS", "INSTANCE_OF"].includes(
    value,
  );
}

function asDecayClass(value: unknown): DecayClass {
  return typeof value === "string" && (DECAY_CLASSES as readonly string[]).includes(value)
    ? (value as DecayClass)
    : "normal";
}

/**
 * SECURITY: scope/scopeTarget are derived from the caller's own resolved identity
 * (context.scopeFilter), never trusted from client input. Otherwise any caller could set
 * scope="user"/scopeTarget="<victim>" and inject a fact that later surfaces in the victim's
 * own legitimately-scoped reads — worse than a read leak, since it lets one tenant plant
 * data in another tenant's memory.
 */
function createStoreInput(input: Record<string, unknown>, context: GraphQLContext) {
  const { scope, scopeTarget } = scopeFieldsFromFilter(context.scopeFilter);
  return {
    text: asString(input.text) ?? "",
    category: asString(input.category) ?? "other",
    importance: asNumber(input.importance) ?? 0.5,
    confidence: asNumber(input.confidence) ?? 1,
    decayClass: asDecayClass(input.decayClass),
    source: asString(input.source) ?? "graphql",
    tags: asStringArray(input.tags) ?? [],
    entity: asString(input.entity) ?? null,
    key: asString(input.key) ?? null,
    value: asString(input.value) ?? null,
    scope: scope as MemoryEntry["scope"] | undefined,
    scopeTarget: scopeTarget ?? null,
    expiresAt: asNumber(input.expiresAt) ?? null,
  };
}

async function cleanupGraphqlEviction(context: GraphQLContext, evictedFactId: string | null | undefined) {
  if (!context.vectorDb || !evictedFactId) return;
  await cleanupEvictedVector({
    vectorDb: context.vectorDb,
    evictedFactId,
    logger: pluginLogger,
    context: "graphql-mutation",
  });
}

export const resolvers: GraphQLResolvers = {
  Query: {
    fact: (_parent, args, context) => {
      const id = asString(asRecord(args).id);
      return id ? context.factsDb.getById(id, { scopeFilter: context.scopeFilter }) : null;
    },

    facts: (_parent, args, context) => {
      const input = asRecord(args);
      const limit = Math.max(1, Math.min(500, asNumber(input.limit) ?? 100));
      const offset = Math.max(0, asNumber(input.offset) ?? 0);
      const category = asString(input.category);
      const decayClass = asString(input.decayClass);
      const tags = asStringArray(input.tags);
      const scope = asString(input.scope);
      const includeSuperseded = input.includeSuperseded === true;
      const includeExpired = input.includeExpired === true;
      const nowSec = Math.floor(Date.now() / 1000);

      let facts = allFacts(context, includeSuperseded);
      if (category) facts = facts.filter((fact) => fact.category === category);
      if (decayClass) facts = facts.filter((fact) => fact.decayClass === decayClass);
      if (tags?.length) facts = facts.filter((fact) => tags.some((tag) => fact.tags?.includes(tag)));
      if (scope) facts = facts.filter((fact) => fact.scope === scope);
      if (!includeExpired) facts = facts.filter((fact) => isActiveFact(fact, nowSec));
      return facts.sort((a, b) => b.createdAt - a.createdAt).slice(offset, offset + limit);
    },

    search: (_parent, args, context) => searchFacts(context, asRecord(asRecord(args).input)),

    semanticSearch: (_parent, args, context) => {
      const input = asRecord(args);
      return searchFacts(context, { query: input.query, limit: input.limit, scope: input.scope });
    },

    episode: () => null,
    episodes: () => [],
    link: (_parent, args, context) => {
      const id = asString(asRecord(args).id);
      if (!id) return null;
      const link = getAllLinks(context.factsDb).find((link) => link.id === id) ?? null;
      return link && isLinkVisible(context.factsDb, link, context.scopeFilter) ? link : null;
    },
    links: (_parent, args, context) => {
      const input = asRecord(args);
      const sourceId = asString(input.sourceId);
      const targetId = asString(input.targetId);
      const linkType = asString(input.linkType);
      const limit = Math.max(1, Math.min(500, asNumber(input.limit) ?? 100));
      return getAllLinks(context.factsDb)
        .filter(
          (link) =>
            (!sourceId || link.sourceId === sourceId) &&
            (!targetId || link.targetId === targetId) &&
            (!linkType || link.linkType === linkType) &&
            isLinkVisible(context.factsDb, link, context.scopeFilter),
        )
        .slice(0, limit);
    },
    relatedFacts: (_parent, args, context) => {
      const input = asRecord(args);
      const factId = asString(input.factId);
      if (!factId) return [];
      // Same visibility gate as link()/links() (isLinkVisible): without it, a caller could
      // supply another tenant's factId and use the link-graph traversal below as an oracle to
      // confirm the id exists and see its neighbors, even though the root itself is never
      // returned to them.
      if (context.factsDb.getById(factId, { scopeFilter: context.scopeFilter }) == null) return [];
      const maxDepth = Math.max(1, Math.min(5, asNumber(input.maxDepth) ?? 1));
      const linkTypes = asStringArray(input.linkTypes);
      const nowSec = Math.floor(Date.now() / 1000);
      let neighborIds: string[];
      if (linkTypes?.length) {
        // Multi-hop BFS restricted to the requested link types, so maxDepth behaves the same
        // way here as it does in the untyped branch below (previously this only ever looked at
        // factId's direct/1-hop links, silently ignoring maxDepth > 1).
        const linkTypeSet = new Set(linkTypes);
        // SECURITY: scope the BFS at the link layer, not just at the final getById post-filter.
        // Without this, a visible fact A linked to hidden B linked to visible C would add B and C
        // to `visited` at depth >= 2; the later `getById(...scopeFilter)` strips B but C still
        // returns, surfacing a path that has no fully visible links and indirectly confirming
        // that hidden B exists. isLinkVisible requires BOTH endpoints to resolve under the
        // caller's scopeFilter, matching link()/links() above and the relatedFacts root oracle
        // check.
        const relevantLinks = getAllLinks(context.factsDb).filter(
          (link) => linkTypeSet.has(link.linkType) && isLinkVisible(context.factsDb, link, context.scopeFilter),
        );
        const visited = new Set<string>([factId]);
        let frontier = new Set<string>([factId]);
        for (let depth = 0; depth < maxDepth && frontier.size > 0; depth++) {
          const next = new Set<string>();
          for (const link of relevantLinks) {
            if (frontier.has(link.sourceId) && !visited.has(link.targetId)) {
              visited.add(link.targetId);
              next.add(link.targetId);
            }
            if (frontier.has(link.targetId) && !visited.has(link.sourceId)) {
              visited.add(link.sourceId);
              next.add(link.sourceId);
            }
          }
          frontier = next;
        }
        neighborIds = [...visited].filter((id) => id !== factId);
      } else {
        neighborIds = context.factsDb.getConnectedFactIds([factId], maxDepth).filter((id) => id !== factId);
      }
      return neighborIds
        .map((id) => context.factsDb.getById(id, { scopeFilter: context.scopeFilter }))
        .filter((fact): fact is MemoryEntry => fact != null && isActiveFact(fact, nowSec));
    },

    entityFacts: (_parent, args, context) => {
      const input = asRecord(args);
      const entity = asString(input.entity);
      const key = asString(input.key);
      if (!entity) return [];
      const limit = Math.max(1, Math.min(500, asNumber(input.limit) ?? 200));
      const nowSec = Math.floor(Date.now() / 1000);
      return allFacts(context)
        .filter((fact) => fact.entity === entity && (!key || fact.key === key) && isActiveFact(fact, nowSec))
        .slice(0, limit);
    },

    graph: (_parent, args, context) => {
      const filter = asRecord(asRecord(args).filter);
      const categories = asStringArray(filter.categories);
      const decayClasses = asStringArray(filter.decayClasses);
      const minImportance = asNumber(filter.minImportance);
      const scope = asString(filter.scope);
      // Clamped to [20, 2000], default 400 — matches the REST /api/graph route's maxNodes bound,
      // preventing a single request from forcing an unbounded node/edge payload and O(n^2)-ish
      // edge-filtering work.
      const maxNodes = Math.min(2000, Math.max(20, asNumber(filter.maxNodes) ?? 400));
      const matchesFilters = (fact: MemoryEntry): boolean =>
        (!categories?.length || categories.includes(fact.category)) &&
        (!decayClasses?.length || decayClasses.includes(fact.decayClass)) &&
        (minImportance === undefined || fact.importance >= minImportance) &&
        (!scope || fact.scope === scope);
      // includeSuperseded=true so supersede lineage (below) can find predecessor facts; the
      // active/non-expired node set itself is still derived via isActiveFact immediately after.
      const allMatching = allFacts(context, true).filter(matchesFilters);
      const facts = allMatching.filter((fact) => isActiveFact(fact)).slice(0, maxNodes);
      const factIds = new Set(facts.map((fact) => fact.id));
      const linkEdges = getAllLinks(context.factsDb)
        .filter((link) => factIds.has(link.sourceId) && factIds.has(link.targetId))
        .map((link) => ({
          source: link.sourceId,
          target: link.targetId,
          linkType: link.linkType,
          weight: link.weight,
        }));
      // Superseded predecessor facts whose replacement is already a rendered node. A superseded
      // fact can never itself be in `facts` (isActiveFact requires supersededBy == null), so
      // computing this from `facts` alone (as before) always yielded []; include these
      // predecessors as extra nodes so the superseded_by edge has a real source to point from.
      const supersedeSourceFacts = allMatching.filter(
        (fact) => fact.supersededBy && factIds.has(fact.supersededBy) && !factIds.has(fact.id),
      );
      const supersedeEdges = supersedeSourceFacts.map((fact) => ({
        source: fact.id,
        target: fact.supersededBy as string,
        linkType: "superseded_by",
        weight: 1,
      }));
      const nodeFacts = supersedeSourceFacts.length > 0 ? [...facts, ...supersedeSourceFacts] : facts;
      return {
        nodes: nodeFacts.map((fact) => ({
          id: fact.id,
          label: fact.text.slice(0, 50) + (fact.text.length > 50 ? "..." : ""),
          category: fact.category,
          importance: fact.importance,
          confidence: fact.confidence,
          decayClass: fact.decayClass,
          factCount: 1,
        })),
        edges: [...linkEdges, ...supersedeEdges],
      };
    },

    stats: (_parent, _args, context) => {
      const facts = allFacts(context, true);
      const nowSec = Math.floor(Date.now() / 1000);
      const active = facts.filter((fact) => isActiveFact(fact, nowSec));
      const expired = facts.filter((fact) => fact.expiresAt != null && fact.expiresAt > 0 && fact.expiresAt <= nowSec);
      const superseded = facts.filter(
        (fact) => (fact.supersededAt != null && fact.supersededAt > 0) || fact.supersededBy != null,
      );
      const byCategory = new Map<string, number>();
      const byDecay = new Map<string, number>();
      for (const fact of active) {
        byCategory.set(fact.category, (byCategory.get(fact.category) ?? 0) + 1);
        byDecay.set(fact.decayClass, (byDecay.get(fact.decayClass) ?? 0) + 1);
      }
      // Iterate rather than `Math.min(...facts.map(...))`: spreading facts.length (unbounded --
      // allFacts(context, true) has no LIMIT) into a function call throws
      // "RangeError: Maximum call stack size exceeded" once the store holds more than V8's
      // argument-count limit (~65k-125k facts).
      let oldestFactDate: number | null = null;
      let newestFactDate: number | null = null;
      for (const fact of facts) {
        if (oldestFactDate === null || fact.createdAt < oldestFactDate) oldestFactDate = fact.createdAt;
        if (newestFactDate === null || fact.createdAt > newestFactDate) newestFactDate = fact.createdAt;
      }
      return {
        totalFacts: facts.length,
        activeFactsCount: active.length,
        expiredFactsCount: expired.length,
        supersededFactsCount: superseded.length,
        factsByCategory: [...byCategory].map(([category, count]) => ({ category, count })),
        factsByDecayClass: [...byDecay].map(([decayClass, count]) => ({ decayClass, count })),
        totalEpisodes: 0,
        totalLinks: getAllLinks(context.factsDb).filter((link) =>
          isLinkVisible(context.factsDb, link, context.scopeFilter),
        ).length,
        databaseSizeBytes:
          typeof context.factsDb.estimateStorageBytes === "function"
            ? context.factsDb.estimateStorageBytes().sqliteBytes
            : 0,
        oldestFactDate,
        newestFactDate,
      };
    },
  },

  Mutation: {
    createFact: async (_parent, args, context) => {
      const input = asRecord(asRecord(args).input);
      const result = context.factsDb.storeWithResult(createStoreInput(input, context));
      if (result.entry.id === "") {
        throw new Error("Fact rejected: artifact or reasoning trace text cannot be stored");
      }
      await cleanupGraphqlEviction(context, result.evictedFactId);
      if (result.newlyStored) {
        await indexGraphqlFactVector(context, result.entry);
        notifyGraphqlFactCreated(result.entry, result.entry.category, result.entry.scope);
      }
      return result.entry;
    },

    updateFact: async (_parent, args, context) => {
      const input = asRecord(asRecord(args).input);
      const id = asString(input.id);
      if (!id) throw new Error("Missing fact id");
      const existing = context.factsDb.getById(id, { scopeFilter: context.scopeFilter });
      if (!existing) throw new Error(`Fact not found: ${id}`);
      const updatedText = asString(input.text) ?? existing.text;
      if (isPromptArtifactOrReasoningTrace(updatedText)) {
        throw new Error("Fact rejected: artifact or reasoning trace text cannot be stored");
      }
      const result = context.factsDb.storeWithResult(
        {
          text: updatedText,
          category: asString(input.category) ?? existing.category,
          importance: asNumber(input.importance) ?? existing.importance,
          confidence: asNumber(input.confidence) ?? existing.confidence,
          decayClass: existing.decayClass,
          source: existing.source,
          tags: asStringArray(input.tags) ?? existing.tags ?? [],
          entity: existing.entity,
          key: existing.key,
          value: existing.value,
          scope: existing.scope,
          scopeTarget: existing.scopeTarget ?? null,
          expiresAt: asNumber(input.expiresAt) ?? existing.expiresAt ?? null,
        },
        { allowPreStoreGuardBypass: true },
      );
      // Skip supersede if store was rejected (artifact text) or deduped to an existing row
      if (result.entry.id !== "" && result.newlyStored) {
        context.factsDb.supersede(existing.id, result.entry.id);
        if (context.vectorDb) {
          await deleteVectorForFactId({
            vectorDb: context.vectorDb,
            factId: existing.id,
            logger: pluginLogger,
            context: "graphql-update-supersede",
          });
        }
        await indexGraphqlFactVector(context, result.entry);
        notifyGraphqlFactUpdated(result.entry);
      }
      await cleanupGraphqlEviction(context, result.evictedFactId);
      return result.entry;
    },

    deleteFact: async (_parent, args, context) => {
      const id = asString(asRecord(args).id);
      if (!id) return false;
      // SECURITY: scope-check before deleting — an unscoped delete() would let any caller
      // remove a fact belonging to another tenant just by knowing/guessing its id.
      const existing = context.factsDb.getById(id, { scopeFilter: context.scopeFilter });
      if (!existing) return false;
      const deleted = context.factsDb.delete(id);
      if (deleted && context.vectorDb) {
        await deleteVectorForFactId({
          vectorDb: context.vectorDb,
          factId: id,
          logger: pluginLogger,
          context: "graphql-delete-fact",
        });
      }
      if (deleted) {
        notifyGraphqlFactDeleted(id, existing?.category, existing?.scope, existing?.scopeTarget);
      }
      return deleted;
    },

    supersedeFact: async (_parent, args, context) => {
      const input = asRecord(args);
      const oldFactId = asString(input.oldFactId);
      const newFactId = asString(input.newFactId);
      if (!oldFactId || !newFactId) throw new Error("Missing fact id");
      const oldFact = context.factsDb.getById(oldFactId, { scopeFilter: context.scopeFilter });
      if (!oldFact) throw new Error(`Fact not found: ${oldFactId}`);
      const newFact = context.factsDb.getById(newFactId, { scopeFilter: context.scopeFilter });
      if (!newFact) throw new Error(`Fact not found: ${newFactId}`);
      const applied = context.factsDb.supersede(oldFactId, newFactId);
      if (!applied) throw new Error(`Fact supersede did not apply: ${oldFactId}`);
      if (context.vectorDb) {
        await deleteVectorForFactId({
          vectorDb: context.vectorDb,
          factId: oldFactId,
          logger: pluginLogger,
          context: "graphql-supersede",
        });
      }
      notifyGraphqlFactUpdated(newFact);
      return newFact;
    },

    createLink: (_parent, args, context) => {
      const input = asRecord(args);
      const sourceId = asString(input.sourceId);
      const targetId = asString(input.targetId);
      const linkType = asString(input.linkType) ?? "RELATED_TO";
      const weight = asNumber(input.weight) ?? 1;
      if (!sourceId || !targetId) throw new Error("Missing link endpoint");
      if (!isMemoryLinkType(linkType)) throw new Error(`Unsupported link type: ${linkType}`);
      // SECURITY: both endpoints must be in-scope before linking — otherwise a caller could
      // tie an out-of-scope (another tenant's) fact into their own graph, or discover its id
      // exists, just by guessing/enumerating ids.
      if (!isLinkVisible(context.factsDb, { sourceId, targetId }, context.scopeFilter)) {
        throw new Error(`Fact not found: ${sourceId}`);
      }
      const id = context.factsDb.createLink(sourceId, targetId, linkType, weight);
      const link = getAllLinks(context.factsDb).find((entry) => entry.id === id);
      if (link) notifyGraphqlLinkCreated(link);
      return link;
    },
    deleteLink: (_parent, args, context) => {
      const id = asString(asRecord(args).id);
      if (!id) return false;
      // SECURITY: scope-check before deleting — mirrors deleteFact's guard so a caller can't
      // remove a link between two other tenants' facts just by knowing/guessing its id.
      const existing = getAllLinks(context.factsDb).find((link) => link.id === id);
      if (!existing || !isLinkVisible(context.factsDb, existing, context.scopeFilter)) return false;
      const result = context.factsDb.getRawDb().prepare("DELETE FROM memory_links WHERE id = ?").run(id);
      return result.changes > 0;
    },

    importFacts: async (_parent, args, context) => {
      const facts = Array.isArray(asRecord(args).facts) ? (asRecord(args).facts as unknown[]) : [];
      const inputs = facts.map((raw) => createStoreInput(asRecord(raw), context));
      // Pre-validate all facts before storing any
      for (const input of inputs) {
        if (isPreStoreGuardBlocked(input)) {
          throw new Error(
            `Fact blocked by pre-store guard: category=${input.category ?? ""}, source=${input.source ?? ""}`,
          );
        }
      }
      const stored: MemoryEntry[] = [];
      for (const input of inputs) {
        const result = context.factsDb.storeWithResult(input);
        if (result.entry.id !== "" && result.newlyStored) {
          stored.push(result.entry);
          await indexGraphqlFactVector(context, result.entry);
          notifyGraphqlFactCreated(result.entry, result.entry.category, result.entry.scope);
        }
        await cleanupGraphqlEviction(context, result.evictedFactId);
      }
      return stored;
    },

    pruneFacts: async (_parent, args, context) => {
      const input = asRecord(args);
      if (input.olderThan == null) {
        throw new Error("pruneFacts requires olderThan (unix seconds or ISO DateTime)");
      }
      const olderThan = parsePruneOlderThan(input.olderThan);
      const category = asString(input.category);
      const toDelete = allFacts(context).filter(
        (fact) => fact.createdAt < olderThan && (!category || fact.category === category),
      );
      let deleted = 0;
      for (const fact of toDelete) {
        if (context.factsDb.delete(fact.id)) {
          deleted++;
          notifyGraphqlFactDeleted(fact.id, fact.category, fact.scope, fact.scopeTarget);
          if (context.vectorDb) {
            await deleteVectorForFactId({
              vectorDb: context.vectorDb,
              factId: fact.id,
              logger: pluginLogger,
              context: "graphql-prune-facts",
            });
          }
        }
      }
      return deleted;
    },

    consolidateFacts: () => {
      throw new Error("consolidateFacts is not implemented; use maintenance CLI consolidate instead");
    },
    recomputeEmbeddings: () => {
      throw new Error("recomputeEmbeddings is not implemented; use the reindex CLI command instead");
    },
  },

  Fact: {
    links: (parent, _args, context) => {
      const fact = asRecord(parent) as Partial<MemoryEntry>;
      return fact.id
        ? getAllLinks(context.factsDb).filter(
            (link) => link.sourceId === fact.id && isLinkVisible(context.factsDb, link, context.scopeFilter),
          )
        : [];
    },
    linkedFrom: (parent, _args, context) => {
      const fact = asRecord(parent) as Partial<MemoryEntry>;
      return fact.id
        ? getAllLinks(context.factsDb).filter(
            (link) => link.targetId === fact.id && isLinkVisible(context.factsDb, link, context.scopeFilter),
          )
        : [];
    },
    supersedes: (parent, _args, context) => {
      const fact = asRecord(parent) as Partial<MemoryEntry>;
      return fact.supersedesId
        ? context.factsDb.getById(fact.supersedesId, { scopeFilter: context.scopeFilter })
        : null;
    },
    supersededByFact: (parent, _args, context) => {
      const fact = asRecord(parent) as Partial<MemoryEntry>;
      return fact.supersededBy
        ? context.factsDb.getById(fact.supersededBy, { scopeFilter: context.scopeFilter })
        : null;
    },
  },

  Link: {
    source: (parent, _args, context) => {
      const sourceId = asString(asRecord(parent).sourceId);
      return sourceId ? context.factsDb.getById(sourceId, { scopeFilter: context.scopeFilter }) : null;
    },
    target: (parent, _args, context) => {
      const targetId = asString(asRecord(parent).targetId);
      return targetId ? context.factsDb.getById(targetId, { scopeFilter: context.scopeFilter }) : null;
    },
  },

  Episode: {
    facts: () => [],
  },
};
