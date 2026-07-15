/**
 * Tests for Issue #2126 — /api/graph returned nodes but zero edges even when explicit links
 * existed, because the default "recent N facts" node sample rarely overlaps with itself on an
 * append-heavy corpus. Also covers #2128's edge `layer` metadata and coverage counters.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { collectGraphPayload } from "../routes/dashboard-graph.js";

const { FactsDB } = _testing;

function makeDb(tmpDir: string): InstanceType<typeof FactsDB> {
  return new FactsDB(join(tmpDir, "facts.db"));
}

function storeFact(
  db: InstanceType<typeof FactsDB>,
  overrides: { text?: string; category?: string; createdAt?: number; expiresAt?: number | null } = {},
): string {
  const raw = db.getRawDb();
  const id = `test-${Math.random().toString(36).slice(2)}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const { text = "test fact", category = "fact", createdAt = nowSec, expiresAt = null } = overrides;
  raw
    .prepare(
      `INSERT INTO facts (id, text, category, importance, source, created_at, decay_class, confidence, tier, valid_until, expires_at, superseded_at)
     VALUES (?, ?, ?, 0.7, 'conversation', ?, 'stable', 1.0, 'warm', NULL, ?, NULL)`,
    )
    .run(id, text, category, createdAt, expiresAt);
  return id;
}

function addLink(db: InstanceType<typeof FactsDB>, sourceId: string, targetId: string, linkType = "RELATED_TO") {
  const raw = db.getRawDb();
  raw
    .prepare(
      `INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at)
       VALUES (?, ?, ?, ?, 1.0, ?)`,
    )
    .run(`link-${Math.random().toString(36).slice(2)}`, sourceId, targetId, linkType, Math.floor(Date.now() / 1000));
}

describe("collectGraphPayload (#2126)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "graph-test-"));
    factsDb = makeDb(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns non-zero edges by default when the recent-node sample itself has none, by pulling in linked neighbors", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // "a" is recent (in the initial recency-ordered sample) but its only link is to "b", which is
    // MUCH older and would never appear in a plain "recent N" sample on its own — exactly the
    // append-heavy-corpus shape from #2126 where recent facts are rarely linked to each other, but
    // are linked to older facts. Filler facts crowd out "b" from the naive recency sample.
    const b = storeFact(factsDb, { text: "old linked fact B", createdAt: nowSec - 100_000 });
    const a = storeFact(factsDb, { text: "recent linked fact A", createdAt: nowSec });
    addLink(factsDb, a, b, "RELATED_TO");
    // maxNodes is clamped to a floor of 20 (pre-existing), and the recency seed query only
    // consumes 60% of that budget (#2126) — enough filler facts must exist to actually saturate
    // the seed query, or "b" would already be swept in by the (unreserved) recency LIMIT alone.
    for (let i = 1; i <= 20; i++) {
      storeFact(factsDb, { text: `unrelated recent fact ${i}`, createdAt: nowSec - i });
    }

    const payload = collectGraphPayload(factsDb, 365, 20);

    expect(payload.edges.length).toBeGreaterThan(0);
    expect(payload.edges.some((e) => e.linkType === "RELATED_TO")).toBe(true);
    expect(payload.edges.every((e) => e.layer === "explicit")).toBe(true);
    expect(payload.coverage.selectedEdges).toBe(payload.edges.length);
    expect(payload.coverage.totalExplicitLinks).toBeGreaterThanOrEqual(1);
  });

  it("mode=recent preserves the original recency-only node sample (no neighbor expansion)", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const a = storeFact(factsDb, { text: "old linked fact A", createdAt: nowSec - 1000 });
    const b = storeFact(factsDb, { text: "old linked fact B", createdAt: nowSec - 999 });
    addLink(factsDb, a, b, "RELATED_TO");
    // maxNodes is clamped to a floor of 20 by design (pre-existing), so enough unrelated recent
    // facts must exist to actually exercise the recency LIMIT and crowd "a"/"b" out.
    for (let i = 0; i < 25; i++) {
      storeFact(factsDb, { text: `unrelated recent fact ${i}`, createdAt: nowSec - i });
    }

    const payload = collectGraphPayload(factsDb, 30, 20, { mode: "recent" });

    expect(payload.nodes).toHaveLength(20);
    expect(payload.nodes.some((n) => n.id === a || n.id === b)).toBe(false);
    expect(payload.edges).toHaveLength(0);
  });

  it("orphanNodesInView counts nodes with no edge among the returned edges", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    storeFact(factsDb, { text: "lone fact", createdAt: nowSec });
    const payload = collectGraphPayload(factsDb, 30, 400);
    expect(payload.coverage.orphanNodesInView).toBe(payload.nodes.length);
  });

  it("excludes an expired-but-not-superseded neighbor from the connected-mode expansion (#2134 QA follow-up)", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const seed = storeFact(factsDb, { text: "recent seed fact", createdAt: nowSec });
    const expiredNeighbor = storeFact(factsDb, {
      text: "expired neighbor",
      createdAt: nowSec - 500_000,
      expiresAt: nowSec - 1,
    });
    addLink(factsDb, seed, expiredNeighbor, "RELATED_TO");

    const payload = collectGraphPayload(factsDb, 365, 20);

    expect(payload.nodes.some((n) => n.id === expiredNeighbor)).toBe(false);
    expect(payload.edges.some((e) => e.source === expiredNeighbor || e.target === expiredNeighbor)).toBe(false);
  });

  it("defaults connected-mode hubDegreeCap to 500 (not an unconfigurable stricter value) and honors an explicit override", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const hub = storeFact(factsDb, { text: "hub fact", createdAt: nowSec });
    // 60 neighbors comfortably exceeds a stricter cap (e.g. 50) but stays well under the 500
    // codebase-wide default, so this only passes if the default is actually 500.
    for (let i = 0; i < 60; i++) {
      const neighbor = storeFact(factsDb, { text: `neighbor ${i}`, createdAt: nowSec - i });
      addLink(factsDb, hub, neighbor, "RELATED_TO");
    }

    const defaultPayload = collectGraphPayload(factsDb, 365, 400);
    expect(defaultPayload.coverage.hubsSkipped).toBe(0);

    const strictPayload = collectGraphPayload(factsDb, 365, 400, { hubDegreeCap: 5 });
    expect(strictPayload.coverage.hubsSkipped).toBeGreaterThan(0);
  });
});

describe("FactsDB.getEdgesForFactIds hub-starvation regression (#2134 QA follow-up)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "graph-edges-test-"));
    factsDb = makeDb(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not let a hub fact's out-of-scope links exhaust the SQL-level row cap before the in-scope filter runs", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const hub = storeFact(factsDb, { text: "hub fact", createdAt: nowSec });
    const a = storeFact(factsDb, { text: "in-scope fact A", createdAt: nowSec });
    const b = storeFact(factsDb, { text: "in-scope fact B", createdAt: nowSec });
    // The hub is linked to many facts OUTSIDE the requested id set — these must not starve the
    // genuinely in-scope hub<->a and hub<->b edges out of a small SQL-level result cap.
    for (let i = 0; i < 50; i++) {
      const outOfScope = storeFact(factsDb, { text: `out-of-scope neighbor ${i}`, createdAt: nowSec });
      addLink(factsDb, hub, outOfScope, "RELATED_TO");
    }
    addLink(factsDb, hub, a, "RELATED_TO");
    addLink(factsDb, hub, b, "RELATED_TO");

    const edges = factsDb.getEdgesForFactIds([hub, a, b], 5000);

    expect(edges.some((e) => e.source === hub && e.target === a)).toBe(true);
    expect(edges.some((e) => e.source === hub && e.target === b)).toBe(true);
    expect(edges).toHaveLength(2);
  });
});
