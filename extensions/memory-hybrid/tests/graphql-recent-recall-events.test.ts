/**
 * recentRecallEvents history query: must apply the SAME two gates as the live recallOccurred
 * subscription — ownership of the recall metadata (query text / session / agent), then per-hit
 * scope trimming — and round-trip the persisted per-fact scores.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolvers } from "../routes/graphql-resolvers.js";
import { insertRecallEvent } from "../services/recall-events.js";
import type { ScopeFilter } from "../types/memory.js";

type ResolverContext = Parameters<typeof resolvers.Query.recentRecallEvents>[2];
type RecallEventResult = {
  query: string | null;
  sessionKey: string | null;
  agentId: string | null;
  occurredAt: number;
  hits: Array<{ factId: string; score: number }>;
};

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE recall_events (
      id TEXT PRIMARY KEY,
      occurred_at INTEGER NOT NULL,
      session_key TEXT,
      agent_id TEXT,
      query TEXT,
      fact_ids TEXT NOT NULL DEFAULT '[]',
      hit INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'backfill',
      scores TEXT
    )
  `);
  return db;
}

/** Context whose fact table (for scope-trimming hits) is exactly `visibleFactIds`. */
function makeContext(db: DatabaseSync, visibleFactIds: string[], scopeFilter: ScopeFilter): ResolverContext {
  return {
    factsDb: {
      getRawDb: () => db,
      getAll: () => visibleFactIds.map((id) => ({ id })),
    },
    pluginContext: {},
    scopeFilter,
  } as unknown as ResolverContext;
}

describe("GraphQL Query.recentRecallEvents", () => {
  let db: DatabaseSync;
  afterEach(() => db?.close());

  it("returns newest-first events with persisted per-fact scores (default 1 when unscored)", () => {
    db = makeDb();
    insertRecallEvent(db, {
      occurredAtSec: 100,
      sessionKey: "sess-A",
      query: "older",
      factIds: ["f1"],
      hit: true,
      source: "tool",
    });
    insertRecallEvent(db, {
      occurredAtSec: 200,
      sessionKey: "sess-A",
      query: "newer",
      factIds: ["f1", "f2"],
      hit: true,
      source: "auto-recall",
      scores: { f1: 0.9, f2: 0.4 },
    });
    const context = makeContext(db, ["f1", "f2"], {});

    const result = resolvers.Query.recentRecallEvents(null, { limit: 10 }, context) as RecallEventResult[];

    expect(result.map((e) => e.query)).toEqual(["newer", "older"]);
    expect(result[0]?.hits).toEqual([
      { factId: "f1", score: 0.9 },
      { factId: "f2", score: 0.4 },
    ]);
    expect(result[1]?.hits).toEqual([{ factId: "f1", score: 1 }]);
  });

  it("hides other tenants' recalls from an identity-scoped caller (ownership gate)", () => {
    db = makeDb();
    insertRecallEvent(db, {
      occurredAtSec: 100,
      sessionKey: "sess-A",
      agentId: "agent-A",
      query: "tenant A secret query",
      factIds: ["f1"],
      hit: true,
      source: "tool",
    });
    insertRecallEvent(db, {
      occurredAtSec: 200,
      sessionKey: "sess-B",
      agentId: "agent-B",
      query: "tenant B query",
      factIds: ["f1"],
      hit: true,
      source: "tool",
    });

    const tenantB = resolvers.Query.recentRecallEvents(
      null,
      {},
      makeContext(db, ["f1"], { agentId: "agent-B" }),
    ) as RecallEventResult[];
    expect(tenantB.map((e) => e.query)).toEqual(["tenant B query"]);

    // The header-less local operator (empty scope filter) owns all activity on the box.
    const operator = resolvers.Query.recentRecallEvents(null, {}, makeContext(db, ["f1"], {})) as RecallEventResult[];
    expect(operator).toHaveLength(2);
  });

  it("trims hits to facts in the caller's scope while keeping the owned event", () => {
    db = makeDb();
    insertRecallEvent(db, {
      occurredAtSec: 100,
      sessionKey: "sess-A",
      query: "mixed-scope recall",
      factIds: ["visible-1", "hidden-1"],
      hit: true,
      source: "tool",
    });
    const context = makeContext(db, ["visible-1"], { sessionId: "sess-A" });

    const result = resolvers.Query.recentRecallEvents(null, {}, context) as RecallEventResult[];

    expect(result).toHaveLength(1);
    expect(result[0]?.hits).toEqual([{ factId: "visible-1", score: 1 }]);
  });

  it("clamps limit and never returns more than requested", () => {
    db = makeDb();
    for (let i = 0; i < 5; i++) {
      insertRecallEvent(db, {
        occurredAtSec: 100 + i,
        sessionKey: "s",
        query: `q${i}`,
        factIds: [],
        hit: false,
        source: "tool",
      });
    }
    const context = makeContext(db, [], {});
    const result = resolvers.Query.recentRecallEvents(null, { limit: 2 }, context) as RecallEventResult[];
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.query)).toEqual(["q4", "q3"]);
  });
});
