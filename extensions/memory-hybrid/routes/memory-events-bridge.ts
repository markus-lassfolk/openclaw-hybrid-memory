/**
 * Bridge: in-process memory events → GraphQL pubsub (live Memory Graph overlay).
 *
 * The backend write paths (`FactsDB.store/delete/supersede`, link create/strengthen, recall) emit
 * scope-agnostic `memory-events`. This module is the single place that republishes them onto the
 * GraphQL `graphqlPubSub` so subscribers over SSE receive them. Per-subscriber scope filtering
 * happens in the subscription resolvers (see graphql-server.ts) — this bridge stays scope-agnostic.
 *
 * Wiring is process-global and idempotent (both the event bus and the pubsub are singletons):
 * listeners are registered once; the FactsDB used for the (debounced) stats snapshot is refreshed
 * on each call so tests spinning up fresh servers compute stats against their own store.
 */
import type { DatabaseSync } from "node:sqlite";
import type { FactsDB } from "../backends/facts-db.js";
import { type MemoryLinkEventPayload, onMemoryEvent } from "../services/memory-events.js";
import {
  notifyGraphqlFactCreated,
  notifyGraphqlFactDeleted,
  notifyGraphqlFactUpdated,
  notifyGraphqlLinkCreated,
  notifyGraphqlLinkUpdated,
  notifyGraphqlRecallOccurred,
  notifyGraphqlStatsUpdated,
} from "./graphql-pubsub.js";

const STATS_DEBOUNCE_MS = 2000;

let wired = false;
let statsFactsDb: FactsDB | null = null;
let statsTimer: ReturnType<typeof setTimeout> | null = null;
const registeredListeners: Array<() => void> = [];

/**
 * Lightweight, global (scope-less) stats snapshot for the `statsUpdated` subscription. Uses cheap
 * indexed aggregate queries rather than materializing every fact, so it is safe to run on a timer.
 * Shape matches the GraphQL `MemoryStats` type.
 */
export function collectLiveStatsSnapshot(factsDb: FactsDB): Record<string, unknown> {
  const db: DatabaseSync = factsDb.getRawDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const scalar = (sql: string, ...params: Array<string | number>): number => {
    try {
      const row = db.prepare(sql).get(...params) as { v?: number } | undefined;
      return Number(row?.v ?? 0);
    } catch {
      return 0;
    }
  };
  const groupCount = (sql: string, keyCol: string, labelKey: string): Array<Record<string, unknown>> => {
    try {
      const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
      return rows.map((r) => ({ [labelKey]: String(r[keyCol] ?? "other"), count: Number(r.count ?? 0) }));
    } catch {
      return [];
    }
  };

  const totalFacts = scalar("SELECT COUNT(*) AS v FROM facts");
  const supersededFactsCount = scalar("SELECT COUNT(*) AS v FROM facts WHERE superseded_at IS NOT NULL");
  const expiredFactsCount = scalar(
    "SELECT COUNT(*) AS v FROM facts WHERE expires_at IS NOT NULL AND expires_at <= ?",
    nowSec,
  );
  const activeFactsCount = scalar(
    "SELECT COUNT(*) AS v FROM facts WHERE superseded_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
    nowSec,
  );
  const totalLinks = scalar("SELECT COUNT(*) AS v FROM memory_links");
  const oldestFactDate = scalar("SELECT MIN(created_at) AS v FROM facts") || null;
  const newestFactDate = scalar("SELECT MAX(created_at) AS v FROM facts") || null;
  const databaseSizeBytes =
    typeof factsDb.estimateStorageBytes === "function" ? factsDb.estimateStorageBytes().sqliteBytes : 0;

  return {
    totalFacts,
    activeFactsCount,
    expiredFactsCount,
    supersededFactsCount,
    factsByCategory: groupCount(
      "SELECT category, COUNT(*) AS count FROM facts GROUP BY category ORDER BY count DESC",
      "category",
      "category",
    ),
    factsByDecayClass: groupCount(
      "SELECT decay_class, COUNT(*) AS count FROM facts GROUP BY decay_class ORDER BY count DESC",
      "decay_class",
      "decayClass",
    ),
    totalEpisodes: 0,
    totalLinks,
    databaseSizeBytes,
    oldestFactDate,
    newestFactDate,
  };
}

/**
 * Wire the memory-event bus to the GraphQL pubsub. Safe to call multiple times — listeners are
 * registered once; only the stats FactsDB reference is refreshed on subsequent calls.
 */
export function wireMemoryEventsToPubSub(factsDb: FactsDB): void {
  statsFactsDb = factsDb;
  if (wired) return;
  wired = true;

  const scheduleStats = (): void => {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      const dbRef = statsFactsDb;
      if (!dbRef) return;
      try {
        notifyGraphqlStatsUpdated(collectLiveStatsSnapshot(dbRef));
      } catch {
        // stats snapshot is best-effort
      }
    }, STATS_DEBOUNCE_MS);
    if (typeof statsTimer.unref === "function") statsTimer.unref();
  };

  registeredListeners.push(
    onMemoryEvent("factStored", ({ entry }) => {
      notifyGraphqlFactCreated(entry, entry.category, entry.scope);
      scheduleStats();
    }),
    onMemoryEvent("factUpdated", ({ entry }) => {
      notifyGraphqlFactUpdated(entry);
      scheduleStats();
    }),
    onMemoryEvent("factDeleted", (e) => {
      notifyGraphqlFactDeleted(e.id, e.category, e.scope, e.scopeTarget);
      scheduleStats();
    }),
    // Link events are self-contained (carry createdAt), so republish directly from the payload — no
    // DB re-query. A lookup here would use the process-global statsFactsDb, which in a multi-vault
    // process is whichever FactsDB wired last, not the vault the write came from.
    onMemoryEvent("linkCreated", ({ link }) => {
      notifyGraphqlLinkCreated(eventLinkToGraphql(link));
      scheduleStats();
    }),
    onMemoryEvent("linkUpdated", ({ link }) => {
      notifyGraphqlLinkUpdated(eventLinkToGraphql(link));
    }),
    onMemoryEvent("recallOccurred", (payload) => {
      // Scope filtering of hits happens per-subscriber in the subscription resolver.
      notifyGraphqlRecallOccurred(payload);
    }),
  );
}

/** Map a self-contained link event payload onto the GraphQL `Link` shape (strength→weight). */
function eventLinkToGraphql(link: MemoryLinkEventPayload): Record<string, unknown> {
  return {
    id: link.id,
    sourceId: link.sourceId,
    targetId: link.targetId,
    linkType: link.linkType,
    weight: link.strength,
    createdAt: link.createdAt,
  };
}

/** Test hygiene: fully reset the module-global wiring state, including removing bus listeners. */
export function resetMemoryEventsBridgeForTests(): void {
  for (const off of registeredListeners.splice(0)) {
    try {
      off();
    } catch {
      // ignore
    }
  }
  wired = false;
  statsFactsDb = null;
  if (statsTimer) {
    clearTimeout(statsTimer);
    statsTimer = null;
  }
}
