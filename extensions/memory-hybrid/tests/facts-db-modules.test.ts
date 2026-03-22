import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createLink, getConnectedFactIds, strengthenRelatedLinksBatch } from "../backends/facts-db/links.js";
import { appendReinforcementQuote } from "../backends/facts-db/reinforcement.js";
import { getScanCursor, migrateScanCursorsTable, updateScanCursor } from "../backends/facts-db/scan-cursors.js";

describe("facts-db scan cursor module", () => {
  let db: DatabaseSync;

  afterEach(() => {
    db?.close();
  });

  it("keeps last_session_ts unchanged when sessionsProcessed is zero", () => {
    db = new DatabaseSync(":memory:");
    migrateScanCursorsTable(db);

    updateScanCursor(db, "self-correction", 1000, 4, 2000);
    updateScanCursor(db, "self-correction", 9999, 0, 3000);

    expect(getScanCursor(db, "self-correction")).toEqual({
      lastSessionTs: 1000,
      lastRunAt: 3000,
      sessionsProcessed: 4,
    });
  });
});

describe("facts-db reinforcement module", () => {
  it("keeps only the 10 newest reinforcement quotes", () => {
    let quotes: string | null = null;
    for (let i = 0; i < 12; i++) {
      quotes = appendReinforcementQuote(quotes, `quote-${i}`);
    }

    expect(JSON.parse(quotes)).toEqual([
      "quote-2",
      "quote-3",
      "quote-4",
      "quote-5",
      "quote-6",
      "quote-7",
      "quote-8",
      "quote-9",
      "quote-10",
      "quote-11",
    ]);
  });
});

describe("facts-db links module", () => {
  let db: DatabaseSync;

  afterEach(() => {
    db?.close();
  });

  it("updates RELATED_TO strength in-place during batch strengthening", () => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE memory_links (
        id TEXT PRIMARY KEY,
        source_fact_id TEXT NOT NULL,
        target_fact_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        strength REAL NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    const id = createLink(db, "a", "b", "RELATED_TO", 0.2);
    strengthenRelatedLinksBatch(db, [["a", "b"]], 0.3);

    const rows = db
      .prepare(`SELECT id, strength FROM memory_links WHERE source_fact_id = 'a' AND target_fact_id = 'b'`)
      .all() as Array<{ id: string; strength: number }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].strength).toBeCloseTo(0.5, 5);
  });

  it("excludes CONTRADICTS links from connectivity traversal", () => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE memory_links (
        id TEXT PRIMARY KEY,
        source_fact_id TEXT NOT NULL,
        target_fact_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        strength REAL NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    createLink(db, "a", "b", "RELATED_TO", 1);
    createLink(db, "b", "c", "CONTRADICTS", 1);

    const ids = getConnectedFactIds(db, ["a"], 3).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});
