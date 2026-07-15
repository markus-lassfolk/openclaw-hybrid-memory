/**
 * Tests for Issue #2127 — memory graph under-linked (~88% of active facts had no explicit
 * graph link). enrichOrphanFactLinksBySharedSourceEvent promotes an already-computed
 * deterministic signal (shared facts.provenance_json.sourceEventIds) into explicit RELATED_TO
 * links, without inventing any new similarity judgment.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testing } from "../index.js";
import { enrichOrphanFactLinksBySharedSourceEvent } from "../services/graph-link-enrichment.js";

const { FactsDB } = _testing;

function makeDb(tmpDir: string): InstanceType<typeof FactsDB> {
  return new FactsDB(join(tmpDir, "facts.db"));
}

function storeFactWithProvenance(
  db: InstanceType<typeof FactsDB>,
  overrides: { text?: string; sourceEventIds?: string[]; createdAt?: number } = {},
): string {
  const raw = db.getRawDb();
  const id = `test-${Math.random().toString(36).slice(2)}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const { text = "test fact", sourceEventIds, createdAt = nowSec } = overrides;
  const provenanceJson = sourceEventIds ? JSON.stringify({ sourceEventIds }) : null;
  raw
    .prepare(
      `INSERT INTO facts (id, text, category, importance, source, created_at, decay_class, confidence, tier, valid_until, expires_at, superseded_at, provenance_json)
     VALUES (?, ?, 'fact', 0.7, 'conversation', ?, 'stable', 1.0, 'warm', NULL, NULL, NULL, ?)`,
    )
    .run(id, text, createdAt, provenanceJson);
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

describe("enrichOrphanFactLinksBySharedSourceEvent (#2127)", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "graph-enrich-test-"));
    factsDb = makeDb(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is a dry-run by default: reports what it would link without mutating the store", () => {
    const a = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"] });
    const b = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"] });

    const result = enrichOrphanFactLinksBySharedSourceEvent(factsDb);

    expect(result.dryRun).toBe(true);
    expect(result.linksCreated).toBe(1);
    expect(result.createdLinks).toEqual([{ sourceFactId: a, targetFactId: b, sharedSourceEventId: "evt-1" }]);
    expect(factsDb.getEdgesForFactIds([a, b], 10)).toHaveLength(0);
  });

  it("apply:true actually creates the link", () => {
    const a = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"] });
    const b = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"] });

    const result = enrichOrphanFactLinksBySharedSourceEvent(factsDb, { dryRun: false });

    expect(result.linksCreated).toBe(1);
    const edges = factsDb.getEdgesForFactIds([a, b], 10);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.linkType).toBe("RELATED_TO");
  });

  it("links every fact in a shared-event group via a star topology anchored on the oldest fact", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const anchor = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"], createdAt: nowSec - 10 });
    const b = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"], createdAt: nowSec - 5 });
    const c = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"], createdAt: nowSec });

    const result = enrichOrphanFactLinksBySharedSourceEvent(factsDb, { dryRun: false });

    expect(result.linksCreated).toBe(2);
    expect(factsDb.getEdgesForFactIds([anchor, b], 10)).toHaveLength(1);
    expect(factsDb.getEdgesForFactIds([anchor, c], 10)).toHaveLength(1);
  });

  it("never touches a fact that already has any explicit link — it is excluded from the orphan scan up front", () => {
    const a = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"] });
    const b = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"] });
    addLink(factsDb, a, b, "CONTRADICTS");

    const result = enrichOrphanFactLinksBySharedSourceEvent(factsDb, { dryRun: false });

    expect(result.factsScanned).toBe(0);
    expect(result.linksCreated).toBe(0);
    // The existing CONTRADICTS link must survive untouched — no extra RELATED_TO added.
    const edges = factsDb.getEdgesForFactIds([a, b], 10);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.linkType).toBe("CONTRADICTS");
  });

  it("counts a pair only once even when the same two facts share multiple source events", () => {
    const a = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1", "evt-2"] });
    const b = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1", "evt-2"] });

    const result = enrichOrphanFactLinksBySharedSourceEvent(factsDb, { dryRun: false });

    expect(result.linksCreated).toBe(1);
    expect(factsDb.getEdgesForFactIds([a, b], 10)).toHaveLength(1);
  });

  it("does not touch a fact that already has any explicit link (not orphaned)", () => {
    const linked = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"] });
    const other = storeFactWithProvenance(factsDb);
    addLink(factsDb, linked, other);
    const sharesEvent = storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"] });

    const result = enrichOrphanFactLinksBySharedSourceEvent(factsDb, { dryRun: false });

    // "linked" is excluded from the orphan scan entirely, so it never gets grouped with
    // "sharesEvent" even though they nominally share a source event.
    expect(result.linksCreated).toBe(0);
    expect(factsDb.getEdgesForFactIds([linked, sharesEvent], 10)).toHaveLength(0);
  });

  it("does not link facts with no shared source event", () => {
    storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-1"] });
    storeFactWithProvenance(factsDb, { sourceEventIds: ["evt-2"] });

    const result = enrichOrphanFactLinksBySharedSourceEvent(factsDb, { dryRun: false });

    expect(result.linksCreated).toBe(0);
    expect(result.sourceEventGroups).toBe(0);
  });

  it("ignores facts with no provenance at all", () => {
    storeFactWithProvenance(factsDb);
    storeFactWithProvenance(factsDb);

    const result = enrichOrphanFactLinksBySharedSourceEvent(factsDb, { dryRun: false });

    expect(result.factsScanned).toBe(0);
    expect(result.linksCreated).toBe(0);
  });
});
