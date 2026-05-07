// @ts-nocheck
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FactsDB } from "../backends/facts-db.js";
import { findEventHubRepairCandidates, repairEventHubs } from "../services/event-hub-repair.js";

let tmpDir: string;
let db: FactsDB;

function raw() {
  return db.getRawDb();
}

function storeFact(text: string, overrides = {}) {
  return db.store({
    text,
    category: "fact",
    importance: 0.5,
    entity: null,
    key: null,
    value: null,
    source: "conversation",
    ...overrides,
  });
}

function derivedCount(sourceFactId: string): number {
  const row = raw()
    .prepare("SELECT COUNT(*) AS count FROM memory_links WHERE source_fact_id = ? AND link_type = 'DERIVED_FROM'")
    .get(sourceFactId) as { count: number };
  return row.count;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "event-hub-repair-test-"));
  db = new FactsDB(join(tmpDir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("event-hub repair", () => {
  it("dry-runs without mutating candidate hubs", () => {
    const hub = storeFact("[consolidated from 4 events] session_start; session_end; session_start", {
      source: "dream-cycle",
      tags: ["dream-cycle", "consolidated"],
    });
    for (let i = 0; i < 4; i++) {
      const src = storeFact(i % 2 === 0 ? `session_start#${i}` : `session_end#${i}`, { source: "dream-cycle" });
      raw()
        .prepare(
          "INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at) VALUES (?, ?, ?, 'DERIVED_FROM', 1, strftime('%s','now'))",
        )
        .run(`derived-${src.id}`, hub.id, src.id);
    }

    const report = repairEventHubs(raw(), { threshold: 3, apply: false });

    expect(report.apply).toBe(false);
    expect(report.candidates).toHaveLength(1);
    expect(report.deletedLinks).toBe(0);
    expect(derivedCount(hub.id)).toBe(4);
    expect(db.getById(hub.id)?.provenanceJson).toBeNull();
  });

  it("applies provenance migration and removes only eligible hub DERIVED_FROM links", () => {
    const hub = storeFact("[consolidated from 4 events] session_start; session_end; session_start", {
      source: "dream-cycle",
      tags: ["dream-cycle", "consolidated"],
      provenanceJson: JSON.stringify({ method: "dream-cycle", sourceFactIds: ["already-present"] }),
    });
    const semantic = storeFact("Useful semantic neighbour");
    const smallDerived = storeFact("Small derived source");
    const lowVolume = storeFact("[consolidated from 2 events] session_start", { source: "dream-cycle" });

    const sourceIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const src = storeFact(i % 2 === 0 ? `session_start#${i}` : `session_end#${i}`, { source: "dream-cycle" });
      sourceIds.push(src.id);
      raw()
        .prepare(
          "INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at) VALUES (?, ?, ?, 'DERIVED_FROM', 1, strftime('%s','now'))",
        )
        .run(`derived-${src.id}`, hub.id, src.id);
    }
    db.createLink(hub.id, semantic.id, "RELATED_TO", 1);
    raw()
      .prepare(
        "INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at) VALUES (?, ?, ?, 'DERIVED_FROM', 1, strftime('%s','now'))",
      )
      .run("derived-low-volume", lowVolume.id, smallDerived.id);

    const report = repairEventHubs(raw(), { threshold: 3, apply: true });

    expect(report.apply).toBe(true);
    expect(report.migratedFacts).toBe(1);
    expect(report.deletedLinks).toBe(4);
    expect(report.after?.maxOutboundDerivedFrom).toBeLessThanOrEqual(3);
    expect(derivedCount(hub.id)).toBe(0);
    expect(derivedCount(lowVolume.id)).toBe(1);
    expect(
      db.getLinksFrom(hub.id).some((link) => link.targetFactId === semantic.id && link.linkType === "RELATED_TO"),
    ).toBe(true);

    const provenance = JSON.parse(db.getById(hub.id)?.provenanceJson ?? "{}");
    expect(provenance.method).toBe("dream-cycle");
    expect(provenance.legacyDerivedFromFactIds).toEqual(expect.arrayContaining(["already-present", ...sourceIds]));
    expect(provenance.repairs[0].method).toBe("collapse-event-hubs");
  });

  it("does not select unrelated high-degree DERIVED_FROM hubs", () => {
    const hub = storeFact("[consolidated from 4 events] important deployment decisions", { source: "manual-import" });
    for (let i = 0; i < 4; i++) {
      const src = storeFact(`real source ${i}`, { source: "manual-import" });
      raw()
        .prepare(
          "INSERT INTO memory_links (id, source_fact_id, target_fact_id, link_type, strength, created_at) VALUES (?, ?, ?, 'DERIVED_FROM', 1, strftime('%s','now'))",
        )
        .run(`derived-${src.id}`, hub.id, src.id);
    }

    expect(findEventHubRepairCandidates(raw(), 3)).toHaveLength(0);
    const report = repairEventHubs(raw(), { threshold: 3, apply: true });
    expect(report.deletedLinks).toBe(0);
    expect(derivedCount(hub.id)).toBe(4);
  });
});
