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
  overrides: { text?: string; category?: string; createdAt?: number } = {},
): string {
  const raw = db.getRawDb();
  const id = `test-${Math.random().toString(36).slice(2)}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const { text = "test fact", category = "fact", createdAt = nowSec } = overrides;
  raw
    .prepare(
      `INSERT INTO facts (id, text, category, importance, source, created_at, decay_class, confidence, tier, valid_until, expires_at, superseded_at)
     VALUES (?, ?, ?, 0.7, 'conversation', ?, 'stable', 1.0, 'warm', NULL, NULL, NULL)`,
    )
    .run(id, text, category, createdAt);
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
});
