/**
 * Pinning promises "stays central and decay-frozen" — but the decay/prune SQL only guarded on
 * decay_freeze_until + verified_facts, so a user-pinned fact in a TTL'd decay class was still
 * hard-deleted at expiry (and its confidence still halved past 75% TTL). Every deletion/halving
 * filter — including the vector-cleanup previews that must mirror them — now exempts pinned facts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactsDB } from "../backends/facts-db.js";

let dir: string;
let db: FactsDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hybrid-pinned-prune-"));
  db = new FactsDB(join(dir, "facts.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function storeFact(text: string): string {
  return db.store({
    text,
    entity: null,
    key: null,
    value: null,
    category: "other",
    importance: 0.5,
    source: "test",
    tags: [],
  }).id;
}

/** Force a fact into the "expired an hour ago" state. */
function forceExpire(id: string): void {
  const past = Math.floor(Date.now() / 1000) - 3600;
  db.getRawDb().prepare("UPDATE facts SET expires_at = ? WHERE id = ?").run(past, id);
}

function pin(id: string): void {
  db.getRawDb()
    .prepare("UPDATE facts SET pinned_at = ?, pinned_reason = 'test' WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), id);
}

function exists(id: string): boolean {
  return db.getRawDb().prepare("SELECT 1 FROM facts WHERE id = ?").get(id) != null;
}

describe("pinned facts survive decay & prune", () => {
  it("pruneExpired deletes an expired unpinned fact but never a pinned one", () => {
    const pinned = storeFact("pinned but expired");
    const unpinned = storeFact("unpinned and expired");
    forceExpire(pinned);
    forceExpire(unpinned);
    pin(pinned);

    // The vector-cleanup preview must mirror the delete filter exactly.
    expect(db.listExpiredFactIdsPendingPrune()).toEqual([unpinned]);

    const pruned = db.pruneExpired();
    expect(pruned).toBe(1);
    expect(exists(pinned)).toBe(true);
    expect(exists(unpinned)).toBe(false);
  });

  it("unpinning restores normal expiry deletion", () => {
    const id = storeFact("pinned then unpinned");
    forceExpire(id);
    pin(id);
    expect(db.pruneExpired()).toBe(0);

    db.getRawDb().prepare("UPDATE facts SET pinned_at = NULL WHERE id = ?").run(id);
    expect(db.pruneExpired()).toBe(1);
    expect(exists(id)).toBe(false);
  });

  it("decayConfidence never halves nor floor-deletes a pinned fact", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const pinnedDecaying = storeFact("pinned deep into its TTL window");
    const unpinnedDecaying = storeFact("unpinned deep into its TTL window");
    // Put both >75% through their confirm→expiry window with confidence above the floor.
    for (const id of [pinnedDecaying, unpinnedDecaying]) {
      db.getRawDb()
        .prepare("UPDATE facts SET last_confirmed_at = ?, expires_at = ?, confidence = 0.4 WHERE id = ?")
        .run(nowSec - 90, nowSec + 10, id);
    }
    pin(pinnedDecaying);

    db.decayConfidence(nowSec);

    const conf = (id: string) =>
      (db.getRawDb().prepare("SELECT confidence FROM facts WHERE id = ?").get(id) as { confidence: number }).confidence;
    expect(conf(pinnedDecaying)).toBeCloseTo(0.4);
    expect(conf(unpinnedDecaying)).toBeCloseTo(0.2);

    // Floor-delete: a pinned fact below the 0.1 floor still survives (and stays out of previews).
    const pinnedLow = storeFact("pinned with rock-bottom confidence");
    pin(pinnedLow);
    db.getRawDb().prepare("UPDATE facts SET confidence = 0.05 WHERE id = ?").run(pinnedLow);
    expect(db.listFactIdsToBeDeletedByDecayRun(nowSec)).not.toContain(pinnedLow);
    db.decayConfidence(nowSec);
    expect(exists(pinnedLow)).toBe(true);
  });
});
