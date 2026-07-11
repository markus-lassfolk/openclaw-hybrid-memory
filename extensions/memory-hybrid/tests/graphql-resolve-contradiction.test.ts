/**
 * resolveContradiction mutation: keep-one supersedes the loser and marks the row "superseded";
 * keep-both marks it "kept"; scope is fail-closed (out-of-scope pair reads as "not found" so the
 * id space can't be probed); invalid keepFactId and double-resolution are rejected.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvers } from "../routes/graphql-resolvers.js";
import type { ScopeFilter } from "../types/memory.js";

type ResolverContext = Parameters<typeof resolvers.Mutation.resolveContradiction>[2];

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE contradictions (
      id TEXT PRIMARY KEY,
      fact_id_new TEXT NOT NULL,
      fact_id_old TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolution TEXT,
      resolved_at TEXT,
      old_fact_original_confidence REAL
    )
  `);
  db.prepare(
    "INSERT INTO contradictions (id, fact_id_new, fact_id_old, detected_at) VALUES ('c1', 'fact-new', 'fact-old', '2026-01-01T00:00:00Z')",
  ).run();
  return db;
}

function makeContext(db: DatabaseSync, visibleFactIds: string[], supersede = vi.fn(() => true)) {
  const context = {
    factsDb: {
      getRawDb: () => db,
      getById: (id: string, _opts: { scopeFilter: ScopeFilter }) =>
        visibleFactIds.includes(id) ? { id, text: `text of ${id}` } : null,
      supersede,
    },
    pluginContext: {},
    scopeFilter: {},
  } as unknown as ResolverContext;
  return { context, supersede };
}

function resolvedRow(db: DatabaseSync) {
  return db.prepare("SELECT resolved, resolution, resolved_at FROM contradictions WHERE id = 'c1'").get() as {
    resolved: number;
    resolution: string | null;
    resolved_at: string | null;
  };
}

describe("GraphQL Mutation.resolveContradiction", () => {
  let db: DatabaseSync;
  afterEach(() => db?.close());

  it("supersedes the loser and marks the pair 'superseded' when keepFactId is given", async () => {
    db = makeDb();
    const { context, supersede } = makeContext(db, ["fact-new", "fact-old"]);

    const result = (await resolvers.Mutation.resolveContradiction(
      null,
      { id: "c1", keepFactId: "fact-new" },
      context,
    )) as { id: string; resolution: string };

    expect(supersede).toHaveBeenCalledWith("fact-old", "fact-new");
    expect(result.resolution).toBe("superseded");
    const row = resolvedRow(db);
    expect(row.resolved).toBe(1);
    expect(row.resolution).toBe("superseded");
    expect(row.resolved_at).toBeTruthy();
  });

  it("marks the pair 'kept' without superseding when keepFactId is omitted", async () => {
    db = makeDb();
    const { context, supersede } = makeContext(db, ["fact-new", "fact-old"]);

    const result = (await resolvers.Mutation.resolveContradiction(null, { id: "c1" }, context)) as {
      resolution: string;
    };

    expect(supersede).not.toHaveBeenCalled();
    expect(result.resolution).toBe("kept");
    expect(resolvedRow(db).resolution).toBe("kept");
  });

  it("fails closed as 'not found' when either fact is out of the caller's scope", async () => {
    db = makeDb();
    const { context } = makeContext(db, ["fact-new"]); // fact-old hidden

    await expect(
      resolvers.Mutation.resolveContradiction(null, { id: "c1", keepFactId: "fact-new" }, context),
    ).rejects.toThrow(/not found/i);
    expect(resolvedRow(db).resolved).toBe(0);
  });

  it("rejects a keepFactId that is not part of the pair", async () => {
    db = makeDb();
    const { context, supersede } = makeContext(db, ["fact-new", "fact-old", "unrelated"]);

    await expect(
      resolvers.Mutation.resolveContradiction(null, { id: "c1", keepFactId: "unrelated" }, context),
    ).rejects.toThrow(/must be one of the contradicting facts/);
    expect(supersede).not.toHaveBeenCalled();
    expect(resolvedRow(db).resolved).toBe(0);
  });

  it("rejects resolving an already-resolved contradiction", async () => {
    db = makeDb();
    db.prepare("UPDATE contradictions SET resolved = 1, resolution = 'kept' WHERE id = 'c1'").run();
    const { context } = makeContext(db, ["fact-new", "fact-old"]);

    await expect(resolvers.Mutation.resolveContradiction(null, { id: "c1" }, context)).rejects.toThrow(
      /already resolved/,
    );
  });
});
