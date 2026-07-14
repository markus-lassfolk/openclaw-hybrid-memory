/**
 * storeFact's dedupe check (applyDedupe) ran once, entirely before the INSERT's own transaction
 * began. Two concurrent storeFact() calls for identical text could both run that check, both see
 * "no duplicate," and both proceed to insert — producing duplicate rows for the same fact. The
 * fix re-runs the dedupe check a second time once the write-lock (BEGIN IMMEDIATE) is held, so
 * the final decision is atomic with the INSERT.
 *
 * This test simulates the race deterministically: it mocks the FIRST applyDedupe() call to
 * report "no duplicate" (as if it ran before a concurrent writer's insert became visible), while
 * a real duplicate-hash fact is already present in the table by the time the transaction's
 * recheck runs. If the fix is absent, storeFact would insert a second row with the same
 * normalized_hash; with the fix, the recheck catches the now-visible duplicate and no second row
 * is created.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _testing } from "../index.js";
import * as dedupePolicy from "../services/dedupe-policy.js";

const { FactsDB } = _testing;

describe("storeFact dedupe check-then-insert race", () => {
  let tmpDir: string;
  let factsDb: InstanceType<typeof FactsDB>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hm-store-dedupe-race-"));
    factsDb = new FactsDB(join(tmpDir, "facts.db"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    factsDb?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not insert a duplicate row when a concurrent writer's fact becomes visible between the first dedupe check and the write lock", () => {
    const text = "Race-condition regression fact — identical text stored twice near-simultaneously";
    const applyDedupeSpy = vi.spyOn(dedupePolicy, "applyDedupe");

    // The "concurrent writer" — stored first, with the real (unmocked) dedupe check, so its
    // insert is now visible in the table exactly as it would be once a racing storeFact() call's
    // transaction commits.
    const winner = factsDb.storeWithResult({
      text,
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    // Now simulate the race for the SECOND call: its first applyDedupe() check is mocked to
    // report "no duplicate" — as if it had run a moment before `winner`'s insert became visible.
    // The recheck inside the transaction (the second applyDedupe() call this store triggers)
    // uses the real implementation and must now see `winner` and back off instead of inserting.
    applyDedupeSpy.mockClear();
    applyDedupeSpy.mockImplementationOnce(() => ({ action: "store" }));
    const result = factsDb.storeWithResult({
      text,
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });

    expect(applyDedupeSpy).toHaveBeenCalledTimes(2);
    expect(result.newlyStored).toBe(false);
    expect(result.entry.id).toBe(winner.entry.id);

    const rows = factsDb.getRawDb().prepare("SELECT COUNT(*) AS c FROM facts WHERE text = ?").get(text) as {
      c: number;
    };
    expect(rows.c).toBe(1);
  });

  it("still stores normally when no race occurs (both dedupe checks agree)", () => {
    const result = factsDb.storeWithResult({
      text: "Ordinary fact, no race",
      category: "fact",
      importance: 0.7,
      entity: null,
      key: null,
      value: null,
      source: "test",
    });
    expect(result.newlyStored).toBe(true);
    const rows = factsDb.getRawDb().prepare("SELECT COUNT(*) AS c FROM facts").get() as { c: number };
    expect(rows.c).toBe(1);
  });
});
