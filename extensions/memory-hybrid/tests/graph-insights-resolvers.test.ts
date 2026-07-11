import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";
import { resolvers } from "../routes/graphql-resolvers.js";
import { computeNodeStrength } from "../services/graph-node-metrics.js";

type Ctx = Parameters<typeof resolvers.Query.graph>[2];

let tmpDir: string;
let db: FactsDB;
let ctx: Ctx;

const store = (text: string, extra: Record<string, unknown> = {}) =>
  db.store({
    text,
    category: "fact",
    source: "conversation",
    entity: null,
    key: null,
    value: null,
    importance: 0.5,
    ...extra,
  });

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "graph-insights-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
  // Empty scope filter → global-only visibility (fail-closed); test facts default to global scope.
  ctx = { factsDb: db, pluginContext: {}, scopeFilter: {} } as unknown as Ctx;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Query.graph enriched nodes", () => {
  it("includes constellation metrics (strength, degree, pinned, superseded)", async () => {
    const a = store("central important fact", { importance: 0.9 });
    const b = store("peripheral fact", { importance: 0.2 });
    db.createLink(a.id, b.id, "RELATED_TO", 0.6);
    db.pinFact(a.id, "keystone");

    const result = (await resolvers.Query.graph(null, { filter: {} }, ctx)) as {
      nodes: Array<Record<string, unknown>>;
    };
    const nodeA = result.nodes.find((n) => n.id === a.id);
    const nodeB = result.nodes.find((n) => n.id === b.id);
    expect(nodeA).toBeTruthy();
    expect(typeof nodeA?.strength).toBe("number");
    // Strength matches the shared helper (single source of truth for the radial layout).
    const reloaded = db.getById(a.id);
    expect(nodeA?.strength).toBeCloseTo(computeNodeStrength(reloaded!, Math.floor(Date.now() / 1000)), 4);
    expect(nodeA?.pinned).toBe(true);
    expect(nodeA?.degree).toBe(1);
    expect(nodeB?.degree).toBe(1);
    // Stronger fact should outrank the weaker one for the center of the constellation.
    expect(Number(nodeA?.strength)).toBeGreaterThan(Number(nodeB?.strength));
  });
});

describe("gap/insight queries", () => {
  it("orphanFacts returns unlinked, never-recalled facts", async () => {
    const orphan = store("lonely fact");
    const a = store("linked a");
    const b = store("linked b");
    db.createLink(a.id, b.id, "RELATED_TO", 0.5);

    const orphans = (await resolvers.Query.orphanFacts(null, { limit: 10 }, ctx)) as Array<{ id: string }>;
    const ids = orphans.map((f) => f.id);
    expect(ids).toContain(orphan.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("weakLinks returns links at/below the strength threshold", async () => {
    const a = store("a");
    const b = store("b");
    const c = store("c");
    db.createLink(a.id, b.id, "RELATED_TO", 0.1); // weak
    db.createLink(a.id, c.id, "RELATED_TO", 0.9); // strong

    const weak = (await resolvers.Query.weakLinks(null, { maxStrength: 0.3, limit: 10 }, ctx)) as Array<{
      weight: number;
    }>;
    expect(weak).toHaveLength(1);
    expect(weak[0].weight).toBeCloseTo(0.1);
  });

  it("suggestedLinks returns [] when embeddings/vector store are unavailable", async () => {
    const suggestions = await resolvers.Query.suggestedLinks(null, { limit: 5 }, ctx);
    expect(suggestions).toEqual([]);
  });

  it("memoryGraphInsights bundles the cheap gap views", async () => {
    store("orphan one");
    const bundle = (await resolvers.Query.memoryGraphInsights(null, { limit: 5 }, ctx)) as {
      orphanFacts: unknown[];
      weakLinks: unknown[];
      contradictions: unknown[];
      staleImportantFacts: unknown[];
    };
    expect(Array.isArray(bundle.orphanFacts)).toBe(true);
    expect(bundle.orphanFacts.length).toBeGreaterThan(0);
    expect(Array.isArray(bundle.weakLinks)).toBe(true);
  });
});

describe("curation mutations", () => {
  it("pinFact / unpinFact toggle the pinned flag", async () => {
    const f = store("pin me");
    await resolvers.Mutation.pinFact(null, { id: f.id, reason: "keystone" }, ctx);
    expect(db.getById(f.id)?.pinnedAt).toBeTruthy();
    await resolvers.Mutation.unpinFact(null, { id: f.id }, ctx);
    expect(db.getById(f.id)?.pinnedAt ?? null).toBeNull();
  });

  it("updateLink changes strength and type", async () => {
    const a = store("a");
    const b = store("b");
    const id = db.createLink(a.id, b.id, "RELATED_TO", 0.5);
    const updated = (await resolvers.Mutation.updateLink(null, { id, linkType: "CAUSED_BY", weight: 0.95 }, ctx)) as {
      linkType: string;
      weight: number;
    };
    expect(updated.linkType).toBe("CAUSED_BY");
    expect(updated.weight).toBeCloseTo(0.95);
  });

  it("acceptSuggestedLink creates a RELATED_TO link between two facts", async () => {
    const a = store("a");
    const b = store("b");
    const link = (await resolvers.Mutation.acceptSuggestedLink(null, { sourceId: a.id, targetId: b.id }, ctx)) as {
      sourceId: string;
      targetId: string;
      linkType: string;
    };
    expect(link.sourceId).toBe(a.id);
    expect(link.targetId).toBe(b.id);
    expect(link.linkType).toBe("RELATED_TO");
  });
});
